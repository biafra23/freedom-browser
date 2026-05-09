/**
 * Messaging IPC
 *
 * Bridges the renderer's window.messaging surface to the messaging-runtime.
 *
 * Channels (request/response):
 *   - messaging:get-status     → snapshot of runtime state
 *   - messaging:list-channels  → array of channel summaries
 *   - messaging:create-channel → create a new channel by peer addresses
 *   - messaging:get-messages   → recent messages on a channel
 *   - messaging:publish        → send a payload to a channel
 *
 * Push events (main → all renderers):
 *   - messaging:message        → { channelId, message } for every received msg
 *   - messaging:status-update  → snapshot of runtime status (after start/stop)
 *
 * Fan-out: a single global handler is set on the runtime; this module owns
 * the WebContents broadcast. Per-channel filtering is done in the renderer.
 *
 * Result envelope: every invoke handler returns `{ ok: true, data }` or
 * `{ ok: false, error }`. Mirrors the established pattern used by
 * identity / wallet / agent IPC, so renderers can do `if (!res.ok) ...`
 * uniformly.
 */

const { ipcMain, BrowserWindow } = require('electron');
const log = require('electron-log');
const IPC = require('../../shared/ipc-channels');
const runtime = require('./messaging-runtime');

// Date instances and other non-cloneable values can't cross the
// structuredClone IPC boundary as-is. Normalize message records here so
// renderers always receive plain JSON-friendly objects.
function serializeMessage(msg) {
  if (!msg) return null;
  return {
    id: msg.id,
    from: msg.from,
    sentAt: msg.sentAt instanceof Date ? msg.sentAt.toISOString() : msg.sentAt,
    content: msg.content,
    parsed: msg.parsed ?? null,
    parseError: msg.parseError ? String(msg.parseError.message || msg.parseError) : null,
    isOwn: !!msg.isOwn,
  };
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      log.warn('[MessagingIpc] broadcast failed:', err);
    }
  }
}

function emitStatusUpdate() {
  broadcast(IPC.MESSAGING_STATUS_UPDATE, runtime.getStatus());
}

function wrap(handler) {
  return async (...args) => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (err) {
      log.warn('[MessagingIpc] handler error:', err);
      return { ok: false, error: err?.message || String(err) };
    }
  };
}

let registered = false;

function registerMessagingIpc() {
  if (registered) return;
  registered = true;

  // Register the renderer fan-out listener. The runtime handles own-message
  // filtering via the underlying channel.subscribe(); this listener forwards
  // every received message to every BrowserWindow. Other listeners (e.g.
  // inference-provider, peer-tools' pending-response waits) plug in
  // independently via addMessageListener.
  runtime.addMessageListener(({ channelId, message }) => {
    broadcast(IPC.MESSAGING_MESSAGE, { channelId, message: serializeMessage(message) });
  });

  ipcMain.handle(
    IPC.MESSAGING_GET_STATUS,
    wrap(async () => runtime.getStatus())
  );

  ipcMain.handle(
    IPC.MESSAGING_LIST_CHANNELS,
    wrap(async () => runtime.listChannels())
  );

  ipcMain.handle(
    IPC.MESSAGING_CREATE_CHANNEL,
    wrap(async (_event, { peerAddresses, name } = {}) =>
      runtime.createChannel({ peerAddresses, name })
    )
  );

  ipcMain.handle(
    IPC.MESSAGING_GET_MESSAGES,
    wrap(async (_event, { channelId, limit } = {}) => {
      const messages = await runtime.getChannelMessages(channelId, { limit });
      return messages.map(serializeMessage);
    })
  );

  ipcMain.handle(
    IPC.MESSAGING_PUBLISH,
    wrap(async (_event, { channelId, payload } = {}) => runtime.publish(channelId, payload))
  );

  // Explicit start trigger for the renderer's "Start messaging" / "Retry"
  // buttons. Delegates to identity-manager so the wallet-derived key path
  // stays in one place. Lazy require to avoid a circular import at module
  // load time (identity-manager already requires messaging-ipc).
  ipcMain.handle(
    IPC.MESSAGING_START,
    wrap(async () => {
      const identityManager = require('../identity-manager');
      return identityManager.startMessagingForCurrentIdentity();
    })
  );

  log.info('[MessagingIpc] registered');
}

function _resetForTesting() {
  registered = false;
}

module.exports = {
  registerMessagingIpc,
  // Exported so identity-manager's unlock/lock paths can ping the
  // renderer when the runtime starts or stops.
  emitStatusUpdate,
  // Exposed for tests.
  _internals: { serializeMessage, broadcast },
  _resetForTesting,
};
