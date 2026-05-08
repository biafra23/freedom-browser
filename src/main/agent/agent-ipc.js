/**
 * Agent IPC
 *
 * Bridges the renderer to the local Ollama sidecar. Three concerns:
 *
 * 1. **Status** (`agent:status`) — point-in-time snapshot for the
 *    sidebar header: is the daemon reachable, what version, which
 *    models are installed.
 * 2. **Streaming chat** (`agent:chat:start` → `agent:chat:chunk` /
 *    `agent:chat:done`) — long-running, multi-chunk request. The
 *    invoke handler returns a `streamId` immediately; chunks flow
 *    over `event.sender.send` until a terminal `agent:chat:done`
 *    arrives. Mirrors the github-bridge progress-event pattern.
 * 3. **Cancellation** (`agent:chat:cancel`) — abort an in-flight
 *    stream by id.
 *
 * Streams are tracked per-sender (webContents id + streamId). When the
 * sender goes away we abort + drop the stream so a closed window can't
 * leak an Ollama request.
 */

const crypto = require('crypto');
const { ipcMain } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const { getVersion, listModels, streamChat } = require('./ollama-client');

// streamId -> { controller, senderId }
const activeStreams = new Map();

function newStreamId() {
  return crypto.randomBytes(8).toString('hex');
}

function dropStream(streamId) {
  activeStreams.delete(streamId);
}

function dropStreamsForSender(senderId) {
  for (const [streamId, entry] of activeStreams) {
    if (entry.senderId === senderId) {
      try {
        entry.controller.abort();
      } catch {
        // Aborting an already-finished controller is a no-op; ignore.
      }
      activeStreams.delete(streamId);
    }
  }
}

async function handleStatus() {
  try {
    const [version, tags] = await Promise.all([
      getVersion(),
      listModels().catch(() => ({ models: [] })),
    ]);
    return {
      running: true,
      version: version.version,
      models: (tags.models || []).map((m) => ({
        name: m.name,
        size: m.size,
        modified_at: m.modified_at,
      })),
    };
  } catch (err) {
    return {
      running: false,
      error: err.message,
      models: [],
    };
  }
}

async function startChatStream(event, { model, messages }) {
  if (!model || typeof model !== 'string') {
    return { error: 'model is required' };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'messages must be a non-empty array' };
  }

  const streamId = newStreamId();
  const controller = new AbortController();
  const sender = event.sender;
  const senderId = sender.id;
  activeStreams.set(streamId, { controller, senderId });

  // Don't await — we want to return the streamId immediately and
  // pump chunks asynchronously over `sender.send`.
  pumpChat({ streamId, sender, model, messages, signal: controller.signal }).finally(() => {
    dropStream(streamId);
  });

  return { streamId };
}

async function pumpChat({ streamId, sender, model, messages, signal }) {
  let fullContent = '';
  try {
    for await (const chunk of streamChat({ model, messages }, { signal })) {
      const piece = chunk?.message?.content || '';
      if (piece) {
        fullContent += piece;
        if (!sender.isDestroyed()) {
          sender.send(IPC.AGENT_CHAT_CHUNK, { streamId, content: piece });
        }
      }
      if (chunk.done) {
        if (!sender.isDestroyed()) {
          sender.send(IPC.AGENT_CHAT_DONE, {
            streamId,
            fullContent,
            stats: {
              total_duration: chunk.total_duration,
              eval_count: chunk.eval_count,
              prompt_eval_count: chunk.prompt_eval_count,
            },
          });
        }
        return;
      }
    }
    // Stream ended without an explicit `done:true` — surface the partial.
    if (!sender.isDestroyed()) {
      sender.send(IPC.AGENT_CHAT_DONE, { streamId, fullContent });
    }
  } catch (err) {
    if (signal.aborted) {
      log.info(`[Agent] Chat stream ${streamId} cancelled`);
      if (!sender.isDestroyed()) {
        sender.send(IPC.AGENT_CHAT_DONE, { streamId, fullContent, cancelled: true });
      }
      return;
    }
    log.error(`[Agent] Chat stream ${streamId} failed:`, err.message);
    if (!sender.isDestroyed()) {
      sender.send(IPC.AGENT_CHAT_DONE, {
        streamId,
        fullContent,
        error: err.message,
      });
    }
  }
}

function cancelChatStream(_event, { streamId }) {
  const entry = activeStreams.get(streamId);
  if (!entry) {
    return { cancelled: false };
  }
  try {
    entry.controller.abort();
  } catch {
    // Aborting an already-finished controller is a no-op.
  }
  activeStreams.delete(streamId);
  return { cancelled: true };
}

function registerAgentIpc() {
  ipcMain.handle(IPC.AGENT_STATUS, () => handleStatus());
  ipcMain.handle(IPC.AGENT_CHAT_START, (event, payload) => startChatStream(event, payload));
  ipcMain.handle(IPC.AGENT_CHAT_CANCEL, (event, payload) => cancelChatStream(event, payload));

  // Drop any in-flight streams when a renderer goes away.
  // Unlike `webContents.on('destroyed')`, this also catches reload navigations.
  const { app } = require('electron');
  app.on('web-contents-created', (_event, contents) => {
    contents.on('destroyed', () => dropStreamsForSender(contents.id));
  });

  log.info('[Agent] IPC registered');
}

module.exports = {
  registerAgentIpc,
  // Exported for tests.
  _internals: {
    activeStreams,
    handleStatus,
    startChatStream,
    cancelChatStream,
    pumpChat,
    dropStreamsForSender,
  },
};
