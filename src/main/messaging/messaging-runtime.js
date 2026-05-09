/**
 * Messaging Runtime
 *
 * Orchestrates the XMTP client + per-channel subscriptions for the Freedom
 * main process. Keeps the boundary between identity / storage on one side
 * and IPC / UI on the other:
 *
 *   identity-manager (unlock) ──► messaging-runtime.start({pk,addr})
 *                                       │
 *                                       │ wraps xmtp-client + channel
 *                                       ▼
 *                                 messaging-ipc ◄── renderer (window.messaging)
 *
 * Lifecycle:
 *   - start({privateKey, address, env?}): boots xmtp-client, kicks off the
 *     "subscribe to every group" loop, persists the chosen env.
 *   - stop(): tears down all per-channel subscriptions and stops the client.
 *
 * Channel semantics under "1 account = 1 instance": a channel is an MLS
 * group that contains the local installation plus N peer installations.
 * For now we always create 2-party channels via createChannel({peerAddress}).
 *
 * Live updates: a single global handler (set via onMessage) is invoked for
 * every received message on every channel. Channels are auto-subscribed
 * after start() and after createChannel(). The IPC layer fans out to every
 * renderer; the runtime stays UI-agnostic.
 *
 * Errors during start surface via getStatus().error. The runtime tolerates
 * being started before ollama / the network is ready — it simply reports
 * `started: false` and lets the renderer retry.
 */

const path = require('path');
const log = require('electron-log');

const xmtpClient = require('./xmtp-client');
const channelMod = require('./channel');
const lobbyClient = require('./lobby-client');

const DEFAULT_ENV = 'dev';

// Module-scoped singleton state. The main process only ever runs one
// XMTP client (one identity), so a singleton matches reality.
const state = {
  starting: false,
  started: false,
  identity: null, // { address, inboxId, installationId, env }
  error: null,
  // channelId -> { channel, unsubscribe }
  subscriptions: new Map(),
  // Set of message listeners. Fired on every received message across every
  // channel. Multi-listener so the IPC layer (renderer fan-out) and main-side
  // consumers (e.g. inference-provider, peer-tools' pending-response waits)
  // can coexist without stepping on each other.
  listeners: new Set(),
  // Storage root (for the XMTP DB). Captured at start() time.
  dataDir: null,
  // Test seam — lets messaging-runtime.test.js inject mock implementations
  // without touching xmtp-client / channel at the require-cache level.
  __overrides: null,
};

function getXmtpClient() {
  return state.__overrides?.xmtpClient || xmtpClient;
}

function getChannelMod() {
  return state.__overrides?.channelMod || channelMod;
}

function getLobbyClient() {
  return state.__overrides?.lobbyClient || lobbyClient;
}

/**
 * Compute the messaging data directory for the current install.
 * Mirrors getBeeDataDir / getIpfsDataDir conventions in identity-manager.
 *
 * @param {Electron.App} app
 * @returns {string}
 */
function getMessagingDataDir(app) {
  if (!app.isPackaged) {
    return path.join(__dirname, '..', '..', '..', 'messaging-data');
  }
  return path.join(app.getPath('userData'), 'messaging-data');
}

/**
 * Boot the messaging runtime for the given identity. Idempotent — calling
 * with the same identity is a no-op.
 *
 * @param {object} opts
 * @param {string} opts.privateKey - 0x hex
 * @param {string} opts.address - 0x EVM address
 * @param {string} opts.dataDir - directory for the local XMTP DB
 * @param {string} [opts.env] - XMTP network env
 * @returns {Promise<{started: boolean, address?: string, inboxId?: string, env?: string, error?: string}>}
 */
async function start({ privateKey, address, dataDir, env = DEFAULT_ENV }) {
  if (state.started || state.starting) {
    return getStatus();
  }
  state.starting = true;
  state.error = null;
  state.dataDir = dataDir;
  try {
    log.info(`[MessagingRuntime] starting (env=${env}, addr=${address})`);
    const info = await getXmtpClient().start({ privateKey, address, dataDir, env });
    state.identity = {
      address: info.address,
      inboxId: info.inboxId,
      installationId: info.installationId,
      env: info.env,
    };
    state.started = true;
    log.info(
      `[MessagingRuntime] ready (inboxId=${info.inboxId}, address=${info.address}, env=${info.env})`
    );
    // Subscribe to existing channels in the background — don't block start
    // on a network operation.
    subscribeAllExistingChannels().catch((err) => {
      log.warn('[MessagingRuntime] background subscribe failed:', err);
    });
    // Kick off the global-lobby join handshake in the background. After it
    // resolves, re-run subscribeAll so the lobby group lands in the
    // channels list without the user having to refresh.
    ensureLobbyMembershipBackground();
    return getStatus();
  } catch (err) {
    state.error = err?.message || String(err);
    state.started = false;
    state.identity = null;
    log.error('[MessagingRuntime] start failed:', err);
    return getStatus();
  } finally {
    state.starting = false;
  }
}

