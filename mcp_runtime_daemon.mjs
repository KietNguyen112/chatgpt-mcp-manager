import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { RUNTIME_ENDPOINT } from "./mcp_runtime_common.mjs";
import { getAgentState, updatePlan, remember, recall, clearAgentState } from "./mcp_agent_state.mjs";

const MAX_OUTPUT_LINES = 2000;
const FINISHED_RETENTION_MS = Number(process.env.M1_RUNTIME_FINISHED_RETENTION_MS || 30 * 60 * 1000);
const TERMINAL_IDLE_MS = Number(process.env.M1_RUNTIME_TERMINAL_IDLE_MS || 24 * 60 * 60 * 1000);
const DAEMON_IDLE_MS = Number(process.env.M1_RUNTIME_DAEMON_IDLE_MS || 30 * 60 * 1000);

const processes = new Map();
const terminals = new Map();
const workspaceCwds = new Map();
let nextProcessId = 1;
let nextTerminalId = 1;
let lastRequestAt = Date.now();
let shuttingDown = false;

function appendChunk(entry, chunk, streamName) {
  const key = streamName === "stderr" ? "stderrPartial" : "stdoutPartial";
  const combined = (entry[key] || "") + chunk.toString();
  const parts = combined.split(/\r?\n/);
  entry[key] = parts.pop() || "";
  for (const line of parts) {
    if (!line) continue;
    entry.output.push(line);
    if (entry.output.length > MAX_OUTPUT_LINES) entry.output.shift();
  }
}

function flushPartials(entry) {
  for (const key of ["stdoutPartial", "stderrPartial"]) {
    if (entry[key]) {
      entry.output.push(entry[key]);
      entry[key] = "";
      if (entry.output.length > MAX_OUTPUT_LINES) entry.output.shift();
    }
  }
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { windowsHide: true });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {}
}

function requireOwner(owner) {
  if (!owner) throw new Error("runtime owner is required");
}

function getOwned(map, id, owner, label) {
  requireOwner(owner);
  if (!id) throw new Error("id parameter is required");
  const entry = map.get(String(id));
  if (!entry || entry.owner !== owner) throw new Error(`No ${label} with id ${id}`);
  entry.lastActivity = Date.now();
  return entry;
}

