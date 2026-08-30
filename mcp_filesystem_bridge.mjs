import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { runtimeCall, makeRuntimeOwner } from "./mcp_runtime_client.mjs";
import { enforceCommandPolicy, policyDescription } from "./mcp_policy.mjs";
import { projectSummary } from "./mcp_agent_context.mjs";

const args = process.argv.slice(2);
const readOnly = args[0] === "--read-only";
const folders = (readOnly ? args.slice(1) : args).map((item) => path.resolve(item));
const runtimeOwner = makeRuntimeOwner(folders, readOnly);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const filesystemArgs = ["-y", "@modelcontextprotocol/server-filesystem@2026.7.10", ...folders];
const windowsNpxCli = process.platform === "win32"
  ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js")
  : "";
const child = process.platform === "win32" && fs.existsSync(windowsNpxCli)
  ? spawn(process.execPath, [windowsNpxCli, ...filesystemArgs], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    })
  : spawn(npx, filesystemArgs, {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
      shell: process.platform === "win32",
    });

const pendingToolsList = new Set();
const pendingInitialize = new Set();
const WRITE_TOOL_HINTS = new Set([
  "write_file", "edit_file", "create_directory", "move_file", "delete_file", "delete_directory",
  "set_workspace", "run_command", "create_terminal", "exec_terminal", "send_terminal_input",
  "close_terminal", "start_process", "write_process_input", "stop_process", "run_tests", "apply_patch",
  "git_add", "git_commit", "git_branch", "git_checkout", "git_stash", "git_worktree_create",
  "git_worktree_remove", "create_checkpoint", "rollback_checkpoint"
]);
const DESTRUCTIVE_TOOL_HINTS = new Set([
  "delete_file", "delete_directory", "move_file", "apply_patch", "git_commit", "git_checkout",
  "git_branch", "git_stash", "git_worktree_create", "git_worktree_remove", "rollback_checkpoint",
  "stop_process", "close_terminal"
]);

function annotateTool(tool) {
  const name = String(tool?.name || "").split(".").pop().split(":").pop().split("/").pop();
  const write = WRITE_TOOL_HINTS.has(name);
  tool.annotations = {
    ...(tool.annotations || {}),
    readOnlyHint: !write,
    destructiveHint: write ? DESTRUCTIVE_TOOL_HINTS.has(name) : false,
    idempotentHint: !write,
    openWorldHint: false,
  };
  return tool;
}

function buildAgentInstructions() {
  const root = folders[0] || process.cwd();
  const files = ["AGENTS.md", "CLAUDE.md", ".github/AGENTS.md"];
  const sections = [];
  for (const relative of files) {
    const file = path.join(root, relative);
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const text = fs.readFileSync(file, "utf8").trim();
        if (text) sections.push(`### ${relative}\n${text.slice(0, 12000)}`);
      }
    } catch {}
  }
  const base = [
    "You are operating as a local coding agent through MCP.",
    "Treat the configured allowed directories as the workspace boundary.",
    "Prefer grep_search/get_directory_tree/read_file_range before broad file reads.",
    "Use apply_patch for multi-file changes when possible; it validates all hunks before writing.",
    "Use persistent terminals for commands that need shell state, and start_process for long-running servers/watchers.",
    "Inspect diagnostics and run tests after meaningful code changes.",
    "Use Git status/diff before and after changes; use worktrees when isolation is useful.",
    "Never claim a change succeeded until the corresponding tool result confirms it.",
  ];
  if (sections.length) base.push("Repository agent instructions discovered locally:\n" + sections.join("\n\n"));
  return base.join("\n");
}

let activeCwd = folders[0] || process.cwd();
let runtimeWorkspaceLoaded = false;

async function restoreRuntimeWorkspace() {
  if (runtimeWorkspaceLoaded) return;
  try {
    const savedCwd = await runtimeCall("workspace.get", runtimeOwner, { defaultCwd: activeCwd }, 2500);
    if (savedCwd) {
      const resolved = path.resolve(savedCwd);
      if (isAllowed(resolved) && fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        activeCwd = resolved;
      }
    }
    runtimeWorkspaceLoaded = true;
  } catch {
    // Do not make ordinary filesystem tools depend on the optional runtime daemon.
  }
}

function resolveTarget(target) {
  if (!target) return activeCwd;
  if (path.isAbsolute(target)) {
    return path.resolve(target);
  }
  return path.resolve(activeCwd, target);
}

function normalizeForComparison(target) {
  const normalized = path.resolve(target);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function realPathOrResolved(target) {
  try {
    return path.resolve(fs.realpathSync.native(target));
  } catch {
    return path.resolve(target);
  }
}

const canonicalRoots = folders.map((root) => normalizeForComparison(realPathOrResolved(root)));

function canonicalizeForContainment(target) {
  const resolved = resolveTarget(target);
  let probe = resolved;
  const missing = [];

  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missing.unshift(path.basename(probe));
    probe = parent;
  }

  const canonicalBase = fs.existsSync(probe) ? realPathOrResolved(probe) : path.resolve(probe);
  return normalizeForComparison(path.resolve(canonicalBase, ...missing));
}

const isAllowed = (target) => {
  try {
    const canonicalTarget = canonicalizeForContainment(target);
    return canonicalRoots.some((root) => canonicalTarget === root || canonicalTarget.startsWith(`${root}${path.sep}`));
  } catch {
    return false;
  }
};

function validateRequestedPaths(toolName, toolArgs) {
  const candidates = [];
  if (typeof toolArgs?.path === "string" && toolArgs.path.trim()) candidates.push(toolArgs.path);
  if (Array.isArray(toolArgs?.paths)) {
    for (const item of toolArgs.paths) {
      if (typeof item === "string" && item.trim()) candidates.push(item);
    }
  }
  if (toolName === "move_file") {
    if (typeof toolArgs?.source === "string" && toolArgs.source.trim()) candidates.push(toolArgs.source);
    if (typeof toolArgs?.destination === "string" && toolArgs.destination.trim()) candidates.push(toolArgs.destination);
  }

  for (const candidate of candidates) {
    if (!isAllowed(candidate)) {
      return `Path is outside allowed directories (including symlink/junction resolution): ${candidate}`;
    }
  }
  return "";
}

function result(id, text, isError = false) {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: String(text) }], isError },
  };
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "coverage",
  ".turbo",
  ".cache",
  "bin",
      "runtime",
    ".m1-worktrees",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".exe", ".dll", ".zip",
  ".tar", ".gz", ".7z", ".mp3", ".mp4", ".mov", ".woff", ".woff2", ".ttf", ".eot",
  ".pyc", ".pyd", ".db", ".sqlite", ".bin", ".lock"
]);

function matchSimplePattern(filename, pattern) {
  if (!pattern || pattern === "*") return true;
  const regexPattern = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  try {
    return new RegExp(regexPattern, "i").test(filename);
  } catch {
    return true;
  }
}

function getWorkspace() {
  const root = folders[0] || process.cwd();
  let isGit = false;
  let gitBranch = "";
  try {
    const gitCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: activeCwd, encoding: "utf8", windowsHide: true });
    isGit = gitCheck.status === 0;
    if (isGit) {
      const bRes = spawnSync("git", ["branch", "--show-current"], { cwd: activeCwd, encoding: "utf8", windowsHide: true });
      gitBranch = (bRes.stdout || "").trim();
    }
  } catch {}

  let projectType = "Generic";
  if (fs.existsSync(path.join(root, "package.json"))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      if (pkg.dependencies?.next || pkg.devDependencies?.next) projectType = "Next.js";
      else if (pkg.dependencies?.react || pkg.devDependencies?.react) projectType = "React";
      else if (pkg.dependencies?.vue || pkg.devDependencies?.vue) projectType = "Vue";
      else projectType = "Node.js";
    } catch {
      projectType = "Node.js";
    }
  } else if (fs.existsSync(path.join(root, "requirements.txt")) || fs.existsSync(path.join(root, "pyproject.toml"))) {
    projectType = "Python";
  } else if (fs.existsSync(path.join(root, "Cargo.toml"))) {
    projectType = "Rust";
  } else if (fs.existsSync(path.join(root, "go.mod"))) {
    projectType = "Go";
  }

  return JSON.stringify({
    workspace_root: root,
    active_cwd: activeCwd,
    allowed_directories: folders,
    is_git_repo: isGit,
    git_branch: gitBranch || undefined,
    detected_project_type: projectType,
    platform: process.platform,
    read_only: readOnly,
    policy: policyDescription(),
  }, null, 2);
}

function getProjectSummary() {
  return JSON.stringify(projectSummary(activeCwd, policyDescription()), null, 2);
}

function projectSearch(query, subPath, maxResults = 50, filePattern = "") {
  return grepSearch(query, subPath, false, false, Math.min(Math.max(1, Number(maxResults) || 50), 200), filePattern);
}

