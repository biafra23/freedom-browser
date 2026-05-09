/**
 * Inference Provider
 *
 * Hackathon-mode opt-in: when the user enables `aiSharedInferenceEnabled` in
 * settings, this module listens to every messaging channel (notably the
 * global Freedom Lobby) for `inference:request` and `inference:probe`
 * envelopes and serves them via the local Ollama sidecar.
 *
 * Wire envelopes (JSON-stringified, transported as XMTP text):
 *
 *   inference:probe        { v:1, kind, requestId, sentAt }
 *   inference:probe-ack    { v:1, kind, requestId, providerInboxId,
 *                            providerAddress, models:[{name,size,family}],
 *                            sentAt }
 *   inference:request      { v:1, kind, requestId, model, prompt,
 *                            system?, options?, sentAt }
 *   inference:response     { v:1, kind, requestId, providerInboxId,
 *                            providerAddress, model, content, error?,
 *                            latencyMs, sentAt }
 *
 * `requestId` is the consumer-side correlation key. We echo it on every
 * reply so the consumer can drop replies to other requests it didn't make.
 * `model: '*'` on a request means "any installed model" — the provider
 * picks the first one from `/api/tags` and reports the resolved name in
 * the response.
 *
 * Threat model (hackathon scope, knowingly accepted):
 *   - Anyone in a shared channel can run inference on the toggled-on
 *     install. There's no per-request consent, no rate limit, no allowlist
 *     of models or peers. The toggle's own copy warns about this.
 *   - Prompts sent to the lobby are visible to every member; we don't add
 *     a privacy layer on top.
 *   - The MAX_PROMPT_BYTES guard is the only abuse limiter: oversized
 *     prompts are silently dropped (no reply).
 *
 * Lifecycle: start() registers a listener via runtime.addMessageListener;
 * stop() unsubscribes. The toggle is read on every incoming message so
 * settings flips take effect immediately without a restart.
 */

const log = require('electron-log');

const ollamaMeta = require('../agent/ollama-meta');

// Cap to prevent a single peer from spamming a Pi-sized prompt at us.
// 16 KB is generous for chat — a token is ~4 bytes, so ~4k tokens.
const MAX_PROMPT_BYTES = 16 * 1024;

// Match the lobby-config style: explicit envelope kinds, version pinned.
const KIND_PROBE = 'inference:probe';
const KIND_PROBE_ACK = 'inference:probe-ack';
const KIND_REQUEST = 'inference:request';
const KIND_RESPONSE = 'inference:response';
const ENVELOPE_VERSION = 1;

// Module-scoped singleton (one provider per process). Mirrors the
// xmtp-client / messaging-runtime singleton pattern.
const state = {
  started: false,
  unsubscribe: null,
  // Injected at start() — kept on state so tests can swap them without
  // touching require-cache. None default to module-globals because the
  // runtime wiring happens in main.js, where these dependencies are
  // already available.
  runtime: null,
  loadSettings: null,
  getOllamaApiUrl: null,
  fetchImpl: null,
};

/**
 * Boot the provider listener. Idempotent.
 *
 * @param {object} deps
 * @param {object} deps.runtime - messaging-runtime
 * @param {() => object} deps.loadSettings - settings reader (sync)
 * @param {() => string} deps.getOllamaApiUrl - resolves the active
 *   Ollama base URL
 * @param {Function} [deps.fetchImpl] - test seam for the global fetch
 */
function start(deps) {
  if (state.started) return;
  if (!deps?.runtime || !deps?.loadSettings || !deps?.getOllamaApiUrl) {
    throw new Error('inference-provider.start: runtime, loadSettings, getOllamaApiUrl required');
  }
  state.runtime = deps.runtime;
  state.loadSettings = deps.loadSettings;
  state.getOllamaApiUrl = deps.getOllamaApiUrl;
  state.fetchImpl = deps.fetchImpl || null;

  state.unsubscribe = state.runtime.addMessageListener(handleIncoming);
  state.started = true;
  log.info('[InferenceProvider] listening (toggle gates per-message)');
}

/**
 * Stop the provider listener. Idempotent.
 */
function stop() {
  if (!state.started) return;
  try {
    state.unsubscribe?.();
  } catch (err) {
    log.warn('[InferenceProvider] unsubscribe failed:', err);
  }
  state.unsubscribe = null;
  state.runtime = null;
  state.loadSettings = null;
  state.getOllamaApiUrl = null;
  state.fetchImpl = null;
  state.started = false;
  log.info('[InferenceProvider] stopped');
}

function isStarted() {
  return state.started;
}

// ---------------------------------------------------------------------------
// Internal: incoming-envelope dispatch
// ---------------------------------------------------------------------------

