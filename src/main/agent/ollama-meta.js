/**
 * Ollama Metadata Helpers
 *
 * Lightweight `fetch` wrappers for Ollama's two metadata endpoints
 * (`/api/version`, `/api/tags`). Chat itself goes through AI SDK Core
 * + the OpenAI-compatible provider; these endpoints are Ollama-native
 * and not exposed via `/v1/*`, so we hit them directly.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

function getBaseUrl() {
  return process.env.OLLAMA_HOST || DEFAULT_BASE_URL;
}

/**
 * GET /api/version. Returns `{ version }` or throws if unreachable.
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

module.exports = {
  getBaseUrl,
  getVersion,
  listModels,
};
