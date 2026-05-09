/**
 * Tool Card Renderers
 *
 * Per-tool inline summary builders for the assistant tool-call cards.
 * The default JSON-blob rendering treated every tool the same; users
 * had to read JSON to know what happened. These renderers produce
 * conversational one-liners ("Navigated to <url>", "Clicked <selector>",
 * inline screenshot thumbnail) with optional disclosures for bulky
 * payloads. Falls back to JSON for any tool not in the dispatch map.
 *
 * Each renderer returns a `DocumentFragment` representing the card's
 * body content (everything beneath the header). Empty fragments are
 * legitimate for in-flight calls where the args alone would just
 * duplicate the header text.
 *
 * Pure: no module-level state, no side effects beyond DOM creation.
 * Easy to test in isolation against fake-dom.
 */

import { shortAddress } from '../address-utils.js';
import { createTab } from '../tabs.js';

const URL_DISPLAY_MAX = 60;
const SELECTOR_DISPLAY_MAX = 80;
const SCREENSHOT_MAX_PX = 220;

// The container class spawn_subagent renderers emit as a child of the
// parent card's body. Inner subagent tool calls attach inside this slot
// (chat-ui's `targetForToolCard`). Exported so the renderer/host
// agreement is enforced at the import line, not by string matching.
export const SUBAGENT_CHILDREN_CLASS = 'agent-tool-subagent-children';

function truncateMiddle(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

// Click on an agent UI anchor → open in a new Freedom tab via the
// existing tabs.js API instead of falling through to Electron's
// default new-window behaviour (which spawns a bare BrowserWindow
// outside the tab strip). target=_blank + rel stay as a fallback for
// keyboard middle-click and accessibility.
function openInTabOnClick(anchor) {
  anchor.addEventListener('click', (e) => {
    e.preventDefault();
    const url = anchor.href;
    if (url && url !== '#') createTab(url);
  });
  return anchor;
}

function makeUrlPill(url) {
  const a = document.createElement('a');
  a.className = 'agent-tool-url-pill';
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = url;
  a.textContent = truncateMiddle(url, URL_DISPLAY_MAX);
  return openInTabOnClick(a);
}

function makeSelectorPill(selector) {
  const code = document.createElement('code');
  code.className = 'agent-tool-selector-pill';
  code.title = selector;
  code.textContent = truncateMiddle(selector, SELECTOR_DISPLAY_MAX);
  return code;
}

function makeSummary(text) {
  const span = document.createElement('span');
  span.className = 'agent-tool-summary';
  if (text) span.textContent = text;
  return span;
}

function makeDisclosure(label, body) {
  const details = document.createElement('details');
  details.className = 'agent-tool-disclosure';
  const summary = document.createElement('summary');
  summary.className = 'agent-tool-disclosure-summary';
  summary.textContent = label;
  details.appendChild(summary);
  details.appendChild(body);
  return details;
}

function makeMonoBlock(text, className = 'agent-tool-mono') {
  const pre = document.createElement('pre');
  pre.className = className;
  pre.textContent = text;
  return pre;
}

const STATUS_ERROR = new Set(['error', 'denied', 'blocked']);

function isFailure(call) {
  return STATUS_ERROR.has(call.status) || !!call.result?.error;
}

function failureText(call) {
  return call.result?.error || `${call.status || 'failed'}`;
}

// --- Per-tool renderers ----------------------------------------------------

function renderNavigate(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Navigation failed: ${failureText(call)}`));
    return frag;
  }
  const url = call.result?.url || call.args?.url;
  if (!url) {
    frag.appendChild(makeSummary(call.status === 'pending' ? 'Navigating…' : 'Navigated'));
    return frag;
  }
  const verb = call.status === 'pending' ? 'Navigating to ' : 'Navigated to ';
  const summary = makeSummary(verb);
  summary.appendChild(makeUrlPill(url));
  frag.appendChild(summary);
  return frag;
}

function renderReadCurrentTab(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Read failed: ${failureText(call)}`));
    return frag;
  }
  if (call.status === 'pending') {
    frag.appendChild(makeSummary('Reading current tab…'));
    return frag;
  }
  const { title, url, text } = call.result || {};
  const summary = makeSummary('Read ');
  if (title) {
    const strong = document.createElement('strong');
    strong.className = 'agent-tool-title';
    strong.textContent = truncateMiddle(title, 80);
    strong.title = title;
    summary.appendChild(strong);
  } else if (url) {
    summary.appendChild(makeUrlPill(url));
  } else {
    summary.append('current tab');
  }
  frag.appendChild(summary);
  if (text) {
    const chars = String(text).length;
    frag.appendChild(makeDisclosure(`Show extracted text (${chars} chars)`, makeMonoBlock(text)));
  }
  return frag;
}

