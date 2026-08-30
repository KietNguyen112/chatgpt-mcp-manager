import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

console.log("=== Running Bridge Tools Unit & Integration Tests ===");

const testDir = path.resolve("./tests/scratch_test_workspace");
if (fs.existsSync(testDir)) {
  fs.rmSync(testDir, { recursive: true, force: true });
}
fs.mkdirSync(testDir, { recursive: true });

// Create sample nested files
const nestedDir = path.join(testDir, "src", "components", "ui");
fs.mkdirSync(nestedDir, { recursive: true });
const sampleFile = path.join(nestedDir, "Button.tsx");
fs.writeFileSync(sampleFile, "export const Button = () => {\r\n  return <button>Click me</button>;\r\n};\r\n", "utf8");

const pythonFile = path.join(testDir, "app.py");
fs.writeFileSync(pythonFile, "def main():\n    print('Hello MCP World')\n\nif __name__ == '__main__':\n    main()\n", "utf8");

// Spawn mcp_filesystem_bridge.mjs with testDir
const bridgePath = path.resolve("./mcp_filesystem_bridge.mjs");
const proc = spawn("node", [bridgePath, testDir], {
  stdio: ["pipe", "pipe", "inherit"],
});

let msgId = 1;
const pending = new Map();

proc.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed.id && pending.has(parsed.id)) {
        const resolve = pending.get(parsed.id);
        pending.delete(parsed.id);
        resolve(parsed);
      }
    } catch {}
  }
});

function call(method, params = {}) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for RPC response for ${method}`));
    }, 15000);

    pending.set(id, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });

    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    proc.stdin.write(payload);
  });
}

async function runTests() {
  try {
    // 1. Initialize
    console.log("1. Testing MCP initialize & tools/list...");
    await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" }
    });

    const listRes = await call("tools/list");
    const toolNames = listRes.result.tools.map(t => t.name);
    console.log("   Available tools:", toolNames.join(", "));
    
    assert(toolNames.includes("grep_search"), "grep_search tool must be registered");
    assert(toolNames.includes("get_directory_tree"), "get_directory_tree tool must be registered");
    assert(toolNames.includes("git_status"), "git_status tool must be registered");
    assert(toolNames.includes("git_diff"), "git_diff tool must be registered");
    assert(toolNames.includes("run_command"), "run_command tool must be registered");
    assert(toolNames.includes("delete_file"), "delete_file tool must be registered");
    console.log("   ✓ tools/list verified.");

    // 2. Test grep_search
    console.log("2. Testing grep_search...");
    const grepRes = await call("tools/call", {
      name: "grep_search",
      arguments: { query: "Hello MCP World", path: testDir }
    });
    console.log("   Grep result:\n", grepRes.result.content[0].text);
    assert(grepRes.result.content[0].text.includes("app.py"), "grep_search should find Hello MCP World in app.py");
    console.log("   ✓ grep_search verified.");

    // 3. Test get_directory_tree
    console.log("3. Testing get_directory_tree...");
    const treeRes = await call("tools/call", {
      name: "get_directory_tree",
      arguments: { path: testDir, max_depth: 4 }
    });
    console.log("   Directory tree:\n", treeRes.result.content[0].text);
    assert(treeRes.result.content[0].text.includes("Button.tsx"), "Tree should contain Button.tsx");
    assert(treeRes.result.content[0].text.includes("app.py"), "Tree should contain app.py");
    console.log("   ✓ get_directory_tree verified.");

    // 4. Test run_command
    console.log("4. Testing run_command...");
    const cmdRes = await call("tools/call", {
      name: "run_command",
      arguments: { command: "python app.py", path: testDir }
    });
    console.log("   Command result:\n", cmdRes.result.content[0].text);
    assert(cmdRes.result.content[0].text.includes("Hello MCP World"), "Command should output Hello MCP World");
    assert(cmdRes.result.content[0].text.includes("Exit Code: 0"), "Exit Code should be 0");
    console.log("   ✓ run_command verified.");

    // 5. Test auto-mkdir on write_file in deeply nested new folder
    console.log("5. Testing auto-mkdir on write_file...");
    const deepFile = path.join(testDir, "a", "b", "c", "deep_file.txt");
    const writeRes = await call("tools/call", {
      name: "write_file",
      arguments: { path: deepFile, content: "Created seamlessly inside nested dir!" }
    });
    console.log("   Write result:", writeRes);
    assert(fs.existsSync(deepFile), "Deep file must exist on disk");
    assert.strictEqual(fs.readFileSync(deepFile, "utf8"), "Created seamlessly inside nested dir!");
    console.log("   ✓ auto-mkdir on write_file verified.");

    // 6. Test resilient edit_file with CRLF vs LF matching
    console.log("6. Testing resilient edit_file...");
    const editRes = await call("tools/call", {
      name: "edit_file",
      arguments: {
        path: sampleFile,
        edits: [{
          oldText: "export const Button = () => {\n  return <button>Click me</button>;\n};",
          newText: "export const Button = () => {\n  return <button>Submitted!</button>;\n};"
        }]
      }
    });
    console.log("   Edit result:", editRes.result.content[0].text);
    const updatedSample = fs.readFileSync(sampleFile, "utf8");
    assert(updatedSample.includes("Submitted!"), "Button.tsx should have new content");
    console.log("   ✓ resilient edit_file verified.");

    console.log("\n>>> ALL TESTS PASSED SUCCESSFULLY! <<<");
  } catch (err) {
    console.error("Test failure:", err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }
}

runTests();