function verifyWorkspace(subPath) {
  const root = subPath ? resolveTarget(subPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  const checks = [];
  try {
    const diagnostics = JSON.parse(getDiagnostics(subPath));
    checks.push({ name: "diagnostics", success: Number(diagnostics.total_errors || 0) === 0, result: diagnostics });
  } catch (error) { checks.push({ name: "diagnostics", success: false, error: error.message }); }
  if (!readOnly) {
    try {
      const tests = JSON.parse(runTests(subPath));
      checks.push({ name: "tests", success: Boolean(tests.success), result: tests });
    } catch (error) { checks.push({ name: "tests", success: false, error: error.message }); }
  } else {
    checks.push({ name: "tests", success: null, skipped: true, reason: "Tests are disabled in Read-Only mode." });
  }
  return JSON.stringify({ success: checks.every((item) => item.success !== false), cwd: root, checks, git_status: gitStatus(subPath) }, null, 2);
}

async function setWorkspace(targetPath) {
  if (readOnly) throw new Error("Changing workspace is disabled in Read-Only mode.");
  if (!targetPath) throw new Error("path parameter is required");
  const resolved = resolveTarget(targetPath);
  if (!isAllowed(resolved)) throw new Error("Target path is outside allowed directories.");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  activeCwd = resolved;
  await runtimeCall("workspace.set", runtimeOwner, { cwd: activeCwd }, 2500);
  runtimeWorkspaceLoaded = true;
  return `Active workspace CWD changed to: ${activeCwd}`;
}

function recycle(target, directory) {
  const resolved = resolveTarget(target);
  if (!isAllowed(resolved)) throw new Error("Path is outside the allowed directories.");
  if (process.platform === "win32") {
    const escapedType = directory ? "DeleteDirectory" : "DeleteFile";
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${escapedType}($env:MCP_DELETE_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    const completed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, MCP_DELETE_TARGET: resolved },
      encoding: "utf8",
      windowsHide: true,
    });
    if (completed.status !== 0) throw new Error((completed.stderr || "Recycle Bin operation failed").trim());
    return `Moved to Windows Recycle Bin: ${resolved}`;
  } else {
    // POSIX fallback
    if (directory) fs.rmSync(resolved, { recursive: true, force: true });
    else fs.unlinkSync(resolved);
    return `Deleted: ${resolved}`;
  }
}

function jsGrepSearch(query, dir, caseSensitive, isRegex, maxResults, filePattern) {
  const matches = [];
  let reg = null;
  if (isRegex) {
    try {
      reg = new RegExp(query, caseSensitive ? "g" : "gi");
    } catch (e) {
      throw new Error(`Invalid regex: ${e.message}`);
    }
  }
  const qLower = caseSensitive ? query : query.toLowerCase();

  function scan(currentDir) {
    if (matches.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) break;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          scan(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        if (filePattern && !matchSimplePattern(entry.name, filePattern)) continue;
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) break;
            const line = lines[i];
            let matched = false;
            let col = -1;
            if (reg) {
              reg.lastIndex = 0;
              const m = reg.exec(line);
              if (m) {
                matched = true;
                col = m.index + 1;
              }
            } else {
              const idx = caseSensitive ? line.indexOf(query) : line.toLowerCase().indexOf(qLower);
              if (idx !== -1) {
                matched = true;
                col = idx + 1;
              }
            }
            if (matched) {
              matches.push(`${fullPath}:${i + 1}:${col}: ${line.trim()}`);
            }
          }
        } catch {}
      }
    }
  }

  scan(dir);
  if (matches.length === 0) return "No matches found.";
  return `Found ${matches.length} match(es):\n\n` + matches.join("\n");
}