function renderClick(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Click failed: ${failureText(call)}`));
    return frag;
  }
  const sel = call.args?.selector;
  if (call.status === 'pending') {
    const s = makeSummary('Clicking ');
    if (sel) s.appendChild(makeSelectorPill(sel));
    frag.appendChild(s);
    return frag;
  }
  const clicked = call.result?.clicked;
  if (clicked === false) {
    const s = makeSummary('No element matched ');
    if (sel) s.appendChild(makeSelectorPill(sel));
    frag.appendChild(s);
    return frag;
  }
  const s = makeSummary('Clicked ');
  if (sel) s.appendChild(makeSelectorPill(sel));
  frag.appendChild(s);
  return frag;
}

function renderFill(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Fill failed: ${failureText(call)}`));
    return frag;
  }
  const sel = call.args?.selector;
  const value = call.args?.value;
  if (call.status === 'pending') {
    const s = makeSummary('Filling ');
    if (sel) s.appendChild(makeSelectorPill(sel));
    frag.appendChild(s);
    return frag;
  }
  const filled = call.result?.filled;
  if (filled === false) {
    const s = makeSummary('No input matched ');
    if (sel) s.appendChild(makeSelectorPill(sel));
    frag.appendChild(s);
    return frag;
  }
  const s = makeSummary('Filled ');
  if (sel) s.appendChild(makeSelectorPill(sel));
  frag.appendChild(s);
  if (typeof value === 'string' && value.length > 0) {
    frag.appendChild(makeDisclosure(`Value (${value.length} chars)`, makeMonoBlock(value)));
  }
  return frag;
}

function renderScreenshot(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Screenshot failed: ${failureText(call)}`));
    return frag;
  }
  if (call.status === 'pending') {
    frag.appendChild(makeSummary('Capturing screenshot…'));
    return frag;
  }
  const { dataUrl, url } = call.result || {};
  if (!dataUrl) {
    frag.appendChild(makeSummary('Screenshot captured'));
    return frag;
  }
  const wrap = document.createElement('div');
  wrap.className = 'agent-tool-screenshot';
  const img = document.createElement('img');
  img.className = 'agent-tool-screenshot-img';
  img.src = dataUrl;
  img.alt = url ? `Screenshot of ${url}` : 'Screenshot';
  img.style.maxWidth = `${SCREENSHOT_MAX_PX}px`;
  wrap.appendChild(img);
  if (url) {
    const caption = document.createElement('div');
    caption.className = 'agent-tool-screenshot-caption';
    caption.appendChild(makeUrlPill(url));
    wrap.appendChild(caption);
  }
  frag.appendChild(wrap);
  return frag;
}

function renderListTabs(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`List tabs failed: ${failureText(call)}`));
    return frag;
  }
  if (call.status === 'pending') {
    frag.appendChild(makeSummary('Listing tabs…'));
    return frag;
  }
  const tabs = call.result?.tabs || [];
  const active = tabs.find((t) => t.isActive);
  const summary = makeSummary(`Listed ${tabs.length} tab${tabs.length === 1 ? '' : 's'}`);
  if (active) {
    summary.append(' — active: ');
    if (active.title) {
      const strong = document.createElement('strong');
      strong.className = 'agent-tool-title';
      strong.textContent = truncateMiddle(active.title, 60);
      strong.title = active.title;
      summary.appendChild(strong);
    } else if (active.url) {
      summary.appendChild(makeUrlPill(active.url));
    }
  }
  frag.appendChild(summary);
  if (tabs.length > 0) {
    const lines = tabs
      .map((t) => `[${t.id}]${t.isActive ? '*' : ' '} ${t.title || '(untitled)'} — ${t.url || ''}`)
      .join('\n');
    frag.appendChild(makeDisclosure(`Show all ${tabs.length} tabs`, makeMonoBlock(lines)));
  }
  return frag;
}

function renderOpenTab(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Open tab failed: ${failureText(call)}`));
    return frag;
  }
  const url = call.args?.url;
  if (call.status === 'pending') {
    const s = makeSummary('Opening new tab — ');
    if (url) s.appendChild(makeUrlPill(url));
    frag.appendChild(s);
    return frag;
  }
  const tab = call.result?.tab;
  const summary = makeSummary('Opened new tab ');
  if (tab?.url) summary.appendChild(makeUrlPill(tab.url));
  else if (url) summary.appendChild(makeUrlPill(url));
  frag.appendChild(summary);
  return frag;
}

