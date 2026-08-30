import { rawRuntimeCall } from "./mcp_runtime_client.mjs";

const [action, owner] = process.argv.slice(2);

async function main() {
  if (!action) {
    console.error("Usage: node mcp_runtime_admin.mjs <cleanup-owner|shutdown|ping> [owner]");
    process.exitCode = 2;
    return;
  }

  try {
    if (action === "cleanup-owner") {
      if (!owner) throw new Error("owner is required for cleanup-owner");
      const result = await rawRuntimeCall("runtime.cleanup_owner", owner, {}, 2500);
      if (result) console.log(result);
      return;
    }
    if (action === "shutdown") {
      const result = await rawRuntimeCall("runtime.shutdown", "", {}, 2500);
      if (result) console.log(result);
      return;
    }
    if (action === "ping") {
      const result = await rawRuntimeCall("runtime.ping", "", {}, 1200);
      console.log(JSON.stringify(result));
      return;
    }
    throw new Error(`Unknown action: ${action}`);
  } catch (error) {
    // Cleanup during service shutdown is best-effort. A missing daemon means
    // there is nothing to clean and should not make shutdown fail.
    if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error?.code)) return;
    if (/connect|socket|pipe/i.test(error?.message || "")) return;
    throw error;
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
