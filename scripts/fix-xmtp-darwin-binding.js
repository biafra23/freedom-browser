#!/usr/bin/env node
/**
 * Postinstall: patch the XMTP @xmtp/node-bindings darwin prebuild.
 *
 * The published prebuild was built in a Nix sandbox and its Mach-O
 * load command points at a Nix-store libiconv path that does not exist
 * on a normal macOS install:
 *
 *   dlopen(.../bindings_node.darwin-arm64.node, 0x0001):
 *     Library not loaded:
 *       /nix/store/<hash>-libiconv-109.100.2/lib/libiconv.2.dylib
 *
 * We rewrite the load command to `/usr/lib/libiconv.2.dylib` (always
 * present on macOS) and re-sign the binary ad-hoc — changing load
 * commands invalidates the original ad-hoc signature, and on Apple
 * Silicon SIP requires a valid signature before dlopen will accept
 * the file.
 *
 * Idempotent: a second run sees the already-patched path and exits
 * cleanly. No-op on non-darwin platforms (the Linux/Windows prebuilds
 * don't have this issue).
 *
 * Reported upstream: this should ideally be fixed in the libxmtp build
 * pipeline so the prebuild links against the system libiconv directly.
 * Until then, this script keeps `npm install` working out of the box.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SYSTEM_LIBICONV = '/usr/lib/libiconv.2.dylib';
const BINDING_DIR = path.join(
  __dirname,
  '..',
  'node_modules',
  '@xmtp',
  'node-bindings',
  'dist'
);

function log(...args) {
  console.log('[fix-xmtp-binding]', ...args);
}
function warn(...args) {
  console.warn('[fix-xmtp-binding]', ...args);
}

if (process.platform !== 'darwin') {
  // Only macOS prebuilds carry the bad Nix-store libiconv reference.
  process.exit(0);
}

if (!fs.existsSync(BINDING_DIR)) {
  // node_modules wasn't installed yet — postinstall hasn't been run by
  // npm yet, or the package isn't in this dependency tree. Either way
  // there's nothing for us to do.
  process.exit(0);
}

const bindings = fs
  .readdirSync(BINDING_DIR)
  .filter((f) => f.startsWith('bindings_node.darwin-') && f.endsWith('.node'))
  .map((f) => path.join(BINDING_DIR, f));

if (bindings.length === 0) {
  process.exit(0);
}

let patched = 0;
let alreadyOk = 0;
let failed = 0;

for (const file of bindings) {
  let otoolOut;
  try {
    otoolOut = execFileSync('otool', ['-L', file], { encoding: 'utf8' });
  } catch (err) {
    warn(`otool unavailable for ${path.basename(file)}: ${err.message}; skipping`);
    failed++;
    continue;
  }

  // Capture the full path to any /nix/store/...libiconv.2.dylib load
  // command. We rewrite the LC_LOAD_DYLIB, not LC_ID_DYLIB (the dylib's
  // own self-name, which contains a separate /nix/var/nix/builds/...
  // path that doesn't affect dlopen).
  const lines = otoolOut.split('\n').slice(1); // drop file name header
  const badRefs = [];
  for (const line of lines) {
    const m = line.match(/^\s+(\/nix\/store\/[^\s]+libiconv\.2\.dylib)\s+\(/);
    if (m) badRefs.push(m[1]);
  }

  if (badRefs.length === 0) {
    alreadyOk++;
    continue;
  }

  let ok = true;
  for (const badPath of badRefs) {
    log(`${path.basename(file)}: rewriting ${badPath} -> ${SYSTEM_LIBICONV}`);
    try {
      execFileSync('install_name_tool', ['-change', badPath, SYSTEM_LIBICONV, file]);
    } catch (err) {
      warn(`install_name_tool failed on ${path.basename(file)}: ${err.message}`);
      ok = false;
    }
  }

  if (ok) {
    try {
      execFileSync('codesign', ['--force', '--sign', '-', file]);
      patched++;
      log(`${path.basename(file)}: re-signed ad-hoc`);
    } catch (err) {
      warn(`codesign failed on ${path.basename(file)}: ${err.message}`);
      failed++;
    }
  } else {
    failed++;
  }
}

const summary = [];
if (patched > 0) summary.push(`patched ${patched}`);
if (alreadyOk > 0) summary.push(`${alreadyOk} already ok`);
if (failed > 0) summary.push(`${failed} failed`);
if (summary.length > 0) log(summary.join(', '));

// Don't fail the install — the user can still see the issue at runtime
// via the doctor / messaging status banner.
process.exit(0);
