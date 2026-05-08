#!/usr/bin/env node
/**
 * Pi Smoke Harness (Phase 1 gate)
 *
 * Boots a Pi `AgentSession` against the local Ollama daemon and runs one
 * prompt end-to-end, printing every event. Run with:
 *
 *   npm run pi:smoke -- --prompt "Say hi in three words." --model gemma4:e2b
 *
 * Or with defaults:
 *
 *   npm run pi:smoke
 *
 * Default `agentDir` lives under `os.tmpdir()/freedom-pi-smoke/` so this
 * script can run from raw Node (no Electron). It does not touch the user's
 * real `userData/pi-agent/` directory.
 *
 * What this proves:
 *   - Pi's openai-completions provider talks to Ollama at /v1/chat/completions
 *   - Default coding tools (read, bash, edit, write, grep, find, ls) are
 *     not visible to the LLM (`getActiveToolNames()` is empty)
 *   - The Freedom extension binds and `session_start` fires
 *   - Streaming text deltas reach the subscriber
 *   - `agent_end` fires cleanly with the assistant's full message
 *   - `dispose()` tears down without throwing
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function parseArgs(argv) {
  const args = { prompt: 'Say hi in three words.', model: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--prompt') args.prompt = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--agent-dir') args.agentDir = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: npm run pi:smoke -- [--prompt "text"] [--model id] [--agent-dir path]'
      );
      process.exit(0);
    }
  }
  return args;
}

function summarizeEvent(event) {
  if (event.type === 'message_update') {
    const sub = event.assistantMessageEvent;
    if (sub?.type === 'text_delta') {
      return `message_update text_delta "${sub.delta}"`;
    }
    return `message_update ${sub?.type ?? '?'}`;
  }
  if (event.type === 'tool_execution_start') return `tool_execution_start ${event.toolName}`;
  if (event.type === 'tool_execution_end')
    return `tool_execution_end ${event.toolName} isError=${event.isError}`;
  if (event.type === 'turn_start') return `turn_start #${event.turnIndex}`;
  if (event.type === 'turn_end') return `turn_end #${event.turnIndex}`;
  return event.type;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const agentDir =
    args.agentDir || path.join(os.tmpdir(), 'freedom-pi-smoke', String(process.pid));
  fs.mkdirSync(agentDir, { recursive: true });

  console.log(`[smoke] agentDir=${agentDir}`);
  console.log(`[smoke] prompt=${JSON.stringify(args.prompt)}`);

  const { createFreedomPiSession } = require('../src/main/agent/pi-runtime');
  const start = Date.now();
  const { session, modelId, dispose } = await createFreedomPiSession({
    agentDir,
    modelId: args.model,
  });
  console.log(`[smoke] session ready in ${Date.now() - start}ms (model=${modelId})`);

  const activeTools = session.getActiveToolNames();
  console.log(`[smoke] active tools: ${JSON.stringify(activeTools)}`);
  const builtins = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  const leaked = activeTools.filter((name) => builtins.includes(name));
  if (leaked.length > 0) {
    console.error(`[smoke] FAIL: built-in tools leaked into session: ${leaked.join(', ')}`);
    dispose();
    process.exit(2);
  }
  console.log(`[smoke] PASS: no Pi built-in tools visible to the LLM`);

  let assistantText = '';
  let agentEndSeen = false;
  const unsubscribe = session.subscribe((event) => {
    console.log(`[evt] ${summarizeEvent(event)}`);
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'text_delta'
    ) {
      assistantText += event.assistantMessageEvent.delta;
    }
    if (event.type === 'agent_end') {
      agentEndSeen = true;
    }
  });

  const promptStart = Date.now();
  try {
    await session.prompt(args.prompt, { source: 'extension' });
  } catch (err) {
    console.error(`[smoke] prompt threw: ${err.message}`);
    unsubscribe();
    dispose();
    process.exit(3);
  }
  const promptMs = Date.now() - promptStart;
  unsubscribe();

  console.log('---');
  console.log(`[smoke] prompt -> agent_end: ${promptMs}ms`);
  console.log(`[smoke] agent_end seen: ${agentEndSeen}`);
  console.log(`[smoke] assistant text:\n${assistantText}`);

  dispose();
  console.log('[smoke] disposed cleanly');

  if (!agentEndSeen || assistantText.length === 0) {
    console.error('[smoke] FAIL: missing agent_end or empty assistant text');
    process.exit(4);
  }
  console.log('[smoke] OK');
}

main().catch((err) => {
  console.error('[smoke] FATAL:', err);
  process.exit(1);
});
