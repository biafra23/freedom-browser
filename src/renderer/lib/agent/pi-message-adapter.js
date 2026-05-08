/**
 * Pi Message Adapter
 *
 * Pi's session entries (`SessionEntry[]`) and messages (`AgentMessage[]`)
 * use a content-block shape — assistant messages are arrays of `text` /
 * `thinking` / `toolCall` blocks; tool results are separate messages
 * with their own `toolCallId`. The renderer's chat surface is simpler:
 * one bubble per message, with a flat `content` string for the body and
 * an optional `toolCalls` sidecar for Phase 3.
 *
 * This module bridges those shapes. Pure functions, no DOM access; the
 * UI layer renders the resulting view-model with its existing helpers.
 *
 * Phase 2 only renders text; thinking blocks and tool calls are dropped
 * from the view-model. Phase 3 will surface tool calls; Phase 6 will
 * surface thinking content via a collapsible panel.
 */

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      out += block.text;
    }
  }
  return out;
}

function adaptUserMessage(message) {
  const text = extractText(message.content);
  return { role: 'user', content: text };
}

function adaptAssistantMessage(message) {
  const text = extractText(message.content);
  if (!text) return null; // Pure-thinking / pure-toolCall messages are hidden in Phase 2.
  return { role: 'assistant', content: text };
}

function adaptMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.role === 'user') return adaptUserMessage(message);
  if (message.role === 'assistant') return adaptAssistantMessage(message);
  return null; // toolResult / bashExecution / custom / branchSummary / compactionSummary skipped.
}

/**
 * Map an array of Pi `AgentMessage` (e.g. from `agent.state.messages` or
 * `buildSessionContext().messages`) to renderer view-model messages.
 */
function adaptMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const message of messages) {
    const view = adaptMessage(message);
    if (view) out.push(view);
  }
  return out;
}

/**
 * Map an array of Pi `SessionEntry` (e.g. from `sessionManager.getEntries()`)
 * to renderer view-model messages by walking only `type: "message"` entries.
 *
 * Tree topology (parentId / branching / forks) is collapsed — the UI shows
 * the linear conversation order. Surfacing branches is a Phase 5 concern.
 */
function adaptEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const messages = [];
  for (const entry of entries) {
    if (entry?.type === 'message' && entry.message) {
      messages.push(entry.message);
    }
  }
  return adaptMessages(messages);
}

export { adaptMessages, adaptEntries, adaptMessage, extractText };
