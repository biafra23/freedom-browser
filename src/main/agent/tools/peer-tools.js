/**
 * Peer Inference Tools (consumer side — Phase Mx, hackathon mode)
 *
 * Two Pi tools that let the agent offload inference to other Freedom users
 * who have flipped the `aiSharedInferenceEnabled` toggle on. Both broadcast
 * over an XMTP channel (default: the global Freedom Lobby) and await
 * envelopes correlated by a fresh `requestId`.
 *
 *   peer_run_inference   — broadcasts `inference:request`, returns the
 *                          first matching `inference:response` (or throws
 *                          on timeout / abort). Wildcard `model: '*'`
 *                          accepts any model from any responding peer.
 *   peer_list_providers  — broadcasts `inference:probe`, collects every
 *                          `inference:probe-ack` for `timeoutMs`, returns
 *                          the list. Useful before run_inference if the
 *                          model is uncertain.
 *
 * Threat model & UX (matches the provider side in inference-provider.js):
 *   - Tier PEER_INFERENCE / session-once: ask the first time per chat
 *     thread, remember the choice.
 *   - Prompts sent to the lobby are visible to every member; the consent
 *     description surfaces the channel + truncated prompt so the user
 *     sees what's being broadcast.
 *   - First-response-wins. A malicious peer can return garbage. Worth a
 *     note in the bundled skill.
 *   - The provider listener and these tools share envelope shapes via
 *     constants imported from inference-provider — single source of truth
 *     for kind strings and the version pin.
 */

const { TIERS } = require('../tool-tiers');
const { jsonResult } = require('./_helpers');
const messagingRuntime = require('../../messaging/messaging-runtime');
const inferenceProvider = require('../../messaging/inference-provider');
const { loadSettings } = require('../../settings-store');
const { shortAddress } = require('../../../shared/address-utils');

const {
  KIND_PROBE,
  KIND_PROBE_ACK,
  KIND_REQUEST,
  KIND_RESPONSE,
  ENVELOPE_VERSION,
} = inferenceProvider;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

// Mirror lobby-client's id shape so cross-envelope IDs look familiar in
// logs / inspectors. Crypto-strength isn't required; uniqueness within a
// single session is sufficient because we filter incoming envelopes by
// requestId AND by listener registration window.
function newRequestId() {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Resolve the channel id to broadcast to. Precedence:
//   1. Explicit `channelId` passed to the tool — always wins.
//   2. `aiInferenceChannelId` setting — user-pinned override (e.g. when
//      the demo channel isn't the auto-joined Freedom Lobby).
//   3. Auto-joined Freedom Lobby groupId.
//   4. Throw with a model-readable hint.
function resolveChannelOrThrow(explicit) {
  if (explicit && typeof explicit === 'string') return explicit;
  const settings = loadSettings();
  const pinned = settings?.aiInferenceChannelId;
  if (pinned && typeof pinned === 'string' && pinned.length > 0) return pinned;
  const lobbyId = messagingRuntime.getLobbyChannelId();
  if (lobbyId) return lobbyId;
  throw new Error(
    'No inference channel resolved. Either pass an explicit `channelId`, set `aiInferenceChannelId` in AI settings, or wait for the Freedom Lobby auto-join to complete (admin daemon may be offline).'
  );
}

function truncate(text, max = 80) {
  if (typeof text !== 'string') return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Listen on the runtime for envelopes matching `predicate`, resolve when
// `predicate` returns truthy. Cleans up on resolve, reject, abort, or
// timeout. Reuse pattern across both tools — one for first-match (run),
// one for collect-until-timeout (probe).
function awaitFirstMatch({ predicate, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      try {
        unsubscribe?.();
      } catch {
        // best-effort
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error(`No reply within ${timeoutMs}ms`));
    }, timeoutMs);
    const abortHandler = signal
      ? () => {
          if (settled) return;
          cleanup();
          reject(new Error('Aborted by caller'));
        }
      : null;
    if (signal) signal.addEventListener('abort', abortHandler);
    if (signal?.aborted) {
      cleanup();
      reject(new Error('Aborted by caller'));
      return;
    }
    const unsubscribe = messagingRuntime.addMessageListener(({ channelId, message }) => {
      if (settled) return;
      const result = predicate({ channelId, message });
      if (result) {
        cleanup();
        resolve(result);
      }
    });
  });
}

// Collect every match until timeout; abort short-circuits. Returns the
// accumulated array (possibly empty). Used by peer_list_providers.
function collectUntilTimeout({ predicate, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const collected = [];
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      try {
        unsubscribe?.();
      } catch {
        // best-effort
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      resolve(collected);
    }, timeoutMs);
    const abortHandler = signal
      ? () => {
          if (settled) return;
          cleanup();
          reject(new Error('Aborted by caller'));
        }
      : null;
    if (signal) signal.addEventListener('abort', abortHandler);
    if (signal?.aborted) {
      cleanup();
      reject(new Error('Aborted by caller'));
      return;
    }
    const unsubscribe = messagingRuntime.addMessageListener(({ channelId, message }) => {
      if (settled) return;
      const item = predicate({ channelId, message });
      if (item) collected.push(item);
    });
  });
}

