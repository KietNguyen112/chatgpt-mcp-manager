import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runtimeCall, makeRuntimeOwner } from "../mcp_runtime_client.mjs";

const bridgePath = path.resolve("./mcp_filesystem_bridge.mjs");
const testDir = path.resolve("./tests/scratch_runtime_persistence");
const nestedDir = path.join(testDir, "nested");
const owner = makeRuntimeOwner([testDir], false);

class BridgeClient {
  constructor() {
    this.proc = spawn("node", [bridgePath, testDir], { stdio: ["pipe", "pipe", "inherit"] });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let newline;
      while ((newline = this.buffer.indexOf("\\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            pending.resolve(message);
          }
        } catch {}
      }
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize() {
    await this.call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "runtime-persistence-test", version: "1" },
    });
    await this.call("notifications/initialized");
  }

  async tool(name, args = {}) {
    const response = await this.call("tools/call", { name, arguments: args });
    if (!response.result) throw new Error(JSON.stringify(response));
    if (response.result.isError) throw new Error(response.result.content?.[0]?.text || `${name} failed`);
    return response.result.content?.[0]?.text || "";
  }

  async stop() {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise((resolve) => this.proc.once("exit", resolve));
    this.proc.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
  }
}

function terminalCommands() {
  if (process.platform === "win32") {
    return {
      set: "$env:M1_BRIDGE_PERSIST = 'YES'; Write-Output 'SET_OK'",
      get: "Write-Output \"PERSISTED=$env:M1_BRIDGE_PERSIST\"",
    };
  }
  return {
    set: "export M1_BRIDGE_PERSIST=YES; echo SET_OK",
    get: "echo PERSISTED=$M1_BRIDGE_PERSIST",
  };
}

async function run() {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(nestedDir, { recursive: true });

  let bridgeA;
  let bridgeB;
  let bridgeC;
  let terminalId = null;

  try {
    console.log("=== Cross-bridge Runtime Persistence Regression Test ===");

    bridgeA = new BridgeClient();
    await bridgeA.initialize();
    await bridgeA.tool("set_workspace", { path: nestedDir });

    const term = await bridgeA.tool("create_terminal", {});
    terminalId = term.match(/session (\d+)/)?.[1];
    assert(terminalId, "create_terminal must return a session id");
    const commands = terminalCommands();
    const setResult = await bridgeA.tool("exec_terminal", { id: terminalId, command: commands.set });
    assert(setResult.includes("SET_OK"));

    console.log("1. Killing bridge A while terminal remains alive...");
    await bridgeA.stop();
    bridgeA = null;

    bridgeB = new BridgeClient();
    await bridgeB.initialize();

    const workspace = JSON.parse(await bridgeB.tool("get_workspace"));
    assert.strictEqual(workspace.active_cwd, nestedDir, "set_workspace must survive bridge recreation");

    const plan = JSON.parse(await bridgeB.tool("update_plan", { steps: [
      { id: 1, title: "Inspect repository", status: "completed" },
      { id: 2, title: "Implement change", status: "in_progress" },
      { id: 3, title: "Run verification", status: "pending" },
    ] }));
    assert.strictEqual(plan.plan[1].status, "in_progress", "agent plan must be persisted");
    const memoryMarker = `Runtime state marker ${Date.now()}`;
    await bridgeB.tool("remember", { category: "architecture", note: memoryMarker });
    console.log("2a. Agent plan + memory persisted.");

    const persistedState = JSON.parse(await bridgeB.tool("agent_state", {}));
    assert.strictEqual(persistedState.plan[1].title, "Implement change", "agent plan must survive bridge recreation");
    const recalled = JSON.parse(await bridgeB.tool("agent_recall", { query: memoryMarker }));
    assert.strictEqual(recalled.count, 1, "agent memory must survive bridge recreation");
    const persisted = await bridgeB.tool("exec_terminal", { id: terminalId, command: commands.get });
    assert(persisted.includes("PERSISTED=YES"), "terminal environment must survive bridge recreation");
    console.log("2. Terminal + workspace state survived bridge recreation.");

    const start = await bridgeB.tool("start_process", {
      path: testDir,
      command: "node -e \"setTimeout(() => console.log('BACKGROUND_SURVIVED'), 700); setTimeout(() => process.exit(0), 1000)\"",
    });
    const processId = start.match(/process (\d+)/)?.[1];
    assert(processId, "start_process must return a process id");

    console.log("3. Killing bridge B while background process remains alive...");
    await bridgeB.stop();
    bridgeB = null;

    bridgeC = new BridgeClient();
    await bridgeC.initialize();
    const waited = await bridgeC.tool("wait_process", { id: processId, timeout_seconds: 5 });
    assert(waited.includes("BACKGROUND_SURVIVED"), "background process must survive bridge recreation");
    console.log("4. Background process survived bridge recreation.");

    const terminalList = await bridgeC.tool("list_terminals");
    assert(terminalList.includes(`Terminal ${terminalId}`));
    await bridgeC.tool("close_terminal", { id: terminalId });
    terminalId = null;

    const cleanupTarget = await bridgeC.tool("start_process", {
      path: testDir,
      command: "node -e \"setTimeout(() => process.exit(0), 30000)\"",
    });
    const cleanupProcessId = cleanupTarget.match(/process (\d+)/)?.[1];
    assert(cleanupProcessId);
    const admin = spawnSync(process.execPath, [path.resolve("./mcp_runtime_admin.mjs"), "cleanup-owner", owner], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.strictEqual(admin.status, 0, admin.stderr || "runtime admin cleanup failed");

    let removed = false;
    try {
      await bridgeC.tool("read_process_output", { id: cleanupProcessId });
    } catch (error) {
      removed = /No background process/i.test(error.message);
    }
    assert(removed, "cleanup-owner must terminate and forget owner processes");
    console.log("5. Runtime owner cleanup removed orphanable background processes.");

    console.log("PASS: runtime state survives independent MCP bridge processes.");
  } finally {
    try {
      if (terminalId && bridgeC) await bridgeC.tool("close_terminal", { id: terminalId });
    } catch {}
    try { await bridgeA?.stop(); } catch {}
    try { await bridgeB?.stop(); } catch {}
    try { await bridgeC?.stop(); } catch {}
    try { await runtimeCall("runtime.cleanup_owner", owner, {}, 3000); } catch {}
    try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
