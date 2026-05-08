# Pi Conventions

Living guide for embedding `@earendil-works/pi-coding-agent` inside Freedom Browser. The companion roadmap lives at `research/pi-roadmap.md` (gitignored). This file is committed because it captures rules and gotchas that future contributors need.

The single design rule: **Pi owns the mechanics. Freedom owns the authority.** Pi runs the agent loop, sessions, events, hooks, system-prompt builder, model/provider registry, lifecycle. Freedom decides which tools the agent can call, surfaces consent UI for every call, controls payments and signing, and decides which third-party Pi extensions/packages may load.

## Package and version

- Package: `@earendil-works/pi-coding-agent` — the canonical scope after the migration from `badlogic/pi-mono` → `earendil-works/pi-mono`.
- Version: pinned to `0.74.0` exactly. We own bumps deliberately. Companion deps `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` come transitively at the same version; do not reference them directly without good reason.
- `typebox`: pinned to `1.1.38` to match the version Pi resolves transitively. Used directly in our code for tool parameter schemas (`Type.Object({ ... })`).
- Engine: Pi declares `engines.node >= 20.6.0`. Freedom historically declared `>= 18`; in practice we run on whatever Electron's bundled Node is. Don't worry about the engines field unless CI breaks.

## ESM vs CommonJS

Pi is `"type": "module"` (pure ESM). Our main process is CommonJS. We bridge via dynamic `import()` inside an async wrapper:

```js
let _piModule = null;
async function loadPi() {
  if (!_piModule) _piModule = await import('@earendil-works/pi-coding-agent');
  return _piModule;
}
```

Cache the result. Tests can override the cache via the module's `_internals` export.

## `agentDir` and `cwd`

Pi defaults to `cwd = process.cwd()` and `agentDir = ~/.pi/agent`. **Always override `agentDir`** so Freedom does not pollute the user's home directory:

```js
const path = require('node:path');
function getFreedomAgentDir() {
  return path.join(app.getPath('userData'), 'pi-agent');
}
```

`cwd` is only relevant when built-in tools are enabled (we disable them — see below), so we pass `agentDir` for `cwd` too. Single rooted location for everything Pi-related.

## Disabling Pi's defaults

Pi's CLI ships with `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` enabled by default and discovers extensions, skills, prompts, and themes from disk. For Freedom we keep all of that off in v1:

- `noTools: 'all'` on `createAgentSession` — hides all built-ins from the LLM.
- `DefaultResourceLoader` constructed with `noExtensions: true`, `noSkills: true`, `noPromptTemplates: true`, `noThemes: true`, `noContextFiles: true` — no disk autodiscovery.
- Our single Freedom extension is passed via `extensionFactories: [freedomExtension]` on the loader. This is the only extension that runs.
- Phase 6+ may re-enable some autodiscovery, but only against `userData/pi-agent/skills/` etc. — never `~/.pi/`.

## Provider and model registration

Pi's agent loop resolves the model via `findInitialModel(modelRegistry)` *before* extensions get a chance to bind via `bindCore`. Provider registration calls made inside an extension's factory **queue** in `runtime.pendingProviderRegistrations` and only flush during `bindCore`, which runs inside the `AgentSession` constructor.

Practical consequence: if you only register Ollama via the extension, `findInitialModel` won't find your model. Either:

1. Pre-register on the `modelRegistry` directly before calling `createAgentSession` (simplest — what `pi-runtime.js` does), **or**
2. Pass `options.model` explicitly to bypass `findInitialModel`.

Option 1 is what we use. The extension can still call `pi.registerProvider` later for dynamic updates (e.g., Ollama URL change); registering twice is idempotent.

### Ollama provider config

```js
{
  baseUrl: `${getOllamaApiUrl()}/v1`,
  apiKey: 'ollama', // ignored by Ollama, but a value is required
  api: 'openai-completions',
  compat: {
    supportsDeveloperRole: false,    // Ollama doesn't understand the "developer" role
    supportsReasoningEffort: false,  // Ollama doesn't accept reasoning_effort
  },
  models: [
    {
      id: 'gemma4:e2b',
      name: 'Gemma 4 e2b (local)',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    },
    // ...one entry per model returned by `ollama-meta.listModels()`
  ],
}
```

If Ollama returns models with unusual names, the model `id` is whatever `ollama tag` reported. We pass it through verbatim so the user sees the same string they'd type.

## Custom `ExtensionUIContext`

Pi's UI dialogs (`ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.input`, `ctx.ui.notify`) are typed against an `ExtensionUIContext` interface. The interface is huge (~30 methods, mostly TUI-flavored) but only a handful matter to us. Everything we don't use becomes a no-op stub.

The injection point is `await session.bindExtensions({ uiContext: ourImpl })` after `createAgentSession`. Internally that calls `runner.setUIContext(ourImpl)` and emits `session_start`.

In Phase 1 our impl logs every call. Phase 2 wires `confirm` to renderer IPC.

## Extensions are passed programmatically, not by file

The docs imply an `extensions: [factory]` parameter to `createAgentSession`. **There isn't one.** Use `DefaultResourceLoader`'s `extensionFactories` option:

```js
const resourceLoader = new pi.DefaultResourceLoader({
  cwd: agentDir,
  agentDir,
  settingsManager,
  noExtensions: true,
  extensionFactories: [freedomExtension],
});
await resourceLoader.reload();
```

Then pass `{ resourceLoader }` into `createAgentSession`.

## Doc vs source

Pi's docs lag the source. When in doubt, read `node_modules/@earendil-works/pi-coding-agent/dist/**/*.d.ts`. Append discovered mismatches here as we find them.

Known mismatches (as of 0.74.0):

| Doc claim | Source reality |
|---|---|
| `tools: createCodingTools(cwd)` accepts Tool objects | `tools: string[]` is an allowlist of names; Tool objects go via `customTools` |
| `extensions: [factory]` on `createAgentSession` | No such parameter. Use `DefaultResourceLoader.extensionFactories`. |
| `customTools` "do NOT participate in extension events" | They do — `CustomToolCallEvent` is part of `ToolCallEvent` union |
| `session.prompt()` returns on queue acceptance | True only in RPC mode. SDK mode resolves after `agent_end`. |

## Safety invariants

These are always-on, regardless of how long-running the agent is. None of these are step caps.

1. **Stop button always works.** `session.abort()` resolves cleanly within ~1s.
2. **Stuck-consent cleanup.** Every `ctx.ui.confirm()` we surface has a 5-minute default timeout via `AbortSignal`. Renderer disconnect resolves any pending consent as deny.
3. **Renderer-disconnect cleanup.** `web-contents-destroyed` aborts the Pi session and disposes it.
4. **Optional wall-clock watchdog** for autonomous ("long-running") mode. Off by default; configurable per session.
5. **Visible "agent acting" affordance.** The sidebar header shows a pulsing indicator and the stop button while the agent loop is running.

## Working with this file

When you discover a Pi-specific landmine, append a short note here. Keep this file readable end-to-end; it is the closest thing to a "Pi for Freedom" handbook.
