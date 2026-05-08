/**
 * Tool Registry
 *
 * Singleton registry for first-party agent tools. Each tool definition
 * carries:
 *   { name, description, tier, inputSchema (Zod), execute }
 *
 * Listing is tier-filtered so a profile that only allows
 * `local_safe` doesn't see tools tagged `money` (defence in depth on
 * top of the per-call broker check).
 *
 * `runTool` validates input via the Zod schema and forwards to the
 * tool's `execute` with `(input, ctx)`. The `ctx` object is opaque to
 * the registry — it's passed through so tools can read the current
 * webContentsId, sessionId, etc., that the agent-loop layer fills in.
 */

const log = require('../../logger');
const { isValidTier } = require('../tool-tiers');

const tools = new Map();

function register(def) {
  if (!def || typeof def.name !== 'string' || !def.name) {
    throw new Error('tool definition requires a non-empty name');
  }
  if (typeof def.description !== 'string' || !def.description) {
    throw new Error(`tool '${def.name}' requires a description`);
  }
  if (!isValidTier(def.tier)) {
    throw new Error(`tool '${def.name}' has unknown tier '${def.tier}'`);
  }
  if (!def.inputSchema || typeof def.inputSchema.parse !== 'function') {
    throw new Error(`tool '${def.name}' requires a Zod-shaped inputSchema`);
  }
  if (typeof def.execute !== 'function') {
    throw new Error(`tool '${def.name}' requires an execute function`);
  }
  if (tools.has(def.name)) {
    log.warn(`[ToolRegistry] Re-registering tool '${def.name}' (overwriting)`);
  }
  tools.set(def.name, def);
}

function registerAll(defs) {
  for (const def of defs) register(def);
}

function get(name) {
  return tools.get(name) || null;
}

function listAll() {
  return [...tools.values()];
}

function listForTiers(allowedTiers) {
  if (!Array.isArray(allowedTiers)) return [];
  const set = new Set(allowedTiers);
  return [...tools.values()].filter((t) => set.has(t.tier));
}

async function runTool(name, rawInput, ctx = {}) {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`unknown tool: ${name}`);
  }
  const input = tool.inputSchema.parse(rawInput || {});
  return tool.execute(input, ctx);
}

function clear() {
  tools.clear();
}

module.exports = {
  register,
  registerAll,
  get,
  listAll,
  listForTiers,
  runTool,
  // Test hook — production code never clears the registry mid-run.
  _internals: { clear },
};
