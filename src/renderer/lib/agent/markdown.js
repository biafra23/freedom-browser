/**
 * Markdown rendering for agent messages.
 *
 * Uses `window.marked` (loaded as a classic script from
 * `vendor/marked.min.js`) for parsing, and `window.DOMPurify`
 * (`vendor/purify.min.js`) for sanitisation. Mirrors the pattern
 * the rad-browser internal page already uses for repo READMEs.
 *
 * Even with the page CSP blocking inline `<script>` and
 * `script-src 'self'`, an attacker-controlled `[click](javascript:...)`
 * inside a model response is otherwise still a working XSS vector
 * once the model gains tool-call context. DOMPurify covers that and
 * the broader long tail (event handlers, `srcdoc`, `data:` images
 * outside the allowlist, etc.).
 */

/* global marked, DOMPurify */

let configured = false;

function ensureConfigured() {
  if (configured) return;
  if (typeof marked === 'undefined') {
    throw new Error('[agent/markdown] window.marked is not loaded');
  }
  marked.setOptions({ gfm: true, breaks: true });
  configured = true;
}

export function renderMarkdown(text) {
  if (!text) return '';
  ensureConfigured();
  const rawHtml = marked.parse(text);
  if (typeof DOMPurify === 'undefined') {
    throw new Error('[agent/markdown] window.DOMPurify is not loaded');
  }
  return DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['target', 'rel'],
  });
}
