import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_APP_DIR = path.dirname(fileURLToPath(import.meta.url));

const appHash = crypto
  .createHash("sha256")
  .update(path.resolve(RUNTIME_APP_DIR).toLowerCase())
  .digest("hex")
  .slice(0, 16);

export const RUNTIME_ENDPOINT = process.platform === "win32"
  ? `\\\\.\\pipe\\m1-runtime-${appHash}`
  : path.join(os.tmpdir(), `m1-runtime-${appHash}.sock`);

export function makeRuntimeOwner(folders, readOnly = false) {
  const normalized = [...folders]
    .map((folder) => {
      const resolved = path.resolve(folder);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    })
    .sort();

  return crypto
    .createHash("sha256")
    .update(`${readOnly ? "ro" : "rw"}\n${normalized.join("\n")}`)
    .digest("hex")
    .slice(0, 24);
}
