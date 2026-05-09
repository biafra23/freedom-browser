/**
 * Pi Runtime
 *
 * Boots a Pi `AgentSession` configured for embedded use inside Freedom's
 * Electron main process. Three guarantees this module enforces:
 *
 *   1. **No disk autodiscovery.** `DefaultResourceLoader` is constructed
 *      with every `noXxx: true` flag so Pi does not scan `agentDir` for
 *      extensions, skills, prompts, themes, or context files. The single
 *      Freedom extension is passed via `extensionFactories: [factory]`.
 *      Phase 6+ may opt back in to specific scanning paths.
 *
 *   2. **No Pi built-in tools.** `noTools: 'builtin'` keeps `read`,
 *      `bash`, `edit`, `write`, `grep`, `find`, `ls` invisible to the
 *      LLM while leaving extension-registered tools enabled. Phase 3+
 *      registers Freedom's browser tools via `pi-extension.js` and the
 *      caller calls `session.setActiveToolsByName(visibleNames)` to
 *      apply profile-driven filtering after `bindExtensions`.
 *
 *   3. **Pre-registered Ollama provider.** Pi's `findInitialModel` runs
 *      before extension `bindCore`, when extension provider registrations
 *      are still queued. Pre-registering on `modelRegistry` directly is
 *      the simplest fix — the extension can still re-register dynamically
 *      later without conflict.
 *
 * Pi is ESM-only; main is CommonJS. We bridge with a cached dynamic
 * `import()` so the module load happens lazily and only once.
 */

const path = require('node:path');
const log = require('../logger');
const { getOllamaApiUrl } = require('../service-registry');
const { listModels } = require('./ollama-meta');
const { createFreedomExtension } = require('./pi-extension');
const { createPiUIContext } = require('./pi-ui-context');

const OLLAMA_PROVIDER_NAME = 'ollama';
const OLLAMA_API_KEY_PLACEHOLDER = 'ollama'; // Ollama ignores this; Pi requires a value
const PI_API_OPENAI_COMPLETIONS = 'openai-completions';
const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_MAX_TOKENS = 8192;

let _piModule = null;

async function loadPi() {
  if (!_piModule) {
    _piModule = await import('@earendil-works/pi-coding-agent');
  }
  return _piModule;
}

function getFreedomAgentDir(app) {
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('getFreedomAgentDir requires an Electron `app` instance');
  }
  return path.join(app.getPath('userData'), 'pi-agent');
}

function buildOllamaProviderConfig({ baseUrl, models }) {
  return {
    baseUrl,
    apiKey: OLLAMA_API_KEY_PLACEHOLDER,
    api: PI_API_OPENAI_COMPLETIONS,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    models: (models || []).map((m) => ({
      id: m.name,
      name: m.name,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    })),
  };
}

/**
 * Create a fully-configured Freedom Pi session.
 *
 * @param {object} options
 * @param {string} options.agentDir         Required. Directory Pi may use for
 *                                          settings/sessions. Override
 *                                          `getFreedomAgentDir(app)` callsite
 *                                          for tests.
 * @param {string} [options.modelId]        Ollama model id (e.g. 'gemma4:e2b').
 *                                          Defaults to the first model Ollama
 *                                          reports.
 * @param {string} [options.ollamaBaseUrl]  Override `service-registry`'s
 *                                          Ollama URL (defaults to live).
 * @param {string} [options.sessionPath]    Existing Pi JSONL session file to
 *                                          resume. Omit for a new in-memory
 *                                          session.
 * @param {object} [options.uiContext]      Override `createPiUIContext()`.
 *                                          Phase 2+ uses this to inject a
 *                                          renderer-IPC-bridged impl.
 * @param {object} [options.toolCallContext] Per-stream tool plumbing for
 *                                          Phase 3+. When provided,
 *                                          pi-extension registers the
 *                                          browser tools, gates them
 *                                          through the broker, and
 *                                          forwards consent / result
 *                                          events to the renderer.
 *                                          See `pi-extension.js`.
 * @param {boolean} [options.isSubagent]    Phase 5: when true, the
 *                                          extension skips registering
 *                                          spawn_subagent so subagents
 *                                          can't recurse (depth = 1).
 * @param {string} [options.overrideSystemPrompt] Phase 5: subagent path
 *                                          replaces the Freedom default
 *                                          intro with the subagent's own.
 * @param {Function} [options.fetchImpl]    Override `fetch` for `listModels`.
 * @returns {Promise<{session, dispose, modelId}>}
 */