function renderCloseTab(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Close tab failed: ${failureText(call)}`));
    return frag;
  }
  const id = call.args?.id;
  if (call.status === 'pending') {
    frag.appendChild(makeSummary(`Closing tab ${id ?? ''}…`.trim()));
    return frag;
  }
  const closed = call.result?.closed;
  frag.appendChild(makeSummary(closed ? `Closed tab ${id}` : `No tab matched id ${id}`));
  return frag;
}

function renderSwitchTab(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Switch tab failed: ${failureText(call)}`));
    return frag;
  }
  const id = call.args?.id;
  if (call.status === 'pending') {
    frag.appendChild(makeSummary(`Switching to tab ${id ?? ''}…`.trim()));
    return frag;
  }
  const switched = call.result?.switched;
  frag.appendChild(makeSummary(switched ? `Switched to tab ${id}` : `No tab matched id ${id}`));
  return frag;
}

function renderReadSkill(call) {
  const frag = document.createDocumentFragment();
  const requested = call.args?.name;
  if (isFailure(call) || call.result?.error) {
    const reason = call.result?.error === 'not_found'
      ? `Skill "${requested}" not found in the catalog`
      : `Read failed: ${failureText(call)}`;
    frag.appendChild(makeSummary(reason));
    return frag;
  }
  if (call.status === 'pending') {
    frag.appendChild(makeSummary(`Loading skill ${requested || ''}…`.trim()));
    return frag;
  }
  const { name, source, body } = call.result || {};
  const summary = makeSummary('Loaded skill ');
  const strong = document.createElement('strong');
  strong.className = 'agent-tool-title';
  strong.textContent = `/${name || requested}`;
  summary.appendChild(strong);
  if (source) summary.append(` (${source})`);
  frag.appendChild(summary);
  if (body) {
    frag.appendChild(makeDisclosure(`Recipe (${body.length} chars)`, makeMonoBlock(body)));
  }
  return frag;
}

function renderSpawnSubagent(call) {
  const frag = document.createDocumentFragment();
  const id = call.args?.subagent_id || 'subagent';
  const prompt = call.args?.prompt;

  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Subagent ${id} failed: ${failureText(call)}`));
    return frag;
  }

  if (call.status === 'pending') {
    frag.appendChild(makeSummary(`Subagent ${id} running…`));
  } else {
    const turns = call.result?.turnCount;
    const ms = call.result?.durationMs;
    const meta = [];
    if (typeof turns === 'number') meta.push(`${turns} turn${turns === 1 ? '' : 's'}`);
    if (typeof ms === 'number') meta.push(`${(ms / 1000).toFixed(1)}s`);
    const metaText = meta.length > 0 ? ` · ${meta.join(' · ')}` : '';
    frag.appendChild(makeSummary(`Subagent ${id}${metaText}`));
  }

  if (prompt) {
    frag.appendChild(makeDisclosure('Subagent prompt', makeMonoBlock(prompt)));
  }

  // Slot for the subagent's inner tool cards. chat-ui's
  // `targetForToolCard` routes any tool-call event tagged with
  // `subagentCallId === call.id` into this container. Always rendered
  // (even empty) so the host can assume the slot exists.
  const nested = document.createElement('div');
  nested.className = SUBAGENT_CHILDREN_CLASS;
  nested.dataset.subagentParent = call.id;
  frag.appendChild(nested);

  return frag;
}


function renderWalletSignMessage(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Signing failed: ${failureText(call)}`));
    return frag;
  }
  const address = call.result?.address || call.args?.address;
  const signature = call.result?.signature;
  if (call.status === 'pending') {
    const target = address ? shortAddress(address) : 'active wallet';
    frag.appendChild(makeSummary(`Signing message with ${target}…`));
    return frag;
  }
  // Post-execution: result.address is canonical (same as args.address if
  // provided, or the active-wallet address otherwise). Signature is a
  // 132-char hex blob — too long for the summary, lives in disclosure.
  const summary = makeSummary(`Signed with ${shortAddress(address)}`);
  frag.appendChild(summary);
  if (signature) {
    frag.appendChild(makeDisclosure('Signature', makeMonoBlock(signature)));
  }
  return frag;
}

