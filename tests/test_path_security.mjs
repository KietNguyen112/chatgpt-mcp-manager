import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const allowedDir = path.resolve("./tests/scratch_path_security_allowed");
const outsideDir = path.resolve("./tests/scratch_path_security_outside");
const linkDir = path.join(allowedDir, "escape-link");
const bridgePath = path.resolve("./mcp_filesystem_bridge.mjs");

function reset() {
  for (const target of [allowedDir, outsideDir]) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
  fs.mkdirSync(allowedDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "OUTSIDE_SECRET", "utf8");
  fs.symlinkSync(outsideDir, linkDir, process.platform === "win32" ? "junction" : "dir");
}

async function run() {
  reset();
  const proc = spawn("node", [bridgePath, allowedDir], { stdio: ["pipe", "pipe", "inherit"] });
  let nextId = 1;
  let buffer = "";
  const pending = new Map();

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {}
    }
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  const tool = async (name, args) => call("tools/call", { name, arguments: args });

  try {
    await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "path-security-test", version: "1" },
    });

    const escapedFile = path.join(linkDir, "secret.txt");
    const readResult = await tool("read_text_file", { path: escapedFile });
    assert.strictEqual(readResult.result?.isError, true, "read through an escaping junction/symlink must be blocked");
    assert.match(readResult.result.content[0].text, /outside allowed directories/i);

    const commandResult = await tool("run_command", { path: linkDir, command: "echo SHOULD_NOT_RUN" });
    assert.strictEqual(commandResult.result?.isError, true, "shell cwd through an escaping junction/symlink must be blocked");

    const writeResult = await tool("write_file", { path: path.join(linkDir, "created.txt"), content: "NOPE" });
    assert.strictEqual(writeResult.result?.isError, true, "write through an escaping junction/symlink must be blocked");
    assert.strictEqual(fs.existsSync(path.join(outsideDir, "created.txt")), false);

    console.log("PASS: symlink/junction escape paths are blocked before tool forwarding.");
  } finally {
    try { proc.kill(); } catch {}
    try { fs.rmSync(allowedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
    try { fs.rmSync(outsideDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
