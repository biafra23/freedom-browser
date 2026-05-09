#!/usr/bin/env node
/**
 * XMTP doctor — diagnostic for "Messaging offline: Cannot find native binding".
 *
 * Run on the affected machine:
 *   node scripts/xmtp-doctor.js
 *
 * Reports environment (Node version, platform, arch, libc), what's actually
 * present in node_modules/@xmtp/node-bindings/dist, and exactly which
 * load attempt fails and why (with the underlying cause chain that the
 * canned napi-rs message hides).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const REQUIRED_NODE_MAJOR = 22;
const PASS = '✓';
const FAIL = '✗';
const WARN = '!';

function line() {
  console.log('-'.repeat(60));
}

function header(title) {
  line();
  console.log(title);
  line();
}

function detectLibc() {
  if (process.platform !== 'linux') return null;
  try {
    const ldd = execSync('ldd --version 2>&1', { encoding: 'utf8' });
    if (/musl/i.test(ldd)) return 'musl';
    if (/(glibc|GNU libc)/i.test(ldd)) return 'glibc';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function expectedBindingFile() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'bindings_node.darwin-arm64.node';
    if (arch === 'x64') return 'bindings_node.darwin-x64.node';
  } else if (platform === 'linux') {
    const libc = detectLibc();
    if (arch === 'x64') return `bindings_node.linux-x64-${libc === 'musl' ? 'musl' : 'gnu'}.node`;
    if (arch === 'arm64') return `bindings_node.linux-arm64-${libc === 'musl' ? 'musl' : 'gnu'}.node`;
    if (arch === 'arm')
      return `bindings_node.linux-arm-${libc === 'musl' ? 'musleabihf' : 'gnueabihf'}.node`;
  } else if (platform === 'win32') {
    if (arch === 'x64') return 'bindings_node.win32-x64-msvc.node';
    if (arch === 'arm64') return 'bindings_node.win32-arm64-msvc.node';
    if (arch === 'ia32') return 'bindings_node.win32-ia32-msvc.node';
  }
  return null;
}

function flattenCause(err) {
  const parts = [];
  const seen = new Set();
  let cur = err;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    parts.push(cur.message || String(cur));
    cur = cur.cause;
  }
  return parts.join('\n  ↳ caused by: ');
}

let issues = 0;

header('Environment');
console.log(`Node:            ${process.version}`);
console.log(`Platform:        ${process.platform}`);
console.log(`Arch:            ${process.arch}`);
console.log(`OS release:      ${os.release()}`);
if (process.platform === 'linux') console.log(`Linux libc:      ${detectLibc()}`);
console.log(`process.execPath ${process.execPath}`);

const nodeMajor = parseInt(process.version.replace(/^v/, '').split('.')[0], 10);
if (nodeMajor < REQUIRED_NODE_MAJOR) {
  console.log(
    `\n${FAIL} Node ${process.version} is below the required ${REQUIRED_NODE_MAJOR}+. ` +
      `@xmtp/node-bindings@1.10+ requires Node >= ${REQUIRED_NODE_MAJOR}; the .node file ` +
      `won't even attempt to load on older Node. Upgrade Node and re-run \`npm install\`.`
  );
  issues++;
} else {
  console.log(`\n${PASS} Node version is OK`);
}

header('node_modules/@xmtp/node-bindings');
const bindingsRoot = path.resolve('node_modules/@xmtp/node-bindings');
if (!fs.existsSync(bindingsRoot)) {
  console.log(
    `${FAIL} ${bindingsRoot} not found. Run \`npm install\` from the repo root first.`
  );
  process.exit(1);
}
const distDir = path.join(bindingsRoot, 'dist');
const distFiles = fs.existsSync(distDir) ? fs.readdirSync(distDir).sort() : [];
console.log(`Found ${distFiles.length} files in dist/:`);
for (const f of distFiles) console.log(`  ${f}`);

const expected = expectedBindingFile();
if (!expected) {
  console.log(
    `\n${WARN} This platform (${process.platform}/${process.arch}) isn't in the standard ` +
      `prebuild list. XMTP may not support it.`
  );
  issues++;
} else if (!distFiles.includes(expected)) {
  console.log(
    `\n${FAIL} Expected ${expected} but it isn't in dist/. ` +
      `npm has a known optional-dep bug; try:\n  rm -rf node_modules package-lock.json && npm install`
  );
  issues++;
} else {
  console.log(`\n${PASS} Expected binding ${expected} is present`);
}

header('Direct binding load');
try {
  const bindings = require('@xmtp/node-bindings');
  const exports = Object.keys(bindings).slice(0, 6).join(', ');
  console.log(`${PASS} @xmtp/node-bindings loaded — exports include: ${exports}…`);
} catch (err) {
  issues++;
  console.log(`${FAIL} @xmtp/node-bindings load failed:`);
  console.log(`  ${flattenCause(err)}`);
  console.log(`\nCommon causes:`);
  console.log(`  - Node < 22 (NAPI ABI mismatch)`);
  console.log(`  - Wrong arch (e.g. Apple Silicon running x64 Node under Rosetta)`);
  console.log(`  - macOS quarantine: try`);
  console.log(`      xattr -dr com.apple.quarantine node_modules/@xmtp/node-bindings`);
  console.log(`  - Linux glibc too old (need 2.31+) — try the musl variant or upgrade libc`);
}

header('Direct SDK load');
(async () => {
  try {
    const sdk = await import('@xmtp/node-sdk');
    console.log(`${PASS} @xmtp/node-sdk loaded — Client present: ${typeof sdk.Client}`);
  } catch (err) {
    issues++;
    console.log(`${FAIL} @xmtp/node-sdk load failed:`);
    console.log(`  ${flattenCause(err)}`);
  }

  line();
  if (issues === 0) {
    console.log(`${PASS} All checks passed.`);
    process.exit(0);
  } else {
    console.log(`${FAIL} ${issues} issue(s) found. Address them above and re-run this script.`);
    process.exit(1);
  }
})();
