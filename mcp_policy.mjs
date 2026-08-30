/** Local coding-agent policy boundary. */
const DANGEROUS_PATTERNS = [
  /\bformat(?:\.com)?\b/i, /\bdiskpart\b/i,
  /\breg(?:\.exe)?\s+(?:delete|add|import)\b/i,
  /\bRemove-Item\b[^\n]*(?:-Recurse|-Force)/i,
  /\b(?:rmdir|rd)\b[^\n]*\/s/i, /\b(?:del|erase)\b[^\n]*(?:\/s|\/q)/i,
  /\bSet-ExecutionPolicy\b/i,
];
const NETWORK_PATTERNS = [
  /\bcurl\b/i, /\bwget\b/i, /\bInvoke-WebRequest\b/i, /\bInvoke-RestMethod\b/i,
  /\b(?:npm|pnpm|yarn)\s+(?:install|add|update)\b/i,
  /\b(?:pip|uv)\s+install\b/i, /\bgo\s+(?:get|install)\b/i, /\bcargo\s+(?:add|install)\b/i,
];
export function classifyCommand(command) {
  const value = String(command || "").trim();
  if (!value) return "invalid";
  if (DANGEROUS_PATTERNS.some((p) => p.test(value))) return "dangerous";
  if (NETWORK_PATTERNS.some((p) => p.test(value))) return "network";
  return "normal";
}
export function enforceCommandPolicy(command, policy = process.env.M1_COMMAND_POLICY || "allow") {
  const classification = classifyCommand(command);
  if (classification === "invalid") return { action: "deny", classification, reason: "Command is empty." };
  const mode = String(policy).toLowerCase();
  if (mode === "deny") return { action: "deny", classification, reason: "Command execution is disabled by local policy." };
  if (mode === "ask" && (classification === "dangerous" || classification === "network")) {
    return { action: "approval_required", classification, reason: `Command requires approval: ${String(command).slice(0, 500)}` };
  }
  if (mode === "allow" && classification === "dangerous" && process.env.M1_ALLOW_DANGEROUS_COMMANDS !== "1") {
    return { action: "approval_required", classification, reason: "Dangerous command requires explicit local override (M1_ALLOW_DANGEROUS_COMMANDS=1)." };
  }
  return null;
}
export function policyDescription() {
  return {
    command_policy: process.env.M1_COMMAND_POLICY || "allow",
    dangerous_commands_require_explicit_override: process.env.M1_ALLOW_DANGEROUS_COMMANDS !== "1",
    workspace_boundary: "enforced by filesystem bridge",
    transport: "OpenAI Secure MCP Tunnel / tunnel-client",
  };
}
