import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const bridgePath = path.resolve("./mcp_filesystem_bridge.mjs");
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-manager-shutdown-"));

const proc = spawn(process.execPath, [bridgePath, testDir], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

const exited = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
proc.stdin.end();

const result = await Promise.race([
  exited,
  new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
]);

if (!result) {
  proc.kill();
  throw new Error(`Bridge did not exit after stdin close. stderr:\n${stderr}`);
}

assert.equal(result.code, 0, `Bridge shutdown exited with code ${result.code} (${result.signal}). stderr:\n${stderr}`);
assert.doesNotMatch(stderr, /ReferenceError:\s+terminals is not defined/);
assert.doesNotMatch(stderr, /ReferenceError:\s+backgroundProcesses is not defined/);

fs.rmSync(testDir, { recursive: true, force: true });
console.log("Shutdown lifecycle: OK");