function grepSearch(query, subPath, caseSensitive = false, isRegex = false, maxResults = 50, filePattern = "") {
  if (!query) throw new Error("query parameter is required");
  const targetDir = subPath ? resolveTarget(subPath) : activeCwd;
  if (!isAllowed(targetDir)) throw new Error("Path is outside allowed directories.");

  const rgPath = process.platform === "win32" ? "rg.exe" : "rg";
  const rgArgs = [
    "--line-number",
    "--column",
    "--color=never",
    "--max-count", String(maxResults),
    "--hidden",
    "--glob", "!.git/*",
    "--glob", "!node_modules/*",
    "--glob", "!dist/*",
    "--glob", "!.next/*",
    "--glob", "!__pycache__/*",
    "--glob", "!.venv/*",
    "--glob", "!build/*",
    "--glob", "!.turbo/*",
  ];
  if (!caseSensitive) rgArgs.push("-i");
  if (!isRegex) rgArgs.push("-F");
  if (filePattern) rgArgs.push("--glob", filePattern);
  rgArgs.push(query, targetDir);

  try {
    const rgResult = spawnSync(rgPath, rgArgs, { encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    if (rgResult.status === 0 || (rgResult.status === 1 && rgResult.stdout !== undefined)) {
      const lines = (rgResult.stdout || "").trim().split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) return "No matches found.";
      return `Found ${lines.length} match(es):\n\n` + lines.slice(0, maxResults).join("\n");
    }
  } catch {}

  return jsGrepSearch(query, targetDir, caseSensitive, isRegex, maxResults, filePattern);
}

function getDirectoryTree(dirPath, maxDepth = 3, showFiles = true) {
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");

  const lines = [path.basename(root) + "/"];
  const depthLimit = Math.min(Math.max(1, maxDepth), 8);

  function buildTree(currentDir, prefix, depth) {
    if (depth > depthLimit) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    const filtered = entries.filter((e) => {
      if (e.isDirectory()) return !IGNORED_DIRS.has(e.name) && !e.name.startsWith(".");
      if (!showFiles) return false;
      const ext = path.extname(e.name).toLowerCase();
      return !BINARY_EXTS.has(ext);
    });

    filtered.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    filtered.forEach((entry, idx) => {
      const isLast = idx === filtered.length - 1;
      const pointer = isLast ? "└── " : "├── ";
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${prefix}${pointer}${entry.name}/`);
        buildTree(fullPath, prefix + (isLast ? "    " : "│   "), depth + 1);
      } else {
        lines.push(`${prefix}${pointer}${entry.name}`);
      }
    });
  }

  buildTree(root, "", 1);
  return lines.join("\n");
}

function readFileRange(targetPath, startLine, endLine) {
  if (!targetPath) throw new Error("path parameter is required");
  const resolved = resolveTarget(targetPath);
  if (!isAllowed(resolved)) throw new Error("Path is outside allowed directories.");
  if (!fs.existsSync(resolved)) throw new Error(`File does not exist: ${resolved}`);
  const content = fs.readFileSync(resolved, "utf8");
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const start = Math.max(1, startLine || 1);
  const end = Math.min(total, endLine || total);
  if (start > total) return `File: ${resolved} has only ${total} line(s).`;
  const numbered = lines.slice(start - 1, end).map((l, idx) => `${start + idx}\t${l}`);
  return `File: ${resolved} (lines ${start}-${end} of ${total})\n\n` + numbered.join("\n");
}

function gitStatus(dirPath) {
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  const res = spawnSync("git", ["status", "--short", "--branch"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0) {
    const err = (res.stderr || "").trim();
    if (err.includes("not a git repository")) {
      return "Not a Git repository. To enable Git tracking, run 'git init' in this workspace.";
    }
    return (err || "Not a git repository or git failed").trim();
  }
  return res.stdout.trim() || "Working tree clean (no changes).";
}

function gitDiff(dirPath, filePath, staged = false, stat = false) {
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  const gitArgs = ["diff"];
  if (staged) gitArgs.push("--staged");
  if (stat) gitArgs.push("--stat");
  if (filePath) {
    const resolvedFile = resolveTarget(filePath);
    if (!isAllowed(resolvedFile)) throw new Error("File path is outside allowed directories.");
    gitArgs.push("--", resolvedFile);
  }
  const res = spawnSync("git", gitArgs, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const err = (res.stderr || "").trim();
    if (err.includes("not a git repository")) {
      return "Not a Git repository. To enable Git tracking, run 'git init' in this workspace.";
    }
    return (err || "git diff failed").trim();
  }
  const output = res.stdout.trim();
  if (!output) return "No diff found (no changes).";
  if (output.length > 50000) {
    return output.slice(0, 50000) + "\n\n... <Diff output truncated at 50KB>";
  }
  return output;
}

function gitLog(dirPath, maxCount = 20, filePath) {
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  const count = Math.min(Math.max(1, maxCount || 20), 200);
  const gitArgs = ["log", `-${count}`, "--pretty=format:%h  %ad  %an: %s", "--date=short"];
  if (filePath) {
    const resolvedFile = resolveTarget(filePath);
    if (!isAllowed(resolvedFile)) throw new Error("File path is outside allowed directories.");
    gitArgs.push("--", resolvedFile);
  }
  const res = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
  if (res.status !== 0) {
    const err = (res.stderr || "").trim();
    if (err.includes("not a git repository")) {
      return "Not a Git repository. To enable Git tracking, run 'git init' in this workspace.";
    }
    return (err || "git log failed").trim();
  }
  return res.stdout.trim() || "No commits found.";
}

function gitAdd(dirPath, files) {
  if (readOnly) throw new Error("Git write operations are disabled in Read-Only mode.");
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  const gitArgs = ["add"];
  if (Array.isArray(files) && files.length > 0) {
    gitArgs.push(...files);
  } else {
    gitArgs.push("-A");
  }
  const res = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true });
  if (res.status !== 0) return (res.stderr || "git add failed").trim();
  return "Staged changes successfully.";
}

function gitCommit(dirPath, message, author) {
  if (readOnly) throw new Error("Git write operations are disabled in Read-Only mode.");
  if (!message || !message.trim()) throw new Error("message parameter is required");
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  const gitArgs = ["commit", "-m", message];
  if (author) gitArgs.push(`--author=${author}`);
  const res = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true });
  const output = ((res.stdout || "") + (res.stderr || "")).trim();
  if (res.status !== 0) return output || "git commit failed";
  return output || "Commit created.";
}

function gitBranch(dirPath, action = "list", name) {
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  if (action === "list") {
    const res = spawnSync("git", ["branch", "--list"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (res.status !== 0) return (res.stderr || "git branch failed").trim();
    return res.stdout.trim() || "No branches found.";
  }
  if (readOnly) throw new Error("Git write operations are disabled in Read-Only mode.");
  if (!name) throw new Error("name parameter is required for create/delete");
  const gitArgs = action === "delete" ? ["branch", "-D", name] : ["branch", name];
  const res = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true });
  if (res.status !== 0) return (res.stderr || `git branch ${action} failed`).trim();
  return `Branch ${action} succeeded: ${name}`;
}

function gitCheckout(dirPath, branch, create = false) {
  if (readOnly) throw new Error("Git write operations are disabled in Read-Only mode.");
  if (!branch) throw new Error("branch parameter is required");
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  const gitArgs = create ? ["checkout", "-b", branch] : ["checkout", branch];
  const res = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true });
  const output = ((res.stdout || "") + (res.stderr || "")).trim();
  if (res.status !== 0) return output || "git checkout failed";
  return output || `Switched to branch ${branch}`;
}

function gitStash(dirPath, action = "save", message) {
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  if (action !== "list" && readOnly) throw new Error("Git write operations are disabled in Read-Only mode.");
  let gitArgs;
  if (action === "pop") gitArgs = ["stash", "pop"];
  else if (action === "list") gitArgs = ["stash", "list"];
  else gitArgs = message ? ["stash", "save", message] : ["stash"];
  const res = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true });
  const output = ((res.stdout || "") + (res.stderr || "")).trim();
  if (res.status !== 0) return output || `git stash ${action} failed`;
  return output || `git stash ${action} done`;
}

function getGitRepoRoot(dirPath) {
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0) throw new Error((res.stderr || "Not a Git repository.").trim());
  let repoRoot = path.resolve(res.stdout.trim());
  const worktreeList = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (worktreeList.status === 0) {
    const mainLine = worktreeList.stdout.split(/\r?\n/).find((line) => line.startsWith("worktree "));
    if (mainLine) repoRoot = path.resolve(mainLine.slice("worktree ".length).trim());
  }
  if (!isAllowed(repoRoot)) throw new Error("Git repository root is outside allowed directories.");
  return repoRoot;
}

function getM1WorktreeRoot(repoRoot) {
  const worktreeRoot = path.join(repoRoot, ".m1-worktrees");
  if (!isAllowed(worktreeRoot)) throw new Error("M1 worktree storage is outside allowed directories.");
  return worktreeRoot;
}

function ensureM1WorktreeRoot(repoRoot) {
  const worktreeRoot = getM1WorktreeRoot(repoRoot);
  fs.mkdirSync(worktreeRoot, { recursive: true });

  // Keep agent worktrees out of the main worktree's untracked-file view without
  // modifying the repository's committed .gitignore.
  const commonDirResult = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (commonDirResult.status === 0) {
    const rawCommonDir = commonDirResult.stdout.trim();
    const commonDir = path.isAbsolute(rawCommonDir) ? rawCommonDir : path.resolve(repoRoot, rawCommonDir);
    const infoDir = path.join(commonDir, "info");
    const excludeFile = path.join(infoDir, "exclude");
    try {
      fs.mkdirSync(infoDir, { recursive: true });
      const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
      if (!existing.split(/\r?\n/).some((line) => line.trim() === ".m1-worktrees/")) {
        const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
        fs.appendFileSync(excludeFile, `${prefix}.m1-worktrees/\n`, "utf8");
      }
    } catch {}
  }
  return worktreeRoot;
}

function gitWorktreeList(dirPath) {
  const repoRoot = getGitRepoRoot(dirPath);
  const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (res.status !== 0) return (res.stderr || "git worktree list failed").trim();
  return res.stdout.trim() || "No Git worktrees found.";
}

async function gitWorktreeCreate(dirPath, branch, baseRef = "HEAD", activate = true) {
  if (readOnly) throw new Error("Git worktree creation is disabled in Read-Only mode.");
  if (!branch || !branch.trim()) throw new Error("branch parameter is required");
  const repoRoot = getGitRepoRoot(dirPath);
  const branchName = branch.trim();
  const validBranch = spawnSync("git", ["check-ref-format", "--branch", branchName], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  if (validBranch.status !== 0) throw new Error((validBranch.stderr || `Invalid branch name: ${branchName}`).trim());

  const worktreeRoot = ensureM1WorktreeRoot(repoRoot);
  const safeName = branchName.replace(/[^A-Za-z0-9._-]+/g, "_");
  const destination = path.join(worktreeRoot, safeName);
  if (fs.existsSync(destination)) throw new Error(`Worktree destination already exists: ${destination}`);

  const branchExists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: repoRoot, windowsHide: true }).status === 0;
  const gitArgs = branchExists
    ? ["worktree", "add", destination, branchName]
    : ["worktree", "add", "-b", branchName, destination, baseRef || "HEAD"];
  const res = spawnSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
  const output = ((res.stdout || "") + (res.stderr || "")).trim();
  if (res.status !== 0) throw new Error(output || "git worktree add failed");

  if (activate !== false) {
    activeCwd = destination;
    await runtimeCall("workspace.set", runtimeOwner, { cwd: activeCwd }, 2500);
    runtimeWorkspaceLoaded = true;
  }
  return `Worktree created:\nPath: ${destination}\nBranch: ${branchName}\nActivated: ${activate !== false}\n\n${output}`;
}

async function gitWorktreeRemove(dirPath, worktreePath, force = false, deleteBranch = false) {
  if (readOnly) throw new Error("Git worktree removal is disabled in Read-Only mode.");
  if (!worktreePath || !worktreePath.trim()) throw new Error("worktree_path parameter is required");
  const repoRoot = getGitRepoRoot(dirPath);
  const worktreeRoot = getM1WorktreeRoot(repoRoot);
  const target = path.isAbsolute(worktreePath) ? path.resolve(worktreePath) : path.resolve(repoRoot, worktreePath);
  const canonicalRoot = canonicalizeForContainment(worktreeRoot);
  const canonicalTarget = canonicalizeForContainment(target);
  if (!(canonicalTarget === canonicalRoot || canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`))) {
    throw new Error("Refusing to remove a worktree outside the managed .m1-worktrees directory.");
  }

  let branchName = "";
  if (fs.existsSync(target)) {
    const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: target, encoding: "utf8", windowsHide: true });
    if (branchResult.status === 0) branchName = branchResult.stdout.trim();
  }

  if (canonicalizeForContainment(activeCwd) === canonicalTarget || canonicalizeForContainment(activeCwd).startsWith(`${canonicalTarget}${path.sep}`)) {
    activeCwd = repoRoot;
    await runtimeCall("workspace.set", runtimeOwner, { cwd: activeCwd }, 2500);
    runtimeWorkspaceLoaded = true;
  }

  const gitArgs = ["worktree", "remove"];
  if (force) gitArgs.push("--force");
  gitArgs.push(target);
  const res = spawnSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
  const output = ((res.stdout || "") + (res.stderr || "")).trim();
  if (res.status !== 0) throw new Error(output || "git worktree remove failed");

  if (deleteBranch && branchName && branchName !== "HEAD") {
    const deleteResult = spawnSync("git", ["branch", "-D", branchName], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
    if (deleteResult.status !== 0) throw new Error((deleteResult.stderr || `Worktree removed, but failed to delete branch ${branchName}`).trim());
  }
  try {
    if (fs.existsSync(worktreeRoot) && fs.readdirSync(worktreeRoot).length === 0) fs.rmdirSync(worktreeRoot);
  } catch {}
  return `Worktree removed: ${target}${deleteBranch && branchName ? `\nBranch deleted: ${branchName}` : ""}`;
}

