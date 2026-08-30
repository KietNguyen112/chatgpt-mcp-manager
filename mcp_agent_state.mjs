import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime", "agent-state");
const MAX_MEMORY_ITEMS = 100;
const MAX_TEXT = 12000;

function statePath(owner) {
  const safeOwner = String(owner || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeOwner) throw new Error("runtime owner is required");
  return path.join(STATE_ROOT, `${safeOwner}.json`);
}
function emptyState() { return { version: 1, updated_at: new Date().toISOString(), plan: [], memory: [] }; }
function load(owner) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(owner), "utf8"));
    return { ...emptyState(), ...value, plan: Array.isArray(value.plan) ? value.plan : [], memory: Array.isArray(value.memory) ? value.memory : [] };
  } catch { return emptyState(); }
}
function save(owner, state) {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  state.updated_at = new Date().toISOString();
  const file = statePath(owner);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temp, file);
}
function cleanText(value, fallback = "") { return String(value ?? fallback).trim().slice(0, MAX_TEXT); }

export function getAgentState(owner) { return load(owner); }
export function updatePlan(owner, steps = [], currentStep = null) {
  if (!Array.isArray(steps)) throw new Error("steps must be an array");
  const state = load(owner);
  state.plan = steps.slice(0, 50).map((item, index) => typeof item === "string"
    ? { id: index + 1, title: cleanText(item), status: "pending" }
    : { id: item.id ?? index + 1, title: cleanText(item.title || item.step || item.name, `Step ${index + 1}`), status: ["pending", "in_progress", "completed", "blocked"].includes(item.status) ? item.status : "pending", detail: cleanText(item.detail || "") });
  if (currentStep !== null && currentStep !== undefined) {
    const current = Number(currentStep);
    for (const step of state.plan) if (step.id === current) step.status = "in_progress";
  }
  save(owner, state);
  return JSON.stringify({ plan: state.plan, updated_at: state.updated_at }, null, 2);
}
export function remember(owner, note, category = "general") {
  const value = cleanText(note);
  if (!value) throw new Error("note is required");
  const state = load(owner);
  state.memory.push({ id: Date.now(), category: cleanText(category, "general"), note: value, created_at: new Date().toISOString() });
  state.memory = state.memory.slice(-MAX_MEMORY_ITEMS);
  save(owner, state);
  return `Remembered note (${category || "general"}): ${value}`;
}
export function recall(owner, query = "", category = "") {
  const state = load(owner);
  const q = cleanText(query).toLowerCase();
  const c = cleanText(category).toLowerCase();
  const matches = state.memory.filter((item) => (!c || String(item.category).toLowerCase() === c) && (!q || `${item.category} ${item.note}`.toLowerCase().includes(q))).slice(-30);
  return JSON.stringify({ matches, count: matches.length }, null, 2);
}
export function clearAgentState(owner) { try { fs.unlinkSync(statePath(owner)); } catch {} return `Cleared agent state for owner ${owner}.`; }
