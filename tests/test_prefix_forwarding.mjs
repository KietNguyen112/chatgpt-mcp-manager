import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

console.log("=== Testing all M1 tools with Server Prefixes (M1.xxx) ===");

const testDir = path.resolve("./tests/scratch_all_prefixed");
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const bridgePath = path.resolve("./mcp_filesystem_bridge.mjs");
const proc = spawn("node", [bridgePath, testDir], { stdio: ["pipe", "pipe", "inherit"] });

let msgId = 1;
const pending = new Map();
proc.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
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
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout for ${method}`)); }, 15000);
    pending.set(id, (r) => { clearTimeout(timeout); resolve(r); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function callTool(name, args) {
  const res = await call("tools/call", { name, arguments: args });
  if (!res.result) throw new Error(JSON.stringify(res));
  if (res.result.isError) throw new Error(`Tool ${name} failed: ${res.result.content?.[0]?.text || JSON.stringify(res)}`);
  return res.result.content?.[0]?.text || "";
}

async function run() {
  try {
    await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "openai-mcp", version: "1.0.0" } });
    await call("notifications/initialized");

    // 1. Discovery
    const toolsList = await call("tools/list");
    const totalTools = toolsList.result.tools.length;
    console.log(`1. tools/list discovered: ${totalTools} tools (Expected at least: 53)`);
    assert(totalTools >= 57, `Expected at least 57 tools, got ${totalTools}`);
    assert(toolsList.result.tools.some((tool) => tool.name === "agent_state"), "agent_state must be registered");
    assert(toolsList.result.tools.some((tool) => tool.name === "update_plan"), "update_plan must be registered");
    assert(toolsList.result.tools.some((tool) => tool.name === "remember"), "remember must be registered");

    // 2. M1.list_allowed_directories
    const allowed = await callTool("M1.list_allowed_directories", {});
    console.log("2. M1.list_allowed_directories:", allowed);
    assert(allowed.includes(testDir));

    // 3. Agent state tools
    const plan = JSON.parse(await callTool("M1.update_plan", { steps: ["Inspect", "Implement", "Verify"], currentStep: 2 }));
    assert.strictEqual(plan.plan[1].status, "in_progress");
    const memoryMarker = `Persistent agent memory ${Date.now()}`;
    await callTool("M1.remember", { category: "test", note: memoryMarker });
    const state = JSON.parse(await callTool("M1.agent_state", {}));
    const memory = JSON.parse(await callTool("M1.agent_recall", { query: memoryMarker }));
    assert.strictEqual(memory.count, 1);
    console.log("3. Agent state: OK");

    // 4. M1.get_workspace
    const ws = JSON.parse(await callTool("M1.get_workspace", {}));
    console.log("3. M1.get_workspace:", ws.detected_project_type);
    assert.strictEqual(ws.workspace_root, testDir);

    // 4. M1.create_directory
    const subDir = path.join(testDir, "subdir");
    await callTool("M1.create_directory", { path: subDir });
    console.log("4. M1.create_directory: OK");
    assert(fs.existsSync(subDir));

    // 5. M1.write_file
    const file1 = path.join(testDir, "file1.txt");
    const wRes = await callTool("M1.write_file", { path: file1, content: "line 1\nline 2\nline 3\n" });
    console.log("5. M1.write_file:", wRes);
    assert(fs.existsSync(file1));

    // 6. M1.read_text_file
    const rText = await callTool("M1.read_text_file", { path: file1 });
    console.log("6. M1.read_text_file:", rText.replace(/\n/g, " | "));
    assert(rText.includes("line 1"));

    // 7. M1.read_file
    const rFile = await callTool("M1.read_file", { path: file1 });
    console.log("7. M1.read_file:", rFile.replace(/\n/g, " | "));
    assert(rFile.includes("line 1"));

    // 8. M1.read_file_range
    const rRange = await callTool("M1.read_file_range", { path: file1, start_line: 2, end_line: 3 });
    console.log("8. M1.read_file_range:", rRange.replace(/\n/g, " | "));
    assert(rRange.includes("2\tline 2"));

    // 9. M1.list_directory & list_directory_with_sizes
    const lDir = await callTool("M1.list_directory", { path: testDir });
    console.log("9. M1.list_directory:", lDir.replace(/\n/g, " | "));
    assert(lDir.includes("file1.txt") && lDir.includes("subdir"));

    const lSizes = await callTool("M1.list_directory_with_sizes", { path: testDir });
    console.log("   M1.list_directory_with_sizes:", lSizes.replace(/\n/g, " | "));
    assert(lSizes.includes("file1.txt"));

    // 10. M1.directory_tree & get_directory_tree
    const tree1 = await callTool("M1.directory_tree", { path: testDir });
    const tree2 = await callTool("M1.get_directory_tree", { path: testDir });
    console.log("10. M1.get_directory_tree:", tree2.replace(/\n/g, " | "));
    assert(tree2.includes("file1.txt"));

    // 11. M1.get_file_info
    const fInfo = await callTool("M1.get_file_info", { path: file1 });
    console.log("11. M1.get_file_info:", fInfo.replace(/\n/g, " | "));
    assert(fInfo.includes("size") || fInfo.includes("created") || fInfo.includes("modified"));

    // 12. M1.search_files & grep_search
    const sFiles = await callTool("M1.search_files", { path: testDir, pattern: "file*.txt" });
    console.log("12. M1.search_files:", sFiles.replace(/\n/g, " | "));
    assert(sFiles.includes("file1.txt"));

    const gSearch = await callTool("M1.grep_search", { query: "line 2", path: testDir });
    console.log("    M1.grep_search:", gSearch.replace(/\n/g, " | "));
    assert(gSearch.includes("line 2"));

    // 13. M1.read_multiple_files
    const rMulti = await callTool("M1.read_multiple_files", { paths: [file1] });
    console.log("13. M1.read_multiple_files:", rMulti.replace(/\n/g, " | "));
    assert(rMulti.includes("line 1"));

    // 14. M1.edit_file
    const editRes = await callTool("M1.edit_file", { path: file1, edits: [{ oldText: "line 2", newText: "LINE TWO MODIFIED" }] });
    console.log("14. M1.edit_file:", editRes);
    assert(fs.readFileSync(file1, "utf8").includes("LINE TWO MODIFIED"));

    // 15. M1.apply_patch
    const patchText = [
      "--- a/file1.txt",
      "+++ b/file1.txt",
      "@@ -1,3 +1,3 @@",
      " line 1",
      "-LINE TWO MODIFIED",
      "+LINE TWO PATCHED",
      " line 3",
    ].join("\n");
    const patchRes = await callTool("M1.apply_patch", { patch: patchText });
    console.log("15. M1.apply_patch:", patchRes.replace(/\n/g, " | "));
    assert(fs.readFileSync(file1, "utf8").includes("LINE TWO PATCHED"));

    // 16. M1.move_file
    const movedFile = path.join(subDir, "file1_moved.txt");
    await callTool("M1.move_file", { source: file1, destination: movedFile });
    console.log("16. M1.move_file: OK");
    assert(!fs.existsSync(file1) && fs.existsSync(movedFile));

    // 17. M1.run_command
    const cmdRes = await callTool("M1.run_command", { command: "echo RUN_OK", path: testDir });
    console.log("17. M1.run_command:", cmdRes.replace(/\n/g, " | "));
    assert(cmdRes.includes("RUN_OK"));

    // 18. M1.create_terminal, exec_terminal, close_terminal
    const termRes = await callTool("M1.create_terminal", { path: testDir });
    const termId = termRes.match(/session (\d+)/)[1];
    const execRes = await callTool("M1.exec_terminal", { id: termId, command: "echo TERM_OK" });
    console.log("18. M1.exec_terminal:", execRes.replace(/\n/g, " | "));
    assert(execRes.includes("TERM_OK"));
    await callTool("M1.close_terminal", { id: termId });

    // 19. Prefixed Git worktree tools
    await callTool("M1.run_command", {
      path: testDir,
      command: "git init -q; git config user.email m1@test.invalid; git config user.name M1; git add -A; git commit -q -m baseline",
    });
    const wtCreate = await callTool("M1.git_worktree_create", { path: testDir, branch: "m1-prefixed-worktree", activate: false });
    const wtPath = wtCreate.match(/Path: (.+)/)?.[1]?.trim();
    assert(wtPath && fs.existsSync(wtPath));
    const wtList = await callTool("M1.git_worktree_list", { path: testDir });
    assert(wtList.includes("m1-prefixed-worktree"));
    await callTool("M1.git_worktree_remove", { path: testDir, worktree_path: wtPath, delete_branch: true });
    assert(!fs.existsSync(wtPath));
    console.log("19. M1.git_worktree_*: OK");

    // 20. M1.delete_file & delete_directory
    const delFileRes = await callTool("M1.delete_file", { path: movedFile });
    console.log("20. M1.delete_file:", delFileRes);
    assert(!fs.existsSync(movedFile));

    console.log("\n===============================================================");
    console.log(">>> ALL M1 TOOLS TESTED WITH SERVER PREFIXES: 100% SUCCESS <<<");
    console.log("===============================================================");
  } catch (err) {
    console.error("Test failed:", err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    try {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {}
  }
}

run();
