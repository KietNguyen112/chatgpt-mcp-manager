import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProject, verifyProject } from "../mcp_verification_engine.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "m1-verify-"));
try {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"", lint: "node -e \"process.exit(0)\"" } }));
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const detected = detectProject(root);
  assert.strictEqual(detected.ecosystem, "node");
  assert.strictEqual(detected.package_manager, "pnpm");
  assert.strictEqual(detected.test, "node -e \"process.exit(0)\"");
  assert.strictEqual(detected.diagnostics, "pnpm lint");
  const result = verifyProject(root);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.checks.length, 2);
  assert.strictEqual(result.diagnosis.length, 0);
  console.log("PASS: unified verification engine detects and verifies a Node project.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