function renderWalletSignTypedData(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Signing failed: ${failureText(call)}`));
    return frag;
  }
  const address = call.result?.address || call.args?.address;
  const signature = call.result?.signature;
  const domainName =
    call.result?.domain?.name || call.args?.typedData?.domain?.name || 'typed data';
  const primaryType = call.result?.primaryType || call.args?.typedData?.primaryType;
  const verb = primaryType ? `${primaryType} for ${domainName}` : domainName;
  if (call.status === 'pending') {
    const target = address ? shortAddress(address) : 'active wallet';
    frag.appendChild(makeSummary(`Signing ${verb} with ${target}…`));
    return frag;
  }
  const summary = makeSummary(`Signed ${verb} with ${shortAddress(address)}`);
  frag.appendChild(summary);
  if (signature) {
    frag.appendChild(makeDisclosure('Signature', makeMonoBlock(signature)));
  }
  return frag;
}

function renderWalletSendTransaction(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Send failed: ${failureText(call)}`));
    return frag;
  }
  const txHash = call.result?.txHash;
  const explorerUrl = call.result?.blockExplorerUrl;
  const to = call.result?.to || call.args?.to;
  if (call.status === 'pending') {
    frag.appendChild(makeSummary(`Sending transaction to ${shortAddress(to)}…`));
    return frag;
  }
  if (txHash) {
    const summary = makeSummary(`Sent to ${shortAddress(to)}: `);
    if (explorerUrl) {
      const link = document.createElement('a');
      link.className = 'agent-tool-url-pill';
      link.href = explorerUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = truncateMiddle(txHash, 18);
      summary.appendChild(openInTabOnClick(link));
    } else {
      const code = document.createElement('code');
      code.textContent = truncateMiddle(txHash, 18);
      summary.appendChild(code);
    }
    frag.appendChild(summary);
  } else {
    frag.appendChild(makeSummary('Sent'));
  }
  return frag;
}

// Shared renderer for wallet_get_transaction and wallet_wait_for_transaction.
// Both return the same unified receipt shape; same summary line + a
// disclosure for the full payload.
function renderWalletReceipt(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Receipt lookup failed: ${failureText(call)}`));
    return frag;
  }
  const status = call.result?.status;
  const hash = call.result?.hash || call.args?.hash;
  const explorerUrl = call.result?.blockExplorerUrl;
  if (call.status === 'pending') {
    frag.appendChild(makeSummary(`Looking up ${truncateMiddle(hash || '', 18)}…`));
    return frag;
  }
  // Headline: "Confirmed: Transfer 1.0 USDC to 0x… in block 1234"
  // or "Confirmed: 0.05 ETH to 0x… in block 1234" for native value.
  const action = call.result?.action;
  const blockSuffix = call.result?.blockNumber ? ` in block ${call.result.blockNumber}` : '';
  let line;
  if (status === 'confirmed' && action?.kind === 'erc20-transfer') {
    const amt = action.formattedAmount ?? `${action.rawAmount} (raw)`;
    const sym = action.tokenSymbol || 'tokens';
    line = `Confirmed: Transfer ${amt} ${sym} to ${shortAddress(action.recipient)}${blockSuffix}`;
  } else if (status === 'confirmed' && action?.kind === 'erc20-approve') {
    const amt = action.formattedAmount ?? `${action.rawAmount} (raw)`;
    const sym = action.tokenSymbol || 'tokens';
    line = `Confirmed: Approve ${shortAddress(action.spender)} for ${amt} ${sym}${blockSuffix}`;
  } else if (status === 'confirmed') {
    const v = call.result?.valueFormatted;
    const to = call.result?.to;
    line = v && v !== '0.0'
      ? `Confirmed: ${v} to ${shortAddress(to)}${blockSuffix}`
      : `Confirmed: contract call to ${shortAddress(to)}${blockSuffix}`;
  } else if (status === 'pending') {
    line = `Pending: ${truncateMiddle(hash || '', 18)} not yet mined`;
  } else if (status === 'failed') {
    line = `Failed: tx ${truncateMiddle(hash || '', 18)} reverted${blockSuffix}`;
  } else if (status === 'not_found') {
    line = `Not found: no record of ${truncateMiddle(hash || '', 18)}`;
  } else {
    line = `Unknown status (${call.result?.error || 'no error'})`;
  }
  const summary = makeSummary(line);
  if (explorerUrl) {
    const sep = document.createElement('span');
    sep.textContent = ' · ';
    summary.appendChild(sep);
    summary.appendChild(makeUrlPill(explorerUrl));
  }
  frag.appendChild(summary);
  return frag;
}

// Distributed-inference consumer. Headline shows who served the call,
// which model they used, and round-trip time. Disclosure carries the
// full reply text so the user can verify it without trusting the
// agent's paraphrase.
function renderPeerRunInference(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Peer inference failed: ${failureText(call)}`));
    return frag;
  }
  if (call.status === 'pending') {
    frag.appendChild(makeSummary('Broadcasting to lobby…'));
    return frag;
  }
  const r = call.result || {};
  const provider = r.provider || {};
  const providerLabel = provider.shortAddress || provider.address || provider.inboxId || 'unknown';
  const seconds = typeof r.elapsedMs === 'number' ? `${(r.elapsedMs / 1000).toFixed(1)}s` : '?';
  const model = r.model || 'unknown';
  const headline = r.error
    ? `Peer ${providerLabel} returned error: ${r.error}`
    : `Ran on ${providerLabel} in ${seconds} · ${model}`;
  frag.appendChild(makeSummary(headline));
  if (r.content) {
    frag.appendChild(makeDisclosure('Reply', makeMonoBlock(r.content)));
  }
  return frag;
}