async function createFreedomPiSession({
  agentDir,
  modelId,
  ollamaBaseUrl,
  sessionPath,
  uiContext,
  toolCallContext,
  isSubagent = false,
  overrideSystemPrompt,
  fetchImpl,
} = {}) {
  if (!agentDir) {
    throw new Error('createFreedomPiSession requires an agentDir');
  }

  const ollamaApiUrl = ollamaBaseUrl ?? getOllamaApiUrl();
  // loadPi() resolves the Pi ESM tree (disk + JIT); listModels() is an HTTP
  // RTT to Ollama. Independent — overlap them so cold sessions are snappier.
  const [pi, tagsResp] = await Promise.all([
    loadPi(),
    listModels({ baseUrl: ollamaApiUrl, fetchImpl }),
  ]);
  const ollamaModels = tagsResp.models || [];
  if (ollamaModels.length === 0) {
    throw new Error(
      `No Ollama models installed at ${ollamaApiUrl}. Pull one with "ollama pull gemma4:e2b" before booting Pi.`
    );
  }

  const resolvedModelId = modelId ?? ollamaModels[0].name;
  const providerConfig = buildOllamaProviderConfig({
    baseUrl: `${ollamaApiUrl}/v1`,
    models: ollamaModels,
  });

  const authStorage = pi.AuthStorage.create(); // No file backing; Ollama needs no real key.
  const modelRegistry = pi.ModelRegistry.create(authStorage);
  modelRegistry.registerProvider(OLLAMA_PROVIDER_NAME, providerConfig);

  // Pi distinguishes cwd (project root for built-in tools) from agentDir
  // (where settings/sessions/extensions live). With built-in tools disabled
  // we collapse them so everything Pi-related sits under one rooted path.
  const cwd = agentDir;
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);

  // Captured below once `createAgentSession` returns, so command
  // handlers registered inside the extension factory can reach the
  // live AgentSession (Pi exposes a few command-relevant methods like
  // `getLastAssistantText` / `exportToHtml` only on AgentSession).
  const sessionRef = { session: null };

  const freedomExtension = createFreedomExtension({
    toolCallContext,
    isSubagent,
    overrideSystemPrompt,
    modelId: resolvedModelId,
    agentDir,
    sessionRef,
  });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [freedomExtension],
  });
  await resourceLoader.reload();

  const sessionManager = sessionPath
    ? pi.SessionManager.open(sessionPath)
    : pi.SessionManager.inMemory(cwd);

  const model = modelRegistry.find(OLLAMA_PROVIDER_NAME, resolvedModelId);
  if (!model) {
    throw new Error(
      `Model ollama/${resolvedModelId} not found in registry after provider registration. ` +
        `Available: ${ollamaModels.map((m) => m.name).join(', ')}`
    );
  }

  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager,
    resourceLoader,
    model,
    // 'builtin' (not 'all') so extension-registered tools survive while
    // Pi's read/bash/edit/write/grep/find/ls stay disabled.
    noTools: 'builtin',
  });

  const effectiveUiContext = uiContext ?? createPiUIContext();
  await session.bindExtensions({
    uiContext: effectiveUiContext,
    onError: (err) => log.error('[Pi] extension error', err),
  });

  sessionRef.session = session;

  return {
    session,
    modelId: resolvedModelId,
    dispose: () => {
      sessionRef.session = null;
      try {
        session.dispose();
      } catch (err) {
        log.warn('[Pi] session.dispose() threw', err);
      }
    },
  };
}

module.exports = {
  createFreedomPiSession,
  getFreedomAgentDir,
  _internals: {
    loadPi,
    buildOllamaProviderConfig,
    setPiModule: (mod) => {
      _piModule = mod;
    },
    OLLAMA_PROVIDER_NAME,
  },
};
