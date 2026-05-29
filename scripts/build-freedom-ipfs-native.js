#!/usr/bin/env node

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const addonDir = path.join(projectRoot, 'native', 'freedom-ipfs-node');
const outDir = path.join(addonDir, 'build', 'Release');
const addonPath = path.join(outDir, 'freedom_ipfs_native.node');
const rustRepo = process.env.FREEDOM_IPFS_RUST_REPO
  ? path.resolve(process.env.FREEDOM_IPFS_RUST_REPO)
  : path.resolve(projectRoot, '..', 'nodes', 'freedom-ipfs');
const releaseBaseUrl = 'https://github.com/solardev-xyz/freedom-ipfs/releases/download/v0.4.0';

const prebuiltAssets = {
  'darwin-arm64': {
    name: 'freedom-ipfs-node-electron41-darwin-arm64.tar.gz',
    sha256: 'ccd6cbdde7b3856f8202677f1dbae94591e4dc83e11fd285ae5a255f9b00321d',
  },
};

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

function shouldBuildFromSource() {
  return (
    process.env.FREEDOM_IPFS_NATIVE_FROM_SOURCE === '1' || !!process.env.FREEDOM_IPFS_RUST_REPO
  );
}

function currentAsset() {
  return prebuiltAssets[`${process.platform}-${process.arch}`] || null;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        download(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function installPrebuilt() {
  const asset = currentAsset();
  if (!asset) {
    console.error(
      `[freedom-ipfs-native] no prebuilt v0.4.0 addon for ${process.platform}-${process.arch}`
    );
    console.error('[freedom-ipfs-native] set FREEDOM_IPFS_NATIVE_FROM_SOURCE=1 to build locally');
    process.exit(1);
  }

  const url = `${releaseBaseUrl}/${asset.name}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfs-native-'));
  const archive = path.join(tmpDir, asset.name);

  console.log(`[freedom-ipfs-native] downloading ${url}`);
  await download(url, archive);

  const actual = sha256(archive);
  if (actual !== asset.sha256) {
    console.error(`[freedom-ipfs-native] checksum mismatch for ${asset.name}`);
    console.error(`  expected ${asset.sha256}`);
    console.error(`  actual   ${actual}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  run('tar', ['-xzf', archive, '-C', outDir, 'freedom_ipfs_native.node']);
  console.log(`[freedom-ipfs-native] installed ${addonPath}`);
}

function buildFromSource() {
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

  console.log('[freedom-ipfs-native] built from source');
}

async function main() {
  if (shouldBuildFromSource()) {
    buildFromSource();
  } else {
    await installPrebuilt();
  }
}

main().catch((err) => {
  console.error(`[freedom-ipfs-native] ${err.message}`);
  process.exit(1);
});