/**
 * Tear down subscriptions and stop the XMTP client. Idempotent.
 */
async function stop() {
  if (!state.started && state.subscriptions.size === 0) return;
  log.info('[MessagingRuntime] stopping');
  for (const [channelId, sub] of state.subscriptions.entries()) {
    try {
      await sub.unsubscribe?.();
    } catch (err) {
      log.warn(`[MessagingRuntime] unsubscribe(${channelId}) failed:`, err);
    }
  }
  state.subscriptions.clear();
  try {
    getXmtpClient().stop();
  } catch (err) {
    log.warn('[MessagingRuntime] xmtp stop failed:', err);
  }
  state.started = false;
  state.identity = null;
  state.error = null;
}

/**
 * Snapshot of the runtime's externally-visible state. Always returns an
 * object — never throws.
 */
function getStatus() {
  return {
    started: state.started,
    address: state.identity?.address || null,
    inboxId: state.identity?.inboxId || null,
    installationId: state.identity?.installationId || null,
    env: state.identity?.env || null,
    error: state.error,
  };
}

/**
 * Whether the runtime has booted successfully.
 */
function isStarted() {
  return state.started;
}

function requireStarted() {
  if (!state.started) {
    throw new Error('messaging-runtime: not started — unlock the vault first');
  }
}

// ---------------------------------------------------------------------------
// Channel operations — thin wrappers that capture the active client.
// ---------------------------------------------------------------------------

/**
 * List all channels (MLS groups) the local client is a member of. Returns
 * the renderer-shaped channel summary (id, name, members), not the raw
 * Channel instances — that keeps SDK objects out of the IPC boundary.
 *
 * @returns {Promise<Array<{id, name, memberCount, memberInboxIds, isOwn}>>}
 */
async function listChannels() {
  requireStarted();
  const client = getXmtpClient().getClient();
  const channels = await getChannelMod().listChannels(client);
  const out = [];
  for (const ch of channels) {
    const memberInboxIds = await ch.members();
    const name = ch._group?.name || null;
    out.push({
      id: ch.id,
      name,
      memberCount: memberInboxIds.length,
      memberInboxIds,
    });
  }
  return out;
}

/**
 * Create a new channel with one or more peer EVM addresses.
 * Auto-subscribes the new channel so its messages flow to the global handler.
 *
 * @param {object} opts
 * @param {string[]} opts.peerAddresses - 0x EVM addresses
 * @param {string} [opts.name] - human-readable name
 * @returns {Promise<{id, name, memberCount, memberInboxIds}>}
 */
async function createChannel({ peerAddresses, name } = {}) {
  requireStarted();
  if (!Array.isArray(peerAddresses) || peerAddresses.length === 0) {
    throw new Error('createChannel: peerAddresses[] is required');
  }
  const client = getXmtpClient().getClient();
  const channel = await getChannelMod().createChannelByAddresses(client, {
    memberAddresses: peerAddresses,
    name,
  });
  await subscribeChannel(channel);
  const memberInboxIds = await channel.members();
  return {
    id: channel.id,
    name: name || null,
    memberCount: memberInboxIds.length,
    memberInboxIds,
  };
}

/**
 * Read recent messages on a channel. Forwards to channel.messages().
 *
 * @param {string} channelId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Array>}
 */
async function getChannelMessages(channelId, { limit = 100 } = {}) {
  requireStarted();
  const channel = await openChannel(channelId);
  return channel.messages({ limit });
}

/**
 * Publish a JSON-serializable payload to a channel. The payload is whatever
 * the higher layer wants — a task, a chat string, a structured envelope.
 *
 * @param {string} channelId
 * @param {*} payload
 * @returns {Promise<string>} XMTP message ID
 */
