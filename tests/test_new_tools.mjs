import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

console.log("=== Running M1 v2.1 (Codex-Grade) Test Suite ===");

const testDir = path.resolve("./tests/scratch_m1_v2");
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const subDir = path.join(testDir, "packages", "frontend");
fs.mkdirSync(subDir, { recursive: true });

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
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout for ${method}`)); }, 20000);
    pending.set(id, (r) => { clearTimeout(timeout); resolve(r); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function toolCall(name, args) {
  const res = await call("tools/call", { name, arguments: args });
  if (!res.result) throw new Error(JSON.stringify(res));
  if (res.result.isError) throw new Error(res.result.content[0].text);
  return res.result.content[0].text;
}

async function runTests() {
  try {
    const initRes = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test-client", version: "1" } });
    assert(initRes.result?.instructions?.includes("local coding agent"), "initialize must expose coding-agent instructions");

    const initialTools = await call("tools/list");
    const initialToolMap = new Map(initialTools.result.tools.map((tool) => [tool.name, tool]));
    assert.strictEqual(initialToolMap.get("get_workspace")?.annotations?.readOnlyHint, true, "read tools must be annotated read-only");
    assert.strictEqual(initialToolMap.get("apply_patch")?.annotations?.readOnlyHint, false, "write tools must not be annotated read-only");
    assert.strictEqual(initialToolMap.get("apply_patch")?.annotations?.destructiveHint, true, "destructive tools must be annotated");
    console.log("   ✓ Coding-agent instructions and tool annotations verified.");

    // 1. Workspace Context
    console.log("1. Workspace Context (get_workspace / set_workspace)...");
    const ws = JSON.parse(await toolCall("get_workspace", {}));
    console.log("   Workspace root:", ws.workspace_root, "| active_cwd:", ws.active_cwd);
    assert.strictEqual(ws.workspace_root, testDir);
    assert.strictEqual(ws.active_cwd, testDir);

    const setRes = await toolCall("set_workspace", { path: subDir });
    console.log("   ", setRes);
    const ws2 = JSON.parse(await toolCall("get_workspace", {}));
    assert.strictEqual(ws2.active_cwd, subDir);
    console.log("   ✓ get_workspace / set_workspace OK");

    // Reset workspace back to testDir
    await toolCall("set_workspace", { path: testDir });

    // 2. read_file_range
    console.log("2. read_file_range...");
    const sampleFile = path.join(testDir, "sample.txt");
    fs.writeFileSync(sampleFile, Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
    const rangeText = await toolCall("read_file_range", { path: sampleFile, start_line: 10, end_line: 13 });
    console.log("   ", rangeText.replace(/\n/g, " | "));
    assert(rangeText.includes("10\tline 10") && rangeText.includes("13\tline 13"));
    assert(!rangeText.includes("line 14"));
    console.log("   ✓ read_file_range OK");

    // 3. Git Suite
    console.log("3. Git Suite...");
    execSync("git init -q", { cwd: testDir });
    execSync('git config user.email "codex@test.com"', { cwd: testDir });
    execSync('git config user.name "Codex"', { cwd: testDir });

    await toolCall("git_add", { path: testDir });
    const commitRes = await toolCall("git_commit", { path: testDir, message: "Initial commit" });
    console.log("   git_commit:", commitRes);
    const logRes = await toolCall("git_log", { path: testDir, max_count: 5 });
    console.log("   git_log:", logRes);
    assert(logRes.includes("Initial commit"));

    const statusRes = await toolCall("git_status", { path: testDir });
    console.log("   git_status:", statusRes);
    assert(statusRes.includes("clean") || statusRes.includes("master") || statusRes.includes("main"));

    const diffStatRes = await toolCall("git_diff", { path: testDir, stat: true });
    console.log("   git_diff stat:", diffStatRes);
    console.log("   ✓ Git Suite OK");

    // 4. Git Worktree Isolation
    console.log("4. Git Worktree Isolation...");
    const wtCreate = await toolCall("git_worktree_create", {
      path: testDir,
      branch: "m1-agent-isolated",
      base_ref: "HEAD",
      activate: true,
    });
    console.log("   git_worktree_create:", wtCreate.replace(/\n/g, " | "));
    const wtPath = wtCreate.match(/Path: (.+)/)?.[1]?.trim();
    assert(wtPath && fs.existsSync(wtPath), "managed worktree path must exist");
    const wtWorkspace = JSON.parse(await toolCall("get_workspace", {}));
    assert.strictEqual(wtWorkspace.active_cwd, wtPath, "created worktree should become active when activate=true");
    const wtList = await toolCall("git_worktree_list", { path: testDir });
    assert(wtList.includes("m1-agent-isolated"), "worktree list must include isolated branch");
    const wtRemove = await toolCall("git_worktree_remove", {
      path: testDir,
      worktree_path: wtPath,
      delete_branch: true,
    });
    console.log("   git_worktree_remove:", wtRemove.replace(/\n/g, " | "));
    assert(!fs.existsSync(wtPath), "managed worktree must be removed");
    const restoredWorkspace = JSON.parse(await toolCall("get_workspace", {}));
    assert.strictEqual(restoredWorkspace.active_cwd, testDir, "removing active worktree should restore main repository CWD");
    console.log("   ✓ Git Worktree Isolation OK");

    // 5. 100% Atomic apply_patch
    console.log("5. 100% Atomic apply_patch...");
    const fileA = path.join(testDir, "fileA.txt");
    fs.writeFileSync(fileA, "alpha\nbravo\ncharlie\n");

    // 4a. Successful multi-file patch (modify + create)
    const validPatch = [
      "--- a/fileA.txt",
      "+++ b/fileA.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-bravo",
      "+BRAVO",
      " charlie",
      "--- /dev/null",
      "+++ b/created.txt",
      "@@ -0,0 +1,2 @@",
      "+hello new file",
      "+second line",
    ].join("\n");

    const patchSuccess = await toolCall("apply_patch", { patch: validPatch });
    console.log("   Success case:", patchSuccess.replace(/\n/g, " | "));
    assert(fs.readFileSync(fileA, "utf8").includes("BRAVO"));
    assert(fs.existsSync(path.join(testDir, "created.txt")));

    // 4b. Failed patch should rollback and touch ZERO files
    const invalidPatch = [
      "--- a/fileA.txt",
      "+++ b/fileA.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-BRAVO",
      "+SHOULD_NOT_BE_WRITTEN",
      " charlie",
      "--- a/created.txt",
      "+++ b/created.txt",
      "@@ -1,2 +1,2 @@",
      " NON_EXISTENT_CONTEXT_LINE_SHOULD_FAIL",
      "-second line",
      "+corrupted line",
    ].join("\n");

    let patchFailedAsExpected = false;
    try {
      await toolCall("apply_patch", { patch: invalidPatch });
    } catch (err) {
      patchFailedAsExpected = true;
      console.log("   Atomic rollback caught invalid hunk as expected.");
    }
    assert(patchFailedAsExpected, "apply_patch must fail on invalid hunk");
    assert(!fs.readFileSync(fileA, "utf8").includes("SHOULD_NOT_BE_WRITTEN"), "fileA must NOT be modified when subsequent hunk fails");
    console.log("   ✓ Atomic apply_patch OK");

    // 6. Persistent Terminal Sessions
    console.log("6. Persistent Terminal Sessions (create_terminal / exec_terminal / close_terminal)...");
    const termRes = await toolCall("create_terminal", { path: testDir });
    console.log("   create_terminal:", termRes);
    const termIdMatch = termRes.match(/session (\d+)/);
    assert(termIdMatch, "create_terminal must return session id");
    const termId = termIdMatch[1];

    const exec1 = await toolCall("exec_terminal", { id: termId, command: "$env:MY_TEST_VAR = 'CODEX_ACTIVE'; echo 'VAR_SET'" });
    console.log("   exec 1:", exec1.replace(/\n/g, " | "));
    assert(exec1.includes("VAR_SET"));

    // Verify environment variable is retained in subsequent command!
    const exec2 = await toolCall("exec_terminal", { id: termId, command: "echo \"RETAINED: $env:MY_TEST_VAR\"" });
    console.log("   exec 2:", exec2.replace(/\n/g, " | "));
    assert(exec2.includes("RETAINED: CODEX_ACTIVE"), "Terminal must retain environment variables across commands");

    const termList = await toolCall("list_terminals", {});
    console.log("   list_terminals:", termList);
    assert(termList.includes(`Terminal ${termId}`));

    const closeTermRes = await toolCall("close_terminal", { id: termId });
    console.log("   close_terminal:", closeTermRes);
    console.log("   ✓ Persistent Terminal Sessions OK");

    // 7. Background Process Management
    console.log("7. Background Process Management (start / write_input / wait / stop)...");
    const startRes = await toolCall("start_process", {
      command: "node -e \"process.stdin.once('data', d => { console.log('ECHO_INPUT: ' + d.toString().trim()); setTimeout(() => process.exit(0), 100); })\"",
      path: testDir,
    });
    console.log("   start_process:", startRes);
    const procIdMatch = startRes.match(/process (\d+)/);
    assert(procIdMatch, "start_process must return process id");
    const procId = procIdMatch[1];

    await new Promise((r) => setTimeout(r, 100));
    const writeRes = await toolCall("write_process_input", { id: procId, text: "HELLO_BACKGROUND" });
    console.log("   write_process_input:", writeRes);

    const waitRes = await toolCall("wait_process", { id: procId, timeout_seconds: 5 });
    console.log("   wait_process:", waitRes.replace(/\n/g, " | "));
    assert(waitRes.includes("ECHO_INPUT: HELLO_BACKGROUND"), "Process output must capture stdin input");
    console.log("   ✓ Background Process Management OK");

    // 8. Structured Test Runner & Diagnostics
    console.log("8. Structured Test Runner & Diagnostics...");
    const testRunRes = JSON.parse(await toolCall("run_tests", { path: testDir, command: "python -c \"print('Ran 5 tests'); print('OK')\"" }));
    console.log("   run_tests summary:", testRunRes.summary);
    assert.strictEqual(testRunRes.passed, 5);
    assert.strictEqual(testRunRes.failed, 0);

    const diagRes = JSON.parse(await toolCall("get_diagnostics", { path: testDir, tool: "python" }));
    console.log("   get_diagnostics (python):", `total_errors=${diagRes.total_errors}`);
    console.log("   ✓ Test Runner & Diagnostics OK");

    // 9. Read-Only mode enforcement
    console.log("9. Read-Only mode enforcement...");
    proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    const roProc = spawn("node", [bridgePath, "--read-only", testDir], { stdio: ["pipe", "pipe", "inherit"] });
    let roId = 1;
    const roPending = new Map();
    roProc.stdout.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.id && roPending.has(parsed.id)) { roPending.get(parsed.id)(parsed); roPending.delete(parsed.id); }
        } catch {}
      }
    });
    function roCall(method, params = {}) {
      const id = roId++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { roPending.delete(id); reject(new Error("timeout")); }, 15000);
        roPending.set(id, (r) => { clearTimeout(t); resolve(r); });
        roProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
    await roCall("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const roList = await roCall("tools/list");
    const roNames = roList.result.tools.map((t) => t.name);

    assert(!roNames.includes("create_terminal"), "create_terminal must not be in Read-Only tools");
    assert(!roNames.includes("exec_terminal"), "exec_terminal must not be in Read-Only tools");
    assert(!roNames.includes("set_workspace"), "set_workspace must not be in Read-Only tools");
    assert(!roNames.includes("apply_patch"), "apply_patch must not be in Read-Only tools");
    assert(!roNames.includes("git_worktree_create"), "git_worktree_create must not be in Read-Only tools");
    assert(!roNames.includes("git_worktree_remove"), "git_worktree_remove must not be in Read-Only tools");
    assert(roNames.includes("git_worktree_list"), "git_worktree_list should be available in Read-Only mode");
    assert(roNames.includes("get_workspace"), "get_workspace (read) should be in Read-Only tools");
    assert(roNames.includes("get_diagnostics"), "get_diagnostics (read) should be in Read-Only tools");
    console.log("   Read-only tool list correctly excludes all write/exec tools.");
    roProc.kill();
    console.log("   ✓ Read-Only enforcement OK");

    console.log("\n=======================================================");
    console.log(">>> ALL M1 v2.1 (CODEX-GRADE) TESTS PASSED (100%)! <<<");
    console.log("=======================================================");
  } catch (err) {
    console.error("Test failure:", err);
    process.exitCode = 1;
  } finally {
    try { proc.kill(); } catch {}
    try {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {}
  }
}

runTests();