function renderPeerListProviders(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(`Probe failed: ${failureText(call)}`));
    return frag;
  }
  if (call.status === 'pending') {
    frag.appendChild(makeSummary('Probing lobby for providers…'));
    return frag;
  }
  const r = call.result || {};
  const count = r.providerCount ?? 0;
  if (count === 0) {
    frag.appendChild(makeSummary('No providers replied (lobby may be quiet)'));
    return frag;
  }
  // Headline: "3 providers · gemma4:e2b, qwen3:4b" — collapse the model
  // sets into a unique-by-name list so the user gets a quick read on
  // what's reachable without expanding the disclosure.
  const allModels = new Set();
  for (const p of r.providers || []) {
    for (const m of p.models || []) {
      if (m?.name) allModels.add(m.name);
    }
  }
  const modelHint = allModels.size ? ` · ${[...allModels].slice(0, 5).join(', ')}` : '';
  frag.appendChild(makeSummary(`${count} provider${count === 1 ? '' : 's'}${modelHint}`));
  const lines = (r.providers || [])
    .map((p) => {
      const who = p.shortAddress || p.address || p.inboxId || '?';
      const models = (p.models || []).map((m) => m.name).join(', ');
      return `${who} → ${models || '(no models)'}`;
    })
    .join('\n');
  if (lines) {
    frag.appendChild(makeDisclosure('Providers', makeMonoBlock(lines)));
  }
  return frag;
}

const TOOL_RENDERERS = {
  navigate: renderNavigate,
  read_current_tab: renderReadCurrentTab,
  click: renderClick,
  fill: renderFill,
  screenshot: renderScreenshot,
  spawn_subagent: renderSpawnSubagent,
  read_skill: renderReadSkill,
  list_tabs: renderListTabs,
  open_tab: renderOpenTab,
  close_tab: renderCloseTab,
  switch_tab: renderSwitchTab,
  wallet_sign_message: renderWalletSignMessage,
  wallet_sign_typed_data: renderWalletSignTypedData,
  wallet_send_transaction: renderWalletSendTransaction,
  wallet_get_transaction: renderWalletReceipt,
  wallet_wait_for_transaction: renderWalletReceipt,
  peer_run_inference: renderPeerRunInference,
  peer_list_providers: renderPeerListProviders,
};

function renderJsonFallback(call) {
  const frag = document.createDocumentFragment();
  if (isFailure(call)) {
    frag.appendChild(makeSummary(failureText(call)));
    return frag;
  }
  if (call.args && Object.keys(call.args).length > 0) {
    frag.appendChild(makeMonoBlock(JSON.stringify(call.args, null, 2), 'agent-tool-mono args'));
  }
  return frag;
}

export function renderToolBody(call) {
  const renderer = TOOL_RENDERERS[call.name];
  return renderer ? renderer(call) : renderJsonFallback(call);
}

export const _internals = {
  truncateMiddle,
  TOOL_RENDERERS,
};