async function publish(channelId, payload) {
  requireStarted();
  const channel = await openChannel(channelId);
  return channel.publish(payload);
}

/**
 * Register a message listener. Returns an unsubscribe function. Multiple
 * listeners can be active concurrently — each receives every message on
 * every channel (own messages are filtered out by channel.subscribe). A
 * listener that throws is logged and isolated; other listeners still fire.
 *
 * @param {(arg: {channelId: string, message: object}) => void|Promise<void>} listener
 * @returns {() => void} unsubscribe
 */
function addMessageListener(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('addMessageListener: listener must be a function');
  }
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * Returns the cached Freedom Lobby group ID for the active identity, or
 * null if the install hasn't completed the lobby join handshake yet (or if
 * the cache references a different env / inboxId, in which case the lobby
 * client will rerun the handshake on next start).
 *
 * @returns {string|null}
 */
function getLobbyChannelId() {
  if (!state.dataDir || !state.identity) return null;
  const cache = getLobbyClient().readLobbyCache?.(state.dataDir);
  if (!cache?.groupId) return null;
  if (cache.env && cache.env !== state.identity.env) return null;
  if (cache.inboxId && cache.inboxId !== state.identity.inboxId) return null;
  return cache.groupId;
}

// ---------------------------------------------------------------------------
// Internal subscription management
// ---------------------------------------------------------------------------

async function subscribeAllExistingChannels() {
  const client = getXmtpClient().getClient();
  const channels = await getChannelMod().listChannels(client);
  for (const ch of channels) {
    if (state.subscriptions.has(ch.id)) continue;
    try {
      await subscribeChannel(ch);
    } catch (err) {
      log.warn(`[MessagingRuntime] subscribe(${ch.id}) failed:`, err);
    }
  }
}

async function subscribeChannel(channel) {
  if (state.subscriptions.has(channel.id)) return;
  const channelId = channel.id;
  const unsubscribe = await channel.subscribe(async (message) => {
    if (state.listeners.size === 0) return;
    for (const listener of state.listeners) {
      try {
        await listener({ channelId, message });
      } catch (err) {
        log.warn(`[MessagingRuntime] listener(${channelId}) threw:`, err);
      }
    }
  });
  state.subscriptions.set(channelId, { channel, unsubscribe });
  log.info(`[MessagingRuntime] subscribed to channel ${channelId}`);
}

async function openChannel(channelId) {
  const existing = state.subscriptions.get(channelId);
  if (existing) return existing.channel;
  const client = getXmtpClient().getClient();
  const channel = await getChannelMod().openChannelById(client, channelId);
  if (!channel) throw new Error(`channel not found: ${channelId}`);
  // Lazily subscribe — first read implies "the user cares about this one".
  await subscribeChannel(channel);
  return channel;
}

/**
 * Background task: ensure the local installation is a member of the global
 * Freedom lobby. Errors are logged and swallowed — a missing lobby just
 * means the channel doesn't show up this session.
 */
function ensureLobbyMembershipBackground() {
  (async () => {
    try {
      const client = getXmtpClient().getClient();
      const env = state.identity?.env || DEFAULT_ENV;
      const result = await getLobbyClient().ensureLobbyMembership(client, state.dataDir, env);
      if (result && !result.fromCache) {
        // Newly joined — sync the conversations list so the new group is
        // visible to subscribeAllExistingChannels().
        try {
          await client.conversations.sync();
        } catch (err) {
          log.warn('[MessagingRuntime] post-lobby sync failed:', err);
        }
        await subscribeAllExistingChannels();
      }
    } catch (err) {
      log.warn('[MessagingRuntime] ensureLobbyMembership failed:', err);
    }
  })();
}

// ---------------------------------------------------------------------------
// Test seams (used only by messaging-runtime.test.js)
// ---------------------------------------------------------------------------

function _setOverridesForTesting(overrides) {
  state.__overrides = overrides;
}

function _resetForTesting() {
  state.starting = false;
  state.started = false;
  state.identity = null;
  state.error = null;
  state.subscriptions.clear();
  state.listeners.clear();
  state.dataDir = null;
  state.__overrides = null;
}

module.exports = {
  start,
  stop,
  getStatus,
  isStarted,
  listChannels,
  createChannel,
  getChannelMessages,
  publish,
  addMessageListener,
  getLobbyChannelId,
  getMessagingDataDir,
  _setOverridesForTesting,
  _resetForTesting,
};
