import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_OUTPUT = 50000;
const exists = (root, name) => fs.existsSync(path.join(root, name));
function readJson(root, name) { try { return JSON.parse(fs.readFileSync(path.join(root, name), "utf8")); } catch { return null; } }

export function detectProject(root) {
  const pkg = readJson(root, "package.json");
  if (pkg) return {
    ecosystem: "node",
    package_manager: exists(root, "pnpm-lock.yaml") ? "pnpm" : exists(root, "yarn.lock") ? "yarn" : "npm",
    test: pkg.scripts?.test || ((pkg.devDependencies?.vitest || pkg.dependencies?.vitest) ? "npx vitest run" : (pkg.devDependencies?.jest || pkg.dependencies?.jest) ? "npx jest --runInBand" : null),
    diagnostics: pkg.scripts?.typecheck ? `${exists(root, "pnpm-lock.yaml") ? "pnpm" : exists(root, "yarn.lock") ? "yarn" : "npm run"} ${exists(root, "pnpm-lock.yaml") || exists(root, "yarn.lock") ? "typecheck" : "typecheck"}` : pkg.scripts?.lint ? `${exists(root, "pnpm-lock.yaml") ? "pnpm" : exists(root, "yarn.lock") ? "yarn" : "npm run"} ${exists(root, "pnpm-lock.yaml") || exists(root, "yarn.lock") ? "lint" : "lint"}` : null,
    build: pkg.scripts?.build ? `${exists(root, "pnpm-lock.yaml") ? "pnpm" : exists(root, "yarn.lock") ? "yarn" : "npm run"} ${exists(root, "pnpm-lock.yaml") || exists(root, "yarn.lock") ? "build" : "build"}` : null,
  };
  if (exists(root, "pyproject.toml") || exists(root, "pytest.ini") || exists(root, "requirements.txt")) return { ecosystem: "python", test: exists(root, "pytest.ini") || exists(root, "tests") ? "pytest" : null, diagnostics: "python -m compileall -q .", build: null };
  if (exists(root, "Cargo.toml")) return { ecosystem: "rust", test: "cargo test", diagnostics: "cargo check", build: "cargo build" };
  if (exists(root, "go.mod")) return { ecosystem: "go", test: "go test ./...", diagnostics: "go vet ./...", build: "go build ./..." };
  if (exists(root, "pom.xml")) return { ecosystem: "java", test: "mvn test", diagnostics: null, build: "mvn package -DskipTests" };
  return { ecosystem: "generic", test: null, diagnostics: null, build: null };
}

function execute(command, cwd, timeoutMs) {
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
  const r = spawnSync(shell, args, { cwd, encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  return { command, exit_code: r.status ?? 1, timed_out: r.error?.code === "ETIMEDOUT", output: `${r.stdout || ""}${r.stderr ? `\n${r.stderr}` : ""}`.trim().slice(0, MAX_OUTPUT) };
}

export function verifyProject(root, options = {}) {
  const project = detectProject(root), checks = [];
  const testCommand = options.command || project.test;
  if (testCommand) checks.push({ kind: "tests", ...execute(testCommand, root, 180000) });
  else checks.push({ kind: "tests", skipped: true, reason: "No test command detected." });
  if (options.includeDiagnostics !== false && project.diagnostics) checks.push({ kind: "diagnostics", ...execute(project.diagnostics, root, 120000) });
  if (options.includeBuild && project.build) checks.push({ kind: "build", ...execute(project.build, root, 180000) });
  const failed = checks.filter((c) => !c.skipped && c.exit_code !== 0);
  const diagnosis = failed.map((failure) => ({
    kind: failure.kind,
    exit_code: failure.exit_code,
    timed_out: Boolean(failure.timed_out),
    first_error: failure.output?.match(/(?:error|failed|failure|traceback)[^\n]*/i)?.[0] || "No structured error line detected; inspect command output.",
  }));
  return { success: failed.length === 0, project, checks, diagnosis, summary: `${checks.filter((c) => !c.skipped && c.exit_code === 0).length} passed, ${failed.length} failed, ${checks.filter((c) => c.skipped).length} skipped` };
}
