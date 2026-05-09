import { createTab } from '../tabs.js';

/**
 * Shared DOM helpers for the consent card's structured panels.
 *
 * Used today by:
 *   - typed-data signing (`wallet_sign_typed_data`, Phase 7d.4)
 *   - send-transaction (`wallet_send_transaction`, Phase 7d.5)
 *
 * Both render a section heading + a `dl` of key→value rows. The two
 * tools differ in *which* sections they emit and in the value-decoding
 * they do upstream; the row-building primitives are identical.
 *
 * Three value modes inside `addConsentRow`:
 *   - object/array → collapsed `<details>` with pretty JSON inside
 *     (summary "[N items]" or "[object]"). Keeps v1 readable for
 *     OpenSea-shaped lists without a recursive renderer.
 *   - opts.url → anchor with the `agent-tool-card-typed-link` class.
 *   - primitive → plain text.
 *
 * Null/undefined/empty values are silently omitted (silent guards
 * fail safer than rendering "undefined" to the user). Callers don't
 * need to filter their data before passing it in.
 */

export function makeConsentSection(heading, populate) {
  const section = document.createElement('section');
  section.className = 'agent-tool-card-typed-section';
  const headingEl = document.createElement('div');
  headingEl.className = 'agent-tool-card-typed-heading';
  headingEl.textContent = heading;
  section.appendChild(headingEl);
  const list = document.createElement('dl');
  list.className = 'agent-tool-card-typed-list';
  populate(list);
  section.appendChild(list);
  return section;
}

export function addConsentRow(list, key, value, opts = {}) {
  if (value === null || value === undefined || value === '') return;
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  if (value !== null && typeof value === 'object') {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = Array.isArray(value)
      ? `[${value.length} item${value.length === 1 ? '' : 's'}]`
      : '[object]';
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.className = 'agent-tool-mono';
    pre.textContent = JSON.stringify(value, null, 2);
    details.appendChild(pre);
    dd.appendChild(details);
  } else if (opts.url) {
    const a = document.createElement('a');
    a.className = 'agent-tool-card-typed-link';
    a.href = opts.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = String(value);
    // Open in a new Freedom tab on click instead of falling through to
    // Electron's default new-window handler. target=_blank + rel stay
    // as a fallback for keyboard middle-click and accessibility.
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (opts.url) createTab(opts.url);
    });
    dd.appendChild(a);
  } else {
    dd.textContent = String(value);
  }
  list.appendChild(dt);
  list.appendChild(dd);
}
