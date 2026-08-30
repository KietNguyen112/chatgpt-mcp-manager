import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { RUNTIME_APP_DIR, RUNTIME_ENDPOINT, makeRuntimeOwner } from "./mcp_runtime_common.mjs";

let startupPromise = null;

function rawRequest(action, owner, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(RUNTIME_ENDPOINT);
    let buffer = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(new Error(`M1 runtime request timed out: ${action}`)));
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ action, owner, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      if (!line) return;
      try {
        const response = JSON.parse(line);
        if (!response.ok) {
          finish(new Error(response.error || `M1 runtime action failed: ${action}`));
          return;
        }
        finish(null, response.result);
      } catch (error) {
        finish(new Error(`Invalid M1 runtime response: ${error.message}`));
      }
    });
  });
}

async function ensureRuntime() {
  try {
    await rawRequest("runtime.ping", "", {}, 350);
    return;
  } catch {}

  if (!startupPromise) {
    startupPromise = (async () => {
      const daemonPath = path.join(RUNTIME_APP_DIR, "mcp_runtime_daemon.mjs");
      const child = spawn(process.execPath, [daemonPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();

      let lastError = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          await rawRequest("runtime.ping", "", {}, 350);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(`Unable to start M1 runtime daemon: ${lastError?.message || "unknown error"}`);
    })().finally(() => {
      startupPromise = null;
    });
  }

  await startupPromise;
}

export async function rawRuntimeCall(action, owner, params = {}, timeoutMs = 5000) {
  return rawRequest(action, owner, params, timeoutMs);
}

export async function runtimeCall(action, owner, params = {}, timeoutMs = 5000) {
  try {
    return await rawRequest(action, owner, params, timeoutMs);
  } catch (firstError) {
    const recoverable = ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(firstError?.code)
      || /connect|socket|pipe/i.test(firstError?.message || "");
    if (!recoverable) throw firstError;
    await ensureRuntime();
    return rawRequest(action, owner, params, timeoutMs);
  }
}

export async function shutdownRuntime() {
  try {
    return await rawRequest("runtime.shutdown", "", {}, 2000);
  } catch {
    return "M1 runtime daemon is not running.";
  }
}

export { makeRuntimeOwner, RUNTIME_ENDPOINT };
