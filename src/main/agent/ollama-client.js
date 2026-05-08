/**
 * Ollama HTTP Client
 *
 * Thin async-iterator wrapper around the Ollama HTTP API
 * (`/api/chat`, `/api/version`, `/api/tags`). Built on Node 18+
 * built-in `fetch` so we don't pull in a streaming HTTP dep yet —
 * `undici` will move in here when we need pooled keep-alive or
 * SSE-style multiplexing.
 *
 * The Ollama daemon runs as a sidecar managed by the user (Phase 0/1)
 * — for now we assume it's already serving on http://127.0.0.1:11434.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

function getBaseUrl() {
  return process.env.OLLAMA_HOST || DEFAULT_BASE_URL;
}

/**
 * GET /api/version. Returns `{ version }` or throws if unreachable.
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [opts]
 */
async function getVersion(opts = {}) {
  const baseUrl = opts.baseUrl || getBaseUrl();
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(`${baseUrl}/api/version`);
  if (!res.ok) {
    throw new Error(`Ollama version check failed: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * GET /api/tags. Returns `{ models: [...] }` (array of installed models).
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string }} [opts]
 */
async function listModels(opts = {}) {
  const baseUrl = opts.baseUrl || getBaseUrl();
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(`${baseUrl}/api/tags`);
  if (!res.ok) {
    throw new Error(`Ollama listModels failed: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * POST /api/chat with `stream: true`. Yields parsed NDJSON chunks as they arrive.
 *
 * Each yielded chunk has the Ollama shape:
 *   { model, created_at, message: { role, content }, done, ...stats? }
 *
 * Caller controls cancellation via an AbortSignal.
 *
 * @param {{ model: string, messages: Array<{role: string, content: string}> }} request
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch, baseUrl?: string }} [opts]
 */
async function* streamChat(request, opts = {}) {
  const baseUrl = opts.baseUrl || getBaseUrl();
  const fetchImpl = opts.fetchImpl || fetch;
  const signal = opts.signal;

  const res = await fetchImpl(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, stream: true }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama chat failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.body) {
    throw new Error('Ollama chat returned no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      const value = result.value;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Skip malformed lines rather than abort the whole stream — Ollama's
          // NDJSON should always be well-formed, but defensive parsing keeps a
          // bad chunk from killing an otherwise good response.
          continue;
        }
        yield parsed;
        if (parsed.done) return;
      }
    }
    // Flush any trailing complete line (last chunk without newline).
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        // Same as above — malformed tail is non-fatal.
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released if we exited via the parsed.done branch.
    }
  }
}

module.exports = {
  getBaseUrl,
  getVersion,
  listModels,
  streamChat,
};