function createCheckpoint(dirPath, label) {
  if (readOnly) throw new Error("Checkpoints are disabled in Read-Only mode.");
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  const check = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (check.status !== 0) throw new Error("Not a git repository. Run 'git init' in this workspace before using checkpoints.");
  spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8", windowsHide: true });
  const msg = `checkpoint: ${label || new Date().toISOString()}`;
  const commitRes = spawnSync("git", ["commit", "--allow-empty", "-m", msg], { cwd: root, encoding: "utf8", windowsHide: true });
  if (commitRes.status !== 0) return (commitRes.stderr || "checkpoint commit failed").trim();
  const hashRes = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  const hash = hashRes.stdout.trim();
  return `Checkpoint created: ${hash} (${msg})`;
}

function rollbackCheckpoint(dirPath, ref) {
  if (readOnly) throw new Error("Rollback is disabled in Read-Only mode.");
  if (!ref || !ref.trim()) throw new Error("ref parameter is required (a commit hash from create_checkpoint or git_log)");
  const root = dirPath ? resolveTarget(dirPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");
  const res = spawnSync("git", ["reset", "--hard", ref.trim()], { cwd: root, encoding: "utf8", windowsHide: true });
  const output = ((res.stdout || "") + (res.stderr || "")).trim();
  if (res.status !== 0) return output || "rollback failed";
  return output || `Rolled back to ${ref}`;
}

function runCommand(command, cwdPath, timeoutSeconds = 60) {
  if (readOnly) throw new Error("Command execution is disabled in Read-Only mode.");
  if (!command || !command.trim()) throw new Error("command parameter is required");
  const execDir = cwdPath ? resolveTarget(cwdPath) : activeCwd;
  if (!isAllowed(execDir)) throw new Error("Working directory is outside allowed directories.");

  const timeoutMs = Math.min(Math.max(1, timeoutSeconds), 300) * 1000;
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const shellArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];

  const startTime = Date.now();
  const completed = spawnSync(shell, shellArgs, {
    cwd: execDir,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  const stdout = (completed.stdout || "").trim();
  const stderr = (completed.stderr || "").trim();

  if (completed.error && completed.error.code === "ETIMEDOUT") {
    return `[TIMEOUT] Command timed out after ${timeoutSeconds}s.\n\nStdout:\n${stdout}\n\nStderr:\n${stderr}`;
  }

  let fullOutput = "";
  if (stdout) fullOutput += `--- Stdout ---\n${stdout}\n`;
  if (stderr) fullOutput += `--- Stderr ---\n${stderr}\n`;
  if (!fullOutput) fullOutput = "(No output produced)\n";

  if (fullOutput.length > 50000) {
    fullOutput = fullOutput.slice(0, 50000) + "\n... <Output truncated at 50KB>";
  }

  const exitCode = completed.status !== null ? completed.status : 1;
  return `Exit Code: ${exitCode} (${durationSec}s)\n\n${fullOutput}`;
}

// ---- Cross-bridge persistent runtime wrappers ----
// Supergateway/MCP hosts may recreate the stdio bridge between tool calls.
// These wrappers keep live processes and terminals in a separate local daemon
// so a session survives transport/session churn.

async function persistentStartProcess(command, cwdPath) {
  if (readOnly) throw new Error("Starting processes is disabled in Read-Only mode.");
  if (!command || !command.trim()) throw new Error("command parameter is required");
  const execDir = cwdPath ? resolveTarget(cwdPath) : activeCwd;
  if (!isAllowed(execDir)) throw new Error("Working directory is outside allowed directories.");
  return runtimeCall("process.start", runtimeOwner, { command, cwd: execDir }, 5000);
}

async function persistentReadProcessOutput(id, clear = false) {
  if (!id) throw new Error("id parameter is required");
  return runtimeCall("process.read", runtimeOwner, { id: String(id), clear }, 5000);
}

async function persistentWriteProcessInput(id, text) {
  if (readOnly) throw new Error("Writing process input is disabled in Read-Only mode.");
  if (!id) throw new Error("id parameter is required");
  return runtimeCall("process.input", runtimeOwner, { id: String(id), text: text || "" }, 5000);
}

async function persistentWaitProcess(id, timeoutSeconds = 60) {
  if (!id) throw new Error("id parameter is required");
  const bounded = Math.min(Math.max(1, Number(timeoutSeconds) || 60), 300);
  return runtimeCall("process.wait", runtimeOwner, { id: String(id), timeoutSeconds: bounded }, (bounded + 5) * 1000);
}

async function persistentStopProcess(id) {
  if (readOnly) throw new Error("Stopping processes is disabled in Read-Only mode.");
  if (!id) throw new Error("id parameter is required");
  return runtimeCall("process.stop", runtimeOwner, { id: String(id) }, 5000);
}

async function persistentListProcesses() {
  return runtimeCall("process.list", runtimeOwner, {}, 5000);
}

async function persistentCreateTerminal(cwdPath, shellType) {
  if (readOnly) throw new Error("Creating terminals is disabled in Read-Only mode.");
  const execDir = cwdPath ? resolveTarget(cwdPath) : activeCwd;
  if (!isAllowed(execDir)) throw new Error("Working directory is outside allowed directories.");
  return runtimeCall("terminal.create", runtimeOwner, { cwd: execDir, shell: shellType || "" }, 5000);
}

async function persistentExecTerminal(id, command, timeoutSeconds = 60) {
  if (readOnly) throw new Error("Executing in terminal is disabled in Read-Only mode.");
  if (!id) throw new Error("id parameter is required");
  if (!command || !command.trim()) throw new Error("command parameter is required");
  const bounded = Math.min(Math.max(1, Number(timeoutSeconds) || 60), 300);
  return runtimeCall("terminal.exec", runtimeOwner, { id: String(id), command, timeoutSeconds: bounded }, (bounded + 5) * 1000);
}

async function persistentReadTerminal(id, clear = false) {
  if (!id) throw new Error("id parameter is required");
  return runtimeCall("terminal.read", runtimeOwner, { id: String(id), clear }, 5000);
}

async function persistentSendTerminalInput(id, text, sendEnter = true, sendSigInt = false) {
  if (readOnly) throw new Error("Sending terminal input is disabled in Read-Only mode.");
  if (!id) throw new Error("id parameter is required");
  return runtimeCall("terminal.input", runtimeOwner, { id: String(id), text: text || "", sendEnter, sigint: sendSigInt }, 5000);
}

async function persistentCloseTerminal(id) {
  if (readOnly) throw new Error("Closing terminals is disabled in Read-Only mode.");
  if (!id) throw new Error("id parameter is required");
  return runtimeCall("terminal.close", runtimeOwner, { id: String(id) }, 5000);
}

async function persistentListTerminals() {
  return runtimeCall("terminal.list", runtimeOwner, {}, 5000);
}

// ---- Structured Test Runner & Diagnostics ----

function runTests(subPath, testCommand) {
  if (readOnly) throw new Error("Running tests is disabled in Read-Only mode.");
  const root = subPath ? resolveTarget(subPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");

  let cmd = testCommand;
  if (!cmd) {
    if (fs.existsSync(path.join(root, "package.json"))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        if (pkg.scripts?.test) cmd = "npm test";
      } catch {}
    }
    if (!cmd && (fs.existsSync(path.join(root, "pytest.ini")) || fs.existsSync(path.join(root, "tests")))) {
      cmd = "pytest";
    }
    if (!cmd && fs.existsSync(path.join(root, "Cargo.toml"))) {
      cmd = "cargo test";
    }
    if (!cmd && fs.existsSync(path.join(root, "go.mod"))) {
      cmd = "go test ./...";
    }
    if (!cmd) cmd = "npm test";
  }

  const rawResult = runCommand(cmd, root, 120);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let exitCode = 0;

  const exitMatch = rawResult.match(/Exit Code: (\d+)/);
  if (exitMatch) exitCode = parseInt(exitMatch[1], 10);

  const jestMatch = rawResult.match(/Tests:\s+.*?(?:(\d+)\s+failed)?.*?(?:(\d+)\s+passed)?.*?(?:(\d+)\s+skipped)?/i);
  if (jestMatch) {
    if (jestMatch[1]) failed = parseInt(jestMatch[1], 10);
    if (jestMatch[2]) passed = parseInt(jestMatch[2], 10);
    if (jestMatch[3]) skipped = parseInt(jestMatch[3], 10);
  }

  const pytestMatch = rawResult.match(/(\d+)\s+passed/i);
  if (pytestMatch && !passed) passed = parseInt(pytestMatch[1], 10);
  const pytestFailMatch = rawResult.match(/(\d+)\s+failed/i);
  if (pytestFailMatch && !failed) failed = parseInt(pytestFailMatch[1], 10);

  const unittestMatch = rawResult.match(/Ran (\d+) tests/i);
  if (unittestMatch) {
    const total = parseInt(unittestMatch[1], 10);
    if (rawResult.includes("OK")) {
      passed = total;
      failed = 0;
    } else {
      failed = exitCode !== 0 ? 1 : 0;
      passed = Math.max(0, total - failed);
    }
  }

  const summary = `Tests Summary: ${passed} passed, ${failed} failed, ${skipped} skipped (Exit code: ${exitCode})`;
  return JSON.stringify({
    command: cmd,
    cwd: root,
    exit_code: exitCode,
    passed,
    failed,
    skipped,
    success: exitCode === 0,
    summary,
    output: rawResult,
  }, null, 2);
}

function getDiagnostics(subPath, tool) {
  const root = subPath ? resolveTarget(subPath) : activeCwd;
  if (!isAllowed(root)) throw new Error("Path is outside allowed directories.");

  let chosenTool = tool;
  if (!chosenTool) {
    if (fs.existsSync(path.join(root, "tsconfig.json"))) chosenTool = "tsc";
    else if (fs.existsSync(path.join(root, "package.json"))) chosenTool = "eslint";
    else if (fs.existsSync(path.join(root, "requirements.txt")) || fs.existsSync(path.join(root, "pyproject.toml"))) chosenTool = "python";
    else chosenTool = "tsc";
  }

  let cmd = "";
  if (chosenTool === "tsc") {
    cmd = "npx tsc --noEmit --pretty false";
  } else if (chosenTool === "eslint") {
    cmd = "npx eslint . --format json";
  } else if (chosenTool === "python") {
    cmd = 'python -c "import compileall; compileall.compile_dir(\'.\', force=True, quiet=1)"';
  } else {
    cmd = chosenTool;
  }

  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const shellArgs = process.platform === "win32" ? ["-NoProfile", "-Command", cmd] : ["-c", cmd];
  const res = spawnSync(shell, shellArgs, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60000 });
  const rawOut = ((res.stdout || "") + "\n" + (res.stderr || "")).trim();

  const diagnostics = [];

  const tscRegex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z0-9]+):\s+(.+)$/gm;
  let match;
  while ((match = tscRegex.exec(rawOut)) !== null) {
    diagnostics.push({
      file: match[1].trim(),
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      severity: match[4].toLowerCase(),
      code: match[5],
      message: match[6].trim(),
    });
  }

  if (chosenTool === "eslint") {
    try {
      const parsed = JSON.parse(res.stdout || "[]");
      if (Array.isArray(parsed)) {
        for (const fileItem of parsed) {
          for (const msg of fileItem.messages || []) {
            diagnostics.push({
              file: fileItem.filePath,
              line: msg.line,
              column: msg.column,
              severity: msg.severity === 2 ? "error" : "warning",
              code: msg.ruleId,
              message: msg.message,
            });
          }
        }
      }
    } catch {}
  }

  return JSON.stringify({
    tool: chosenTool,
    cwd: root,
    exit_code: res.status ?? 0,
    total_errors: diagnostics.filter((d) => d.severity === "error").length,
    total_warnings: diagnostics.filter((d) => d.severity === "warning").length,
    diagnostics,
    raw_output: diagnostics.length === 0 ? (rawOut || "No diagnostics errors reported.") : undefined,
  }, null, 2);
}