function shellForCommand(command, interactive = false, requestedShell = "") {
  if (interactive) {
    const shell = requestedShell || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
    const args = process.platform === "win32" && shell.toLowerCase().includes("powershell")
      ? ["-NoLogo", "-NoExit", "-Command", "-"]
      : (process.platform === "win32" ? [] : ["-i"]);
    return { shell, args };
  }

  if (process.platform === "win32") {
    return { shell: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  return { shell: "/bin/sh", args: ["-c", command] };
}

function startBackground(owner, { command, cwd }) {
  requireOwner(owner);
  if (!command || !String(command).trim()) throw new Error("command parameter is required");
  if (!cwd) throw new Error("cwd parameter is required");

  const { shell, args } = shellForCommand(command, false);
  const id = String(nextProcessId++);
  const proc = spawn(shell, args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const entry = {
    id,
    owner,
    process: proc,
    command,
    cwd,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    output: [],
    stdoutPartial: "",
    stderrPartial: "",
    exitCode: null,
    exited: false,
    finishedAt: null,
  };

  proc.stdout.on("data", (chunk) => appendChunk(entry, chunk, "stdout"));
  proc.stderr.on("data", (chunk) => appendChunk(entry, chunk, "stderr"));
  proc.on("exit", (code) => {
    flushPartials(entry);
    entry.exited = true;
    entry.exitCode = code;
    entry.finishedAt = Date.now();
    entry.lastActivity = Date.now();
  });
  proc.on("error", (error) => {
    entry.output.push(`[spawn error] ${error.message}`);
    entry.exited = true;
    entry.exitCode = -1;
    entry.finishedAt = Date.now();
  });

  processes.set(id, entry);
  return `Started background process ${id} (pid ${proc.pid}): ${command}\nUse read_process_output with id="${id}" to check progress.`;
}

function readBackground(owner, { id, clear = false }) {
  const entry = getOwned(processes, id, owner, "background process");
  flushPartials(entry);
  const status = entry.exited ? `EXITED (code ${entry.exitCode})` : "RUNNING";
  const text = entry.output.join("\n") || "(no output yet)";
  const header = `Status: ${status}\nCommand: ${entry.command}\nCwd: ${entry.cwd}\n\n`;
  if (clear) entry.output = [];
  return header + text;
}

function inputBackground(owner, { id, text = "" }) {
  const entry = getOwned(processes, id, owner, "background process");
  if (entry.exited) throw new Error(`Process ${id} has already exited (code ${entry.exitCode}).`);
  entry.process.stdin.write(`${text}\n`);
  return `Sent input to background process ${id}.`;
}

async function waitBackground(owner, { id, timeoutSeconds = 60 }) {
  const entry = getOwned(processes, id, owner, "background process");
  flushPartials(entry);
  if (entry.exited) {
    return `Process ${id} is already exited (code ${entry.exitCode}).\n\nOutput:\n${entry.output.join("\n")}`;
  }

  const timeoutMs = Math.min(Math.max(1, Number(timeoutSeconds) || 60), 300) * 1000;
  const deadline = Date.now() + timeoutMs;
  while (!entry.exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  flushPartials(entry);
  if (entry.exited) {
    return `Process ${id} Status: EXITED (code ${entry.exitCode})\n\nOutput:\n${entry.output.join("\n")}`;
  }
  return `Process ${id} Status: TIMED OUT (${timeoutSeconds}s - still running)\n\nOutput:\n${entry.output.join("\n")}`;
}

function stopBackground(owner, { id }) {
  const entry = getOwned(processes, id, owner, "background process");
  if (entry.exited) return `Process ${id} already exited (code ${entry.exitCode}).`;
  killTree(entry.process);
  entry.lastActivity = Date.now();
  return `Stopped process ${id}.`;
}

function listBackground(owner) {
  requireOwner(owner);
  const lines = [];
  for (const [id, entry] of processes) {
    if (entry.owner !== owner) continue;
    const status = entry.exited ? `exited(${entry.exitCode})` : "running";
    lines.push(`${id}: [${status}] ${entry.command}  (cwd: ${entry.cwd})`);
  }
  return lines.length ? lines.join("\n") : "No background processes.";
}

function createTerminal(owner, { cwd, shell: requestedShell = "" }) {
  requireOwner(owner);
  if (!cwd) throw new Error("cwd parameter is required");
  const { shell, args } = shellForCommand("", true, requestedShell);
  const id = String(nextTerminalId++);
  const proc = spawn(shell, args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const entry = {
    id,
    owner,
    process: proc,
    shell,
    cwd,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    output: [],
    stdoutPartial: "",
    stderrPartial: "",
    exited: false,
    exitCode: null,
    finishedAt: null,
    commandQueue: Promise.resolve(),
  };

  proc.stdout.on("data", (chunk) => appendChunk(entry, chunk, "stdout"));
  proc.stderr.on("data", (chunk) => appendChunk(entry, chunk, "stderr"));
  proc.on("exit", (code) => {
    flushPartials(entry);
    entry.exited = true;
    entry.exitCode = code;
    entry.finishedAt = Date.now();
    entry.lastActivity = Date.now();
  });
  proc.on("error", (error) => {
    entry.output.push(`[spawn error] ${error.message}`);
    entry.exited = true;
    entry.exitCode = -1;
    entry.finishedAt = Date.now();
  });

  terminals.set(id, entry);
  return `Created terminal session ${id} (${shell}) in ${cwd}.\nUse exec_terminal(id="${id}", command="...") to run commands.`;
}

function executeTerminalCommand(entry, id, command, timeoutSeconds) {
  if (entry.exited) throw new Error(`Terminal ${id} has already exited (code ${entry.exitCode})`);
  const initialLen = entry.output.length;
  const delimiter = `__M1_CMD_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 9)}__`;
  const isPs = entry.shell.toLowerCase().includes("powershell");
  const cmdWithDelimiter = isPs
    ? `${String(command).trim()}\r\nWrite-Output "${delimiter} $LASTEXITCODE"\r\n`
    : `${String(command).trim()}\necho "${delimiter} $?"\n`;
  const timeoutMs = Math.min(Math.max(1, Number(timeoutSeconds) || 60), 300) * 1000;
  const startTime = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearInterval(checkInterval);
      clearTimeout(timer);
      entry.lastActivity = Date.now();
      resolve(text);
    };

    const checkInterval = setInterval(() => {
      flushPartials(entry);
      if (entry.exited) {
        finish(`Terminal ${id} exited (code ${entry.exitCode}).\n\nOutput:\n${entry.output.slice(initialLen).join("\n")}`);
        return;
      }
      const recent = entry.output.slice(initialLen);
      const foundIdx = recent.findIndex((line) => line.includes(delimiter));
      if (foundIdx < 0) return;
      const outputLines = recent.slice(0, foundIdx);
      const doneLine = recent[foundIdx];
      const matchCode = doneLine.match(new RegExp(`${delimiter}\\s+(-?\\d+)`));
      const exitCode = matchCode ? Number.parseInt(matchCode[1], 10) : 0;
      const cleanOutput = outputLines
        .filter((line) => !line.includes(delimiter) && !line.includes(String(command).trim()))
        .join("\n")
        .trim();
      finish(`Exit Code: ${exitCode} (${((Date.now() - startTime) / 1000).toFixed(2)}s)\n\n${cleanOutput || "(Command completed with no output)"}`);
    }, 40);

    const timer = setTimeout(() => {
      flushPartials(entry);
      const timeoutOutput = entry.output.slice(initialLen).join("\n").trim();
      finish(`[TIMEOUT after ${timeoutSeconds}s in terminal ${id}]\nAccumulated output:\n${timeoutOutput || "(no output)"}`);
    }, timeoutMs);

    entry.process.stdin.write(cmdWithDelimiter);
  });
}

async function execTerminal(owner, { id, command, timeoutSeconds = 60 }) {
  const entry = getOwned(terminals, id, owner, "active terminal session");
  if (!command || !String(command).trim()) throw new Error("command parameter is required");
  const run = () => executeTerminalCommand(entry, id, command, timeoutSeconds);
  entry.commandQueue = entry.commandQueue.then(run, run);
  return entry.commandQueue;
}

function readTerminal(owner, { id, clear = false }) {
  const entry = getOwned(terminals, id, owner, "terminal session");
  flushPartials(entry);
  const status = entry.exited ? `EXITED (code ${entry.exitCode})` : "RUNNING";
  const text = entry.output.join("\n") || "(no output yet)";
  const header = `Terminal ${id} (${entry.shell}) | Status: ${status} | Cwd: ${entry.cwd}\n\n`;
  if (clear) entry.output = [];
  return header + text;
}

function inputTerminal(owner, { id, text = "", sendEnter = true, sigint = false }) {
  const entry = getOwned(terminals, id, owner, "terminal session");
  if (entry.exited) throw new Error(`Terminal ${id} has exited.`);
  if (sigint) {
    entry.process.stdin.write("\x03");
    return `Sent Ctrl+C to terminal ${id}.`;
  }
  entry.process.stdin.write(`${text}${sendEnter ? "\n" : ""}`);
  return `Sent input to terminal ${id}.`;
}

function closeTerminal(owner, { id }) {
  const entry = getOwned(terminals, id, owner, "terminal session");
  if (!entry.exited) killTree(entry.process);
  terminals.delete(String(id));
  return `Closed terminal session ${id}.`;
}

function listTerminals(owner) {
  requireOwner(owner);
  const lines = [];
  for (const [id, entry] of terminals) {
    if (entry.owner !== owner) continue;
    const status = entry.exited ? `exited(${entry.exitCode})` : "running";
    const duration = ((Date.now() - entry.startedAt) / 1000).toFixed(0);
    lines.push(`Terminal ${id}: [${status}] shell=${entry.shell} cwd=${entry.cwd} (alive ${duration}s)`);
  }
  return lines.length ? lines.join("\n") : "No active terminal sessions.";
}

function cleanupOwner(owner) {
  requireOwner(owner);
  for (const [id, entry] of processes) {
    if (entry.owner !== owner) continue;
    if (!entry.exited) killTree(entry.process);
    processes.delete(id);
  }
  for (const [id, entry] of terminals) {
    if (entry.owner !== owner) continue;
    if (!entry.exited) killTree(entry.process);
    terminals.delete(id);
  }
  workspaceCwds.delete(owner);
  if (processes.size === 0 && terminals.size === 0 && workspaceCwds.size === 0) {
    setTimeout(() => {
      if (processes.size === 0 && terminals.size === 0 && workspaceCwds.size === 0) shutdownAll();
    }, 250).unref();
  }
  return `Cleaned runtime sessions for owner ${owner}.`;
}

async function dispatch(action, owner, params) {
  lastRequestAt = Date.now();
  switch (action) {
    case "runtime.ping": return { pid: process.pid, endpoint: RUNTIME_ENDPOINT };
    case "runtime.shutdown": {
      setTimeout(() => shutdownAll(), 20);
      return "M1 runtime daemon shutting down.";
    }
    case "runtime.cleanup_owner": return cleanupOwner(owner);
    case "workspace.get": {
      requireOwner(owner);
      return workspaceCwds.get(owner) || params.defaultCwd || "";
    }
    case "workspace.set": {
      requireOwner(owner);
      if (!params.cwd) throw new Error("cwd parameter is required");
      workspaceCwds.set(owner, params.cwd);
      return params.cwd;
    }
    case "agent.state": return JSON.stringify(getAgentState(owner), null, 2);
    case "agent.plan": return updatePlan(owner, params.steps || [], params.currentStep);
    case "agent.remember": return remember(owner, params.note, params.category);
    case "agent.recall": return recall(owner, params.query, params.category);
    case "agent.clear": return clearAgentState(owner);
    case "process.start": return startBackground(owner, params);
    case "process.read": return readBackground(owner, params);
    case "process.input": return inputBackground(owner, params);
    case "process.wait": return waitBackground(owner, params);
    case "process.stop": return stopBackground(owner, params);
    case "process.list": return listBackground(owner);
    case "terminal.create": return createTerminal(owner, params);
    case "terminal.exec": return execTerminal(owner, params);
    case "terminal.read": return readTerminal(owner, params);
    case "terminal.input": return inputTerminal(owner, params);
    case "terminal.close": return closeTerminal(owner, params);
    case "terminal.list": return listTerminals(owner);
    default: throw new Error(`Unknown M1 runtime action: ${action}`);
  }
}

function shutdownAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const entry of processes.values()) if (!entry.exited) killTree(entry.process);
  for (const entry of terminals.values()) if (!entry.exited) killTree(entry.process);
  processes.clear();
  terminals.clear();
  workspaceCwds.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

if (process.platform !== "win32" && fs.existsSync(RUNTIME_ENDPOINT)) {
  try { fs.unlinkSync(RUNTIME_ENDPOINT); } catch {}
}

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      void (async () => {
        try {
          const request = JSON.parse(line);
          const value = await dispatch(request.action, request.owner || "", request.params || {});
          socket.write(`${JSON.stringify({ ok: true, result: value })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ ok: false, error: error?.message || String(error) })}\n`);
        }
      })();
    }
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") process.exit(0);
  throw error;
});

server.listen(RUNTIME_ENDPOINT);

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of processes) {
    if (entry.exited && entry.finishedAt && now - entry.finishedAt > FINISHED_RETENTION_MS) processes.delete(id);
  }
  for (const [id, entry] of terminals) {
    if (entry.exited && entry.finishedAt && now - entry.finishedAt > FINISHED_RETENTION_MS) {
      terminals.delete(id);
      continue;
    }
    if (!entry.exited && now - entry.lastActivity > TERMINAL_IDLE_MS) {
      killTree(entry.process);
      terminals.delete(id);
    }
  }

  const hasRunning = [...processes.values()].some((entry) => !entry.exited)
    || [...terminals.values()].some((entry) => !entry.exited);
  if (!hasRunning && now - lastRequestAt > DAEMON_IDLE_MS) shutdownAll();
}, 60_000);
cleanupTimer.unref();

process.on("SIGTERM", shutdownAll);
process.on("SIGINT", shutdownAll);