async function handleIncoming({ channelId, message }) {
  const envelope = message?.parsed;
  const kind = envelope?.kind;
  if (kind !== KIND_PROBE && kind !== KIND_REQUEST) return;

  // Toggle gate. Read on every message so flips take immediate effect.
  let settings;
  try {
    settings = state.loadSettings();
  } catch (err) {
    log.warn('[InferenceProvider] loadSettings failed:', err);
    return;
  }
  if (!settings?.aiSharedInferenceEnabled) return;

  const requestId = envelope.requestId;
  if (!requestId || typeof requestId !== 'string') {
    log.warn(`[InferenceProvider] dropping ${kind} without requestId`);
    return;
  }

  const status = state.runtime.getStatus();
  const provider = {
    providerInboxId: status?.inboxId || null,
    providerAddress: status?.address || null,
  };

  if (kind === KIND_PROBE) {
    await respondToProbe(channelId, requestId, provider);
    return;
  }
  await respondToRequest(channelId, envelope, provider);
}

async function respondToProbe(channelId, requestId, provider) {
  let models;
  try {
    const tags = await ollamaListModels();
    models = (tags?.models || []).map((m) => ({
      name: m.name,
      size: m.size ?? null,
      family: m.details?.family ?? null,
    }));
  } catch (err) {
    log.warn('[InferenceProvider] probe: listModels failed:', err?.message || err);
    // Silent on probe failure — peer treats as offline. Better than
    // broadcasting an error message; the toggle being on doesn't mean
    // we can serve right now.
    return;
  }

  await publishEnvelope(channelId, {
    v: ENVELOPE_VERSION,
    kind: KIND_PROBE_ACK,
    requestId,
    providerInboxId: provider.providerInboxId,
    providerAddress: provider.providerAddress,
    models,
    sentAt: new Date().toISOString(),
  });
}

async function respondToRequest(channelId, envelope, provider) {
  const { requestId, model: modelArg, prompt, system, options } = envelope;

  if (typeof prompt !== 'string' || prompt.length === 0) {
    log.warn('[InferenceProvider] dropping request: missing prompt');
    return;
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    log.warn(
      `[InferenceProvider] dropping request: prompt > ${MAX_PROMPT_BYTES} bytes`
    );
    return;
  }

  // Resolve which local model we'll use. Wildcard => first installed.
  let installed;
  try {
    const tags = await ollamaListModels();
    installed = (tags?.models || []).map((m) => m.name);
  } catch (err) {
    log.warn('[InferenceProvider] request: listModels failed:', err?.message || err);
    return; // Ollama not available — silent, peer just doesn't hear from us.
  }

  let resolvedModel;
  if (!modelArg || modelArg === '*') {
    resolvedModel = installed[0];
  } else if (installed.includes(modelArg)) {
    resolvedModel = modelArg;
  } else {
    // We don't have the requested model — don't volunteer an error reply.
    // Other peers may have it; let the consumer hear from one of them.
    return;
  }
  if (!resolvedModel) {
    // Toggle is on but no models installed. Silent.
    return;
  }

  // Run inference and reply with the result. Errors here DO produce a
  // response — we already implicitly committed by being a matching
  // provider, and the consumer is waiting for our specific requestId.
  const startedAt = Date.now();
  let content = null;
  let error = null;
  try {
    content = await ollamaChat({
      model: resolvedModel,
      prompt,
      system,
      options,
    });
  } catch (err) {
    error = err?.message || String(err);
    log.warn(`[InferenceProvider] inference failed (model=${resolvedModel}):`, error);
  }
  const latencyMs = Date.now() - startedAt;

  await publishEnvelope(channelId, {
    v: ENVELOPE_VERSION,
    kind: KIND_RESPONSE,
    requestId,
    providerInboxId: provider.providerInboxId,
    providerAddress: provider.providerAddress,
    model: resolvedModel,
    content,
    error,
    latencyMs,
    sentAt: new Date().toISOString(),
  });
}

async function publishEnvelope(channelId, payload) {
  try {
    await state.runtime.publish(channelId, payload);
  } catch (err) {
    log.warn(`[InferenceProvider] publish(${channelId}) failed:`, err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Internal: thin Ollama wrappers (only the two endpoints we need)
// ---------------------------------------------------------------------------

function ollamaListModels() {
  return ollamaMeta.listModels({
    baseUrl: state.getOllamaApiUrl(),
    fetchImpl: state.fetchImpl || undefined,
  });
}

async function ollamaChat({ model, prompt, system, options }) {
  const baseUrl = state.getOllamaApiUrl();
  const fetchImpl = state.fetchImpl || fetch;
  const messages = [];
  if (typeof system === 'string' && system.length > 0) {
    messages.push({ role: 'system', content: system });
  }
  messages.push({ role: 'user', content: prompt });

  const res = await fetchImpl(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      ...(options ? { options } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama /api/chat HTTP ${res.status}`);
  }
  const body = await res.json();
  const content = body?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Ollama /api/chat returned no message.content');
  }
  return content;
}

module.exports = {
  start,
  stop,
  isStarted,
  // Constants exposed for the consumer (peer-tools) so envelope shapes
  // stay in sync without a circular require.
  KIND_PROBE,
  KIND_PROBE_ACK,
  KIND_REQUEST,
  KIND_RESPONSE,
  ENVELOPE_VERSION,
  MAX_PROMPT_BYTES,
  // Test seams.
  _internals: {
    handleIncoming,
    respondToProbe,
    respondToRequest,
  },
};