// ---- apply_patch: 100% Atomic 2-Phase Unified Diff Application ----

function parseUnifiedDiff(patchText) {
  const fileDiffs = [];
  const lines = patchText.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("--- ")) {
      const oldLine = lines[i];
      const newLine = lines[i + 1] && lines[i + 1].startsWith("+++ ") ? lines[i + 1] : null;
      if (!newLine) {
        i++;
        continue;
      }
      let oldPath = oldLine.slice(4).trim().split("\t")[0];
      let newPath = newLine.slice(4).trim().split("\t")[0];
      oldPath = oldPath.replace(/^a\//, "");
      newPath = newPath.replace(/^b\//, "");
      i += 2;
      const hunks = [];
      while (i < lines.length && lines[i].startsWith("@@")) {
        const headerMatch = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        i++;
        const hunkLines = [];
        while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("--- ")) {
          if (lines[i].startsWith("\\")) {
            i++;
            continue;
          }
          hunkLines.push(lines[i]);
          i++;
        }
        hunks.push({ header: headerMatch, lines: hunkLines });
      }
      fileDiffs.push({ oldPath, newPath, hunks });
    } else {
      i++;
    }
  }
  return fileDiffs;
}

function findSequence(fileLines, searchLines, hint) {
  const tryAt = (idx) => {
    if (idx < 0 || idx + searchLines.length > fileLines.length) return false;
    for (let k = 0; k < searchLines.length; k++) {
      if (fileLines[idx + k] !== searchLines[k]) return false;
    }
    return true;
  };
  if (tryAt(hint)) return hint;
  for (let offset = 1; offset <= 100; offset++) {
    if (tryAt(hint - offset)) return hint - offset;
    if (tryAt(hint + offset)) return hint + offset;
  }
  for (let idx = 0; idx <= fileLines.length - searchLines.length; idx++) {
    if (tryAt(idx)) return idx;
  }
  return -1;
}

function applyHunk(fileLines, hunk, filename) {
  const searchLines = [];
  const replaceLines = [];
  for (const line of hunk.lines) {
    const prefix = line[0] || " ";
    const text = line.slice(1);
    if (prefix === " ") {
      searchLines.push(text);
      replaceLines.push(text);
    } else if (prefix === "-") {
      searchLines.push(text);
    } else if (prefix === "+") {
      replaceLines.push(text);
    }
  }
  if (searchLines.length === 0) {
    return [...fileLines, ...replaceLines];
  }
  const startHint = hunk.header ? Math.max(0, parseInt(hunk.header[1], 10) - 1) : 0;
  const matchIndex = findSequence(fileLines, searchLines, startHint);
  if (matchIndex === -1) {
    throw new Error(`Could not apply hunk to ${filename}: context not found near:\n${searchLines.slice(0, 5).join("\n")}`);
  }
  return [...fileLines.slice(0, matchIndex), ...replaceLines, ...fileLines.slice(matchIndex + searchLines.length)];
}

function applyPatch(patchText) {
  if (readOnly) throw new Error("Patch application is disabled in Read-Only mode.");
  if (!patchText || !patchText.trim()) throw new Error("patch parameter (unified diff text) is required");
  const fileDiffs = parseUnifiedDiff(patchText);
  if (fileDiffs.length === 0) throw new Error("No valid unified-diff file sections found. Expected '--- a/path' / '+++ b/path' / '@@ ... @@' format.");

  // PHASE 1: Validate all hunks and simulate changes in-memory
  const pendingActions = [];

  for (const diff of fileDiffs) {
    const isDelete = diff.newPath === "/dev/null";
    const isCreate = diff.oldPath === "/dev/null";
    const targetRel = isDelete ? diff.oldPath : diff.newPath;
    const resolved = resolveTarget(targetRel);
    if (!isAllowed(resolved)) throw new Error(`Path outside allowed directories: ${targetRel}`);

    if (isDelete) {
      if (!fs.existsSync(resolved)) throw new Error(`File to delete does not exist: ${targetRel}`);
      pendingActions.push({ type: "delete", targetRel, resolved });
      continue;
    }

    let content = "";
    let isCrlf = false;
    if (!isCreate) {
      if (!fs.existsSync(resolved)) throw new Error(`File to patch does not exist: ${targetRel}`);
      content = fs.readFileSync(resolved, "utf8");
      isCrlf = content.includes("\r\n");
    }
    let fileLines = isCreate ? [] : content.replace(/\r\n/g, "\n").split("\n");

    for (const hunk of diff.hunks) {
      fileLines = applyHunk(fileLines, hunk, targetRel);
    }

    let newContent = fileLines.join("\n");
    if (isCrlf) newContent = newContent.replace(/\n/g, "\r\n");

    pendingActions.push({
      type: isCreate ? "create" : "modify",
      targetRel,
      resolved,
      content: newContent,
      hunkCount: diff.hunks.length,
    });
  }

  // PHASE 2: All hunks verified. Commit the filesystem mutation as a rollback-safe
  // transaction: snapshot existing files, perform every action, and restore the
  // snapshot if any individual disk operation fails.
  const snapshots = [];
  const stagedDeletes = [];
  try {
    for (const action of pendingActions) {
      if (fs.existsSync(action.resolved)) {
        snapshots.push({ resolved: action.resolved, existed: true, content: fs.readFileSync(action.resolved), mode: fs.statSync(action.resolved).mode });
      } else {
        snapshots.push({ resolved: action.resolved, existed: false });
      }
    }

    const summary = [];
    for (const action of pendingActions) {
      if (action.type === "delete") {
        const backupPath = `${action.resolved}.m1-delete-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        fs.renameSync(action.resolved, backupPath);
        stagedDeletes.push({ action, backupPath });
      } else {
        const parentDir = path.dirname(action.resolved);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
        const tempPath = `${action.resolved}.m1-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          fs.writeFileSync(tempPath, action.content, "utf8");
          fs.renameSync(tempPath, action.resolved);
        } finally {
          try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
        }
        summary.push(`${action.type === "create" ? "Created" : "Patched"}: ${action.targetRel} (${action.hunkCount} hunk(s))`);
      }
    }

    // Only after every write has succeeded do we send staged deletions to the
    // Recycle Bin. If this final cleanup fails, the catch block can restore them.
    for (const { action, backupPath } of stagedDeletes) {
      recycle(backupPath, false);
      summary.push(`Deleted: ${action.targetRel}`);
    }

    return `Atomic patch applied successfully (${pendingActions.length} file(s)):\n` + summary.join("\n");
  } catch (error) {
    // Best-effort transaction rollback. This preserves the pre-patch state even
    // when a later disk operation fails (for example permissions or a locked file).
    for (const staged of stagedDeletes.reverse()) {
      try {
        if (fs.existsSync(staged.backupPath) && !fs.existsSync(staged.action.resolved)) {
          fs.renameSync(staged.backupPath, staged.action.resolved);
        }
      } catch {}
    }
    for (const snapshot of snapshots.reverse()) {
      try {
        if (snapshot.existed) {
          const parentDir = path.dirname(snapshot.resolved);
          if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
          fs.writeFileSync(snapshot.resolved, snapshot.content);
        } else if (fs.existsSync(snapshot.resolved)) {
          if (fs.statSync(snapshot.resolved).isDirectory()) fs.rmSync(snapshot.resolved, { recursive: true, force: true });
          else fs.unlinkSync(snapshot.resolved);
        }
      } catch {}
    }
    throw new Error(`Atomic patch transaction rolled back: ${error.message}`);
  }
}