function createPeerTools({ Type }) {
  const peerRunInference = {
    name: 'peer_run_inference',
    label: 'Run inference on a peer',
    description:
      'Broadcast a prompt to a Freedom messaging channel (default: the global Freedom Lobby) and return the first willing peer\'s reply. ' +
      'The peer runs the requested model through their local Ollama. ' +
      'Use when the user explicitly asks to "ask the network", "run on a peer", ' +
      'or wants to demo distributed inference.',
    tier: TIERS.PEER_INFERENCE,
    promptSnippet: 'broadcast a prompt to the Freedom Lobby and return the first peer reply',
    promptGuidelines: [
      'Only call peer_run_inference when the user explicitly asks for it ("ask the network", "run on a peer", "use the lobby"). It is NOT a routing layer for normal chat — your local model handles those.',
      'Pass `model: "*"` (default) to accept any model from any responding peer. Pass a specific name (e.g. "gemma4:e2b") only if the user asked for one.',
      'First-response-wins — there is no quorum or trust check. A peer could return garbage. Surface the response with attribution ("via 0xshort") so the user can judge.',
      'Provide a clear `reason` explaining why the user wanted this routed to the network, not the local model.',
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 16000 }),
      reason: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String()),
      channelId: Type.Optional(Type.String()),
      system: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 120000 })),
    }),
    formatConsentDescription: ({ prompt, model, reason, channelId }) => {
      const target = channelId ? `channel ${channelId.slice(0, 10)}…` : 'Freedom Lobby';
      const modelLabel = !model || model === '*' ? 'any model' : model;
      return `Broadcast to ${target} (${modelLabel}). Reason: ${reason}\nPrompt: ${truncate(prompt, 200)}`;
    },
    async execute(_id, params, signal) {
      const channelId = resolveChannelOrThrow(params.channelId);
      const requestId = newRequestId();
      const timeoutMs = params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const startedAt = Date.now();

      // Register the response listener BEFORE publishing so a fast peer
      // reply can't race past us. Same pattern as lobby-client.awaitAck.
      const wait = awaitFirstMatch({
        timeoutMs,
        signal,
        predicate: ({ channelId: ch, message }) => {
          if (ch !== channelId) return null;
          const env = message?.parsed;
          if (env?.kind !== KIND_RESPONSE) return null;
          if (env.requestId !== requestId) return null;
          return env;
        },
      });

      await messagingRuntime.publish(channelId, {
        v: ENVELOPE_VERSION,
        kind: KIND_REQUEST,
        requestId,
        model: params.model || '*',
        prompt: params.prompt,
        ...(params.system ? { system: params.system } : {}),
        sentAt: new Date().toISOString(),
      });

      const reply = await wait;
      const elapsedMs = Date.now() - startedAt;
      return jsonResult({
        channelId,
        requestId,
        elapsedMs,
        provider: {
          inboxId: reply.providerInboxId,
          address: reply.providerAddress,
          shortAddress: reply.providerAddress ? shortAddress(reply.providerAddress) : null,
        },
        model: reply.model,
        content: reply.content,
        error: reply.error || null,
        latencyMs: reply.latencyMs ?? null,
      });
    },
  };

  const peerListProviders = {
    name: 'peer_list_providers',
    label: 'List inference providers',
    description:
      'Broadcast a probe to a Freedom messaging channel (default: the global Freedom Lobby) and return the list of peers who replied along with the models each has installed. ' +
      'Use before peer_run_inference when uncertain who is online or which models are available.',
    tier: TIERS.PEER_INFERENCE,
    promptSnippet: 'probe a Freedom channel for available inference providers',
    promptGuidelines: [
      'peer_list_providers is a discovery probe — call it when the user asks "who is online to run inference" or before peer_run_inference if you do not know which model to request.',
      'Empty results are normal — most Freedom users will have shared inference disabled. Fall back to the local model with a clear note to the user.',
    ],
    parameters: Type.Object({
      reason: Type.String({ minLength: 1 }),
      channelId: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number({ minimum: 500, maximum: 30000 })),
    }),
    formatConsentDescription: ({ reason, channelId }) => {
      const target = channelId ? `channel ${channelId.slice(0, 10)}…` : 'Freedom Lobby';
      return `Probe ${target} for online inference providers. Reason: ${reason}`;
    },
    async execute(_id, params, signal) {
      const channelId = resolveChannelOrThrow(params.channelId);
      const requestId = newRequestId();
      const timeoutMs = params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
      const startedAt = Date.now();

      const wait = collectUntilTimeout({
        timeoutMs,
        signal,
        predicate: ({ channelId: ch, message }) => {
          if (ch !== channelId) return null;
          const env = message?.parsed;
          if (env?.kind !== KIND_PROBE_ACK) return null;
          if (env.requestId !== requestId) return null;
          return {
            inboxId: env.providerInboxId,
            address: env.providerAddress,
            shortAddress: env.providerAddress ? shortAddress(env.providerAddress) : null,
            models: env.models || [],
          };
        },
      });

      await messagingRuntime.publish(channelId, {
        v: ENVELOPE_VERSION,
        kind: KIND_PROBE,
        requestId,
        sentAt: new Date().toISOString(),
      });

      const providers = await wait;
      const elapsedMs = Date.now() - startedAt;
      return jsonResult({
        channelId,
        requestId,
        elapsedMs,
        timeoutMs,
        providerCount: providers.length,
        providers,
      });
    },
  };

  return [peerRunInference, peerListProviders];
}

module.exports = {
  createPeerTools,
  // Test seams.
  _internals: {
    awaitFirstMatch,
    collectUntilTimeout,
    newRequestId,
    resolveChannelOrThrow,
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_PROBE_TIMEOUT_MS,
  },
};
