import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function exists(root, name) { try { return fs.existsSync(path.join(root, name)); } catch { return false; } }
function git(root, args) {
  try { const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 }); return { code: r.status ?? 1, stdout: (r.stdout || "").trim() }; }
  catch { return { code: 1, stdout: "" }; }
}
function detectProject(root) {
  if (exists(root, "package.json")) {
    try { const p = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); const d = { ...(p.dependencies || {}), ...(p.devDependencies || {}) }; if (d.next) return "Next.js"; if (d.react) return "React"; if (d.vue) return "Vue"; if (d.svelte) return "Svelte"; return "Node.js"; } catch { return "Node.js"; }
  }
  if (exists(root, "pyproject.toml") || exists(root, "requirements.txt") || exists(root, "setup.py")) return "Python";
  if (exists(root, "Cargo.toml")) return "Rust";
  if (exists(root, "go.mod")) return "Go";
  if (exists(root, "pom.xml") || exists(root, "build.gradle")) return "Java";
  return "Generic";
}
export function projectSummary(root, policy = {}) {
  const repo = git(root, ["rev-parse", "--show-toplevel"]), branch = git(root, ["branch", "--show-current"]), status = git(root, ["status", "--short", "--branch"]);
  const important = ["README.md", "README", "AGENTS.md", "CLAUDE.md", "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "tsconfig.json", "Dockerfile"].filter((x) => exists(root, x));
  return { root, project_type: detectProject(root), platform: process.platform, git: { is_repository: repo.code === 0, root: repo.stdout || null, branch: branch.stdout || null, status: status.stdout || "clean" }, important_files: important, policy };
}