function resilientEditFile(targetPath, edits, oldTextParam, newTextParam) {
  if (readOnly) throw new Error("Edit operations are disabled in Read-Only mode");
  const resolved = resolveTarget(targetPath);
  if (!isAllowed(resolved)) throw new Error("Path is outside allowed directories.");
  if (!fs.existsSync(resolved)) throw new Error(`File does not exist: ${resolved}`);

  let content = fs.readFileSync(resolved, "utf8");
  const isCrlf = content.includes("\r\n");

  let normalizedEdits = [];
  if (Array.isArray(edits)) {
    normalizedEdits = edits;
  } else if (typeof edits === "object" && edits !== null) {
    normalizedEdits = [edits];
  } else if (oldTextParam !== undefined || newTextParam !== undefined) {
    normalizedEdits = [{ oldText: oldTextParam, newText: newTextParam }];
  }

  if (normalizedEdits.length === 0) {
    throw new Error("edits array or oldText/newText is required");
  }

  let appliedCount = 0;
  for (const edit of normalizedEdits) {
    const oldText = edit.oldText ?? edit.old_text ?? edit.find ?? "";
    const newText = edit.newText ?? edit.new_text ?? edit.replace ?? "";
    if (!oldText) continue;

    if (content.includes(oldText)) {
      content = content.replace(oldText, newText);
      appliedCount++;
      continue;
    }

    const normContent = content.replace(/\r\n/g, "\n");
    const normOld = oldText.replace(/\r\n/g, "\n");
    const normNew = newText.replace(/\r\n/g, "\n");

    if (normContent.includes(normOld)) {
      let replaced = normContent.replace(normOld, normNew);
      if (isCrlf) replaced = replaced.replace(/\n/g, "\r\n");
      content = replaced;
      appliedCount++;
      continue;
    }

    const trimmedOld = normOld.trim();
    const idx = normContent.indexOf(trimmedOld);
    if (idx !== -1 && trimmedOld.length > 10) {
      let replaced = normContent.substring(0, idx) + normNew + normContent.substring(idx + trimmedOld.length);
      if (isCrlf) replaced = replaced.replace(/\n/g, "\r\n");
      content = replaced;
      appliedCount++;
      continue;
    }

    throw new Error(`Could not find exact match for edit in ${path.basename(resolved)}:\n${oldText.slice(0, 200)}`);
  }

  fs.writeFileSync(resolved, content, "utf8");
  return `Successfully applied ${appliedCount} edit(s) to ${resolved}`;
}

const CUSTOM_TOOLS = [
  {
    name: "project_summary",
    description: "Compact coding-agent summary of the current project. Use first when starting work on an unfamiliar repository.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_search",
    description: "Search project code/text and return concise file:line matches. Use this before broad file reads.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, max_results: { type: "number" }, file_pattern: { type: "string" } }, required: ["query"] },
  },
  {
    name: "verify",
    description: "Run diagnostics and, when write-enabled, tests. Use after meaningful edits before claiming completion.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "get_workspace",
    description: "Get full context of the active workspace: root directory, active CWD, project type (Next.js/React/Python/Rust/Go), Git repository status, current branch, and platform.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "grep_search",
    description: "Fast code search across workspace files. Searches for literal text or regex, skipping node_modules, .git, dist, and binaries.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or regex pattern" },
        path: { type: "string", description: "Optional subfolder or file path to search inside" },
        case_sensitive: { type: "boolean", description: "Whether to perform case-sensitive search (default false)" },
        is_regex: { type: "boolean", description: "Whether query is a regex pattern (default false)" },
        max_results: { type: "number", description: "Maximum number of matches to return (default 50)" },
        file_pattern: { type: "string", description: "Optional glob pattern to filter files (e.g. *.ts, *.py)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_directory_tree",
    description: "Get a clean, token-efficient directory tree of the workspace, automatically filtering out noise (node_modules, .git, .next, dist, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional directory path (defaults to active CWD)" },
        max_depth: { type: "number", description: "Maximum directory traversal depth (default 3, max 8)" },
        show_files: { type: "boolean", description: "Whether to include file names in the tree (default true)" },
      },
    },
  },
  {
    name: "read_file_range",
    description: "Read a specific line range of a file with line numbers, without loading the whole file into context. Useful for large files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" },
        start_line: { type: "number", description: "First line to read (1-based, default 1)" },
        end_line: { type: "number", description: "Last line to read (default: end of file)" },
      },
      required: ["path"],
    },
  },
  {
    name: "git_status",
    description: "Get Git repository status (modified, staged, untracked files and current branch).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional project folder path" },
      },
    },
  },
  {
    name: "git_diff",
    description: "Get Git diff showing current uncommitted or staged changes in unified-diff format.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional project folder path" },
        file_path: { type: "string", description: "Optional specific file to view diff for" },
        staged: { type: "boolean", description: "Whether to show staged diff (default false)" },
        stat: { type: "boolean", description: "Whether to show diffstat summary (default false)" },
      },
    },
  },
  {
    name: "git_log",
    description: "Show recent Git commit history (hash, date, author, message).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional project folder path" },
        max_count: { type: "number", description: "Maximum number of commits to show (default 20, max 200)" },
        file_path: { type: "string", description: "Optional: only show commits touching this file" },
      },
    },
  },
  {
    name: "git_worktree_list",
    description: "List Git worktrees for the repository in porcelain format. Safe for read-only inspection.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional repository or worktree path" },
      },
    },
  },
  {
    name: "read_process_output",
    description: "Read accumulated stdout/stderr and status of a background process previously started with start_process.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Process id returned by start_process" },
        clear: { type: "boolean", description: "If true, clear the buffered output after reading (default false)" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_processes",
    description: "List all background processes started with start_process, with their status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_terminal",
    description: "Read accumulated output from a persistent interactive terminal session.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Terminal session id returned by create_terminal" },
        clear: { type: "boolean", description: "If true, clear the buffered output after reading (default false)" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_terminals",
    description: "List all active persistent terminal sessions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_diagnostics",
    description: "Run compiler/linter diagnostics (TypeScript tsc, ESLint, Python py_compile) and get structured errors (file, line, column, severity, code, message).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional subfolder path (defaults to active CWD)" },
        tool: { type: "string", enum: ["tsc", "eslint", "python"], description: "Tool to run (auto-detected if omitted)" },
      },
    },
  },
];

