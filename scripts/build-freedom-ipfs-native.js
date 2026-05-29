#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const addonDir = path.join(projectRoot, 'native', 'freedom-ipfs-node');
const rustRepo = process.env.FREEDOM_IPFS_RUST_REPO
  ? path.resolve(process.env.FREEDOM_IPFS_RUST_REPO)
  : path.resolve(projectRoot, '..', 'nodes', 'freedom-ipfs');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const rustEnv = { ...process.env };
if (process.platform === 'darwin' && !rustEnv.MACOSX_DEPLOYMENT_TARGET) {
  rustEnv.MACOSX_DEPLOYMENT_TARGET = '11.0';
}

console.log(`[freedom-ipfs-native] building Rust static library in ${rustRepo}`);
run('cargo', ['build', '-p', 'freedom-ipfs-mobile', '--release'], {
  cwd: rustRepo,
  env: rustEnv,
});

console.log(`[freedom-ipfs-native] building Node addon in ${addonDir}`);
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['node-gyp', 'rebuild'], {
  cwd: addonDir,
});

console.log('[freedom-ipfs-native] done');