const WRITE_CUSTOM_TOOLS = [
  {
    name: "set_workspace",
    description: "Change the active working directory (CWD) to a subfolder within the allowed workspace. Subsequent relative commands will execute in this CWD.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target directory path to switch to" },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_file",
    description: "Move a file to the Windows Recycle Bin. Only available in Full Access mode.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "delete_directory",
    description: "Move a directory and its contents to the Windows Recycle Bin. Only available in Full Access mode.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "run_command",
    description: "Execute a shell command inside the workspace directory and wait for it to finish (e.g. build, test, lint, typecheck).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line string to execute" },
        path: { type: "string", description: "Optional working directory inside the workspace" },
        timeout_seconds: { type: "number", description: "Timeout in seconds (default 60, max 300)" },
      },
      required: ["command"],
    },
  },
  {
    name: "create_terminal",
    description: "Create a persistent interactive terminal session (PowerShell or Bash) that retains shell state, CWD, environment variables, and virtualenvs across commands.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Initial working directory (defaults to active CWD)" },
        shell: { type: "string", description: "Optional shell to use (powershell.exe, cmd.exe, /bin/sh, /bin/zsh)" },
      },
    },
  },
  {
    name: "exec_terminal",
    description: "Execute a command inside an existing persistent terminal session, preserving shell state and returning output.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Terminal session id" },
        command: { type: "string", description: "Command to execute in the terminal" },
        timeout_seconds: { type: "number", description: "Timeout in seconds (default 60)" },
      },
      required: ["id", "command"],
    },
  },
  {
    name: "send_terminal_input",
    description: "Send raw text, Enter, or Ctrl+C signal to an interactive terminal session.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Terminal session id" },
        text: { type: "string", description: "Text input to send" },
        send_enter: { type: "boolean", description: "Whether to append a newline (default true)" },
        sigint: { type: "boolean", description: "If true, send Ctrl+C signal to abort current program (default false)" },
      },
      required: ["id"],
    },
  },
  {
    name: "close_terminal",
    description: "Close an active persistent terminal session.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Terminal session id to close" },
      },
      required: ["id"],
    },
  },
  {
    name: "start_process",
    description: "Start a long-running background process (dev server, watcher, background job) without blocking. Returns a process id.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line string to execute" },
        path: { type: "string", description: "Optional working directory inside the workspace" },
      },
      required: ["command"],
    },
  },
  {
    name: "write_process_input",
    description: "Send stdin input to a running background process.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Process id" },
        text: { type: "string", description: "Text to write to stdin" },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "wait_process",
    description: "Wait for a background process to finish execution (up to timeout) and get its exit code and output.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Process id" },
        timeout_seconds: { type: "number", description: "Timeout in seconds (default 60)" },
      },
      required: ["id"],
    },
  },
  {
    name: "stop_process",
    description: "Stop a background process previously started with start_process.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "run_tests",
    description: "Run automated test suites and return structured JSON (passed, failed, skipped, exit_code, failures summary). Auto-detects pytest, npm test, vitest, jest, cargo test, or go test.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional working directory" },
        command: { type: "string", description: "Optional explicit test command override" },
      },
    },
  },
  {
    name: "apply_patch",
    description: "Apply a unified diff atomically across one or many files. All hunks are pre-validated in memory before writing to disk, ensuring zero partial corruption. Supports file creation and deletion.",
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Unified diff text covering one or more files" },
      },
      required: ["patch"],
    },
  },
  {
    name: "git_add",
    description: "Stage files for commit (git add). Stages all changes by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional project folder path" },
        files: { type: "array", items: { type: "string" }, description: "Optional list of specific file paths/patterns to stage; defaults to all changes" },
      },
    },
  },
  {
    name: "git_commit",
    description: "Create a Git commit from currently staged changes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional project folder path" },
        message: { type: "string", description: "Commit message" },
        author: { type: "string", description: "Optional author override, e.g. 'Name <email>'" },
      },
      required: ["message"],
    },
  },
  {
    name: "git_branch",
    description: "List, create, or delete Git branches.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional project folder path" },
        action: { type: "string", enum: ["list", "create", "delete"], description: "Action to perform (default list)" },
        name: { type: "string", description: "Branch name, required for create/delete" },
      },
    },
  },
  {
    name: "git_checkout",
    description: "Switch to a Git branch, optionally creating it first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional project folder path" },
        branch: { type: "string", description: "Branch name to switch to" },
        create: { type: "boolean", description: "Create the branch if it does not exist (default false)" },
      },
      required: ["branch"],
    },
  },
  {
    name: "git_stash",
    description: "Save, pop, or list the Git stash.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional project folder path" },
        action: { type: "string", enum: ["save", "pop", "list"], description: "Action to perform (default save)" },
        message: { type: "string", description: "Optional message for 'save'" },
      },
    },
  },
  {
    name: "git_worktree_create",
    description: "Create an isolated Git worktree under .m1-worktrees, optionally activate it as the current workspace, and create the branch when needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional repository or worktree path" },
        branch: { type: "string", description: "Branch name for the isolated worktree" },
        base_ref: { type: "string", description: "Base ref when creating a new branch (default HEAD)" },
        activate: { type: "boolean", description: "Activate the new worktree as current workspace (default true)" },
      },
      required: ["branch"],
    },
  },
  {
    name: "git_worktree_remove",
    description: "Remove a worktree managed under .m1-worktrees. Refuses to remove arbitrary external worktree paths.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional repository or worktree path" },
        worktree_path: { type: "string", description: "Managed worktree path to remove" },
        force: { type: "boolean", description: "Force removal when the worktree is dirty (default false)" },
        delete_branch: { type: "boolean", description: "Delete the worktree branch after removal (default false)" },
      },
      required: ["worktree_path"],
    },
  },
  {
    name: "create_checkpoint",
    description: "Create a safety checkpoint by staging and committing all current changes (git commit --allow-empty). Returns a commit hash you can pass to rollback_checkpoint to undo later changes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional project folder path" },
        label: { type: "string", description: "Optional label describing this checkpoint" },
      },
    },
  },
  {
    name: "rollback_checkpoint",
    description: "Hard-reset the working tree to a previous commit hash (from create_checkpoint or git_log). Discards all uncommitted and committed changes after that point.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional project folder path" },
        ref: { type: "string", description: "Commit hash to roll back to" },
      },
      required: ["ref"],
    },
  },
];

const childLines = readline.createInterface({ input: child.stdout });
childLines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (pendingInitialize.has(message.id) && message.result) {
      pendingInitialize.delete(message.id);
      message.result.instructions = [message.result.instructions, buildAgentInstructions()].filter(Boolean).join("\n\n");
    }
    if (pendingToolsList.has(message.id) && message.result?.tools) {
      pendingToolsList.delete(message.id);
      const existingTools = message.result.tools;
      existingTools.forEach(annotateTool);
      const toolNames = new Set(existingTools.map((t) => t.name));

      for (const tool of CUSTOM_TOOLS) {
        if (!toolNames.has(tool.name)) {
          existingTools.push(annotateTool(tool));
        }
      }

      if (!readOnly) {
        for (const tool of WRITE_CUSTOM_TOOLS) {
          if (!toolNames.has(tool.name)) {
            existingTools.push(annotateTool(tool));
          }
        }
      }
    }
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    process.stdout.write(`${line}\n`);
  }
});

const ALL_KNOWN_TOOLS = new Set([
  "read_file", "read_text_file", "read_media_file", "read_multiple_files",
  "write_file", "edit_file", "create_directory", "list_directory",
  "list_directory_with_sizes", "directory_tree", "move_file", "search_files",
  "get_file_info", "list_allowed_directories", "get_workspace", "set_workspace",
  "grep_search", "get_directory_tree", "read_file_range", "git_status",
  "git_diff", "git_log", "read_process_output", "write_process_input",
  "wait_process", "list_processes", "start_process", "stop_process",
  "create_terminal", "exec_terminal", "read_terminal", "send_terminal_input",
  "close_terminal", "list_terminals", "run_tests", "get_diagnostics",
  "delete_file", "delete_directory", "run_command", "apply_patch",
  "git_add", "git_commit", "git_branch", "git_checkout", "git_stash",
  "git_worktree_list", "git_worktree_create", "git_worktree_remove", "project_summary", "project_search", "verify",
  "create_checkpoint", "rollback_checkpoint",
]);

const inputLines = readline.createInterface({ input: process.stdin });
inputLines.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    child.stdin.write(`${line}\n`);
    return;
  }

  if (message.method === "initialize") {
    pendingInitialize.add(message.id);
    child.stdin.write(`${line}\n`);
    return;
  }

  if (message.method === "tools/list") {
    pendingToolsList.add(message.id);
    child.stdin.write(`${line}\n`);
    return;
  }

  if (message.method === "tools/call") {
    await restoreRuntimeWorkspace();

    let rawToolName = message.params?.name || "";
    let toolName = rawToolName;

    if (!ALL_KNOWN_TOOLS.has(toolName)) {
      for (const known of ALL_KNOWN_TOOLS) {
        if (
          rawToolName.endsWith(`.${known}`) ||
          rawToolName.endsWith(`:${known}`) ||
          rawToolName.endsWith(`/${known}`) ||
          rawToolName.endsWith(`_${known}`)
        ) {
          toolName = known;
          if (message.params) message.params.name = known;
          break;
        }
      }
    }

    const toolArgs = message.params?.arguments || {};

    // Enforce Read-Only at the bridge boundary as well as at the public gateway.
    // The upstream filesystem MCP server is still a full-access process, so hiding
    // write tools from tools/list is not sufficient: a client can attempt a direct
    // tools/call by name. Block every known mutating tool before it reaches child.
    if (readOnly && WRITE_TOOL_HINTS.has(toolName)) {
      process.stdout.write(`${JSON.stringify(result(message.id, `Tool '${toolName}' is disabled in Read-Only mode`, true))}\n`);
      return;
    }

    const pathError = validateRequestedPaths(toolName, toolArgs);
    if (pathError) {
      process.stdout.write(`${JSON.stringify(result(message.id, pathError, true))}\n`);
      return;
    }

    if (toolName === "project_summary") {
      try { process.stdout.write(`${JSON.stringify(result(message.id, getProjectSummary()))}\n`); }
      catch (error) { process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`); }
      return;
    }

    if (toolName === "project_search") {
      try { process.stdout.write(`${JSON.stringify(result(message.id, projectSearch(toolArgs.query, toolArgs.path, toolArgs.max_results, toolArgs.file_pattern || "")))}\n`); }
      catch (error) { process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`); }
      return;
    }

    if (toolName === "verify") {
      try { process.stdout.write(`${JSON.stringify(result(message.id, verifyWorkspace(toolArgs.path)))}\n`); }
      catch (error) { process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`); }
      return;
    }

    if (toolName === "get_workspace") {
      try {
        const text = getWorkspace();
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "set_workspace") {
      try {
        const text = await setWorkspace(toolArgs.path);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "write_file") {
      const targetPath = toolArgs.path;
      if (targetPath && isAllowed(targetPath)) {
        try {
          const resolved = resolveTarget(targetPath);
          const parentDir = path.dirname(resolved);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
        } catch {}
      }
    }

    if (toolName === "create_directory") {
      const targetPath = toolArgs.path;
      if (targetPath && isAllowed(targetPath)) {
        try {
          const resolved = resolveTarget(targetPath);
          if (!fs.existsSync(resolved)) {
            fs.mkdirSync(resolved, { recursive: true });
          }
        } catch {}
      }
    }

    if (toolName === "delete_file" || toolName === "delete_directory") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Delete operations are disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const target = toolArgs.path;
        if (!target) throw new Error("path is required");
        const text = recycle(target, toolName === "delete_directory");
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "grep_search") {
      try {
        const text = grepSearch(
          toolArgs.query,
          toolArgs.path,
          Boolean(toolArgs.case_sensitive),
          Boolean(toolArgs.is_regex),
          toolArgs.max_results || 50,
          toolArgs.file_pattern || ""
        );
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "get_directory_tree") {
      try {
        const text = getDirectoryTree(toolArgs.path, toolArgs.max_depth || 3, toolArgs.show_files !== false);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "read_file_range") {
      try {
        const text = readFileRange(toolArgs.path, toolArgs.start_line, toolArgs.end_line);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_status") {
      try {
        const text = gitStatus(toolArgs.path);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_diff") {
      try {
        const text = gitDiff(toolArgs.path, toolArgs.file_path, Boolean(toolArgs.staged), Boolean(toolArgs.stat));
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_log") {
      try {
        const text = gitLog(toolArgs.path, toolArgs.max_count, toolArgs.file_path);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_worktree_list") {
      try {
        const text = gitWorktreeList(toolArgs.path);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_add") {
      try {
        const text = gitAdd(toolArgs.path, toolArgs.files);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_commit") {
      try {
        const text = gitCommit(toolArgs.path, toolArgs.message, toolArgs.author);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_branch") {
      try {
        const text = gitBranch(toolArgs.path, toolArgs.action || "list", toolArgs.name);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_checkout") {
      try {
        const text = gitCheckout(toolArgs.path, toolArgs.branch, Boolean(toolArgs.create));
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_stash") {
      try {
        const text = gitStash(toolArgs.path, toolArgs.action || "save", toolArgs.message);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_worktree_create") {
      try {
        const text = await gitWorktreeCreate(toolArgs.path, toolArgs.branch, toolArgs.base_ref || "HEAD", toolArgs.activate !== false);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "git_worktree_remove") {
      try {
        const text = await gitWorktreeRemove(toolArgs.path, toolArgs.worktree_path, Boolean(toolArgs.force), Boolean(toolArgs.delete_branch));
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "create_checkpoint") {
      try {
        const text = createCheckpoint(toolArgs.path, toolArgs.label);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "rollback_checkpoint") {
      try {
        const text = rollbackCheckpoint(toolArgs.path, toolArgs.ref);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "run_command") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Command execution is disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const policyError = enforceCommandPolicy(toolArgs.command);
        if (policyError) {
          process.stdout.write(`${JSON.stringify(result(message.id, JSON.stringify({ policy: policyError }), true))}\n`);
          return;
        }
        const text = runCommand(toolArgs.command, toolArgs.path, toolArgs.timeout_seconds || 60);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "create_terminal") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Creating terminals is disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const text = await persistentCreateTerminal(toolArgs.path, toolArgs.shell);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "exec_terminal") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Executing in terminal is disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const policyError = enforceCommandPolicy(toolArgs.command);
        if (policyError) {
          process.stdout.write(`${JSON.stringify(result(message.id, JSON.stringify({ policy: policyError }), true))}\n`);
          return;
        }
        const text = await persistentExecTerminal(toolArgs.id, toolArgs.command, toolArgs.timeout_seconds || 60);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "read_terminal") {
      try {
        const text = await persistentReadTerminal(toolArgs.id, Boolean(toolArgs.clear));
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "send_terminal_input") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Sending terminal input is disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const text = await persistentSendTerminalInput(toolArgs.id, toolArgs.text, toolArgs.send_enter !== false, Boolean(toolArgs.sigint));
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "close_terminal") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Closing terminals is disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const text = await persistentCloseTerminal(toolArgs.id);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "list_terminals") {
      try {
        const text = await persistentListTerminals();
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "start_process") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Starting processes is disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const policyError = enforceCommandPolicy(toolArgs.command);
        if (policyError) {
          process.stdout.write(`${JSON.stringify(result(message.id, JSON.stringify({ policy: policyError }), true))}\n`);
          return;
        }
        const text = await persistentStartProcess(toolArgs.command, toolArgs.path);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "write_process_input") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Writing process input is disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const text = await persistentWriteProcessInput(toolArgs.id, toolArgs.text);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "wait_process") {
      try {
        const text = await persistentWaitProcess(toolArgs.id, toolArgs.timeout_seconds || 60);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "read_process_output") {
      try {
        const text = await persistentReadProcessOutput(toolArgs.id, Boolean(toolArgs.clear));
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "stop_process") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Stopping processes is disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const text = await persistentStopProcess(toolArgs.id);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "list_processes") {
      try {
        const text = await persistentListProcesses();
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "run_tests") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Running tests is disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const text = runTests(toolArgs.path, toolArgs.command);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "get_diagnostics") {
      try {
        const text = getDiagnostics(toolArgs.path, toolArgs.tool);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "apply_patch") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Patch application is disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const text = applyPatch(toolArgs.patch);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }

    if (toolName === "edit_file") {
      if (readOnly) {
        process.stdout.write(`${JSON.stringify(result(message.id, "Edit operations are disabled in Read-Only mode", true))}\n`);
        return;
      }
      try {
        const text = resilientEditFile(toolArgs.path, toolArgs.edits, toolArgs.oldText ?? toolArgs.old_text, toolArgs.newText ?? toolArgs.new_text);
        process.stdout.write(`${JSON.stringify(result(message.id, text))}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify(result(message.id, error.message, true))}\n`);
      }
      return;
    }
  }

  child.stdin.write(`${JSON.stringify(message)}\n`);
});

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const entry of terminals.values()) {
    if (!entry.exited) {
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/F", "/T", "/PID", String(entry.process.pid)], { windowsHide: true });
        } else {
          entry.process.kill("SIGTERM");
        }
      } catch {}
    }
  }

  for (const entry of backgroundProcesses.values()) {
    if (!entry.exited) {
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/F", "/T", "/PID", String(entry.process.pid)], { windowsHide: true });
        } else {
          entry.process.kill("SIGTERM");
        }
      } catch {}
    }
  }

  if (!child.killed) child.kill();
  const timer = setTimeout(() => {
    if (child.pid && process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
    }
    process.exit(exitCode);
  }, 1500);
  timer.unref();
}

inputLines.on("close", () => shutdown(0));
process.stdin.on("end", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("disconnect", () => shutdown(0));
child.on("exit", (code, signal) => {
  if (!shuttingDown) process.exit(code ?? (signal ? 1 : 0));
});
