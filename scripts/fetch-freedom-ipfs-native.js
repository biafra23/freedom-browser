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
const prebuildRoot = path.join(addonDir, 'prebuilds');
const ADDON_FILENAME = 'freedom_ipfs_native.node';
const addonPath = path.join(outDir, ADDON_FILENAME);
const rustRepo = process.env.FREEDOM_IPFS_RUST_REPO
  ? path.resolve(process.env.FREEDOM_IPFS_RUST_REPO)
  : path.resolve(projectRoot, '..', 'nodes', 'freedom-ipfs');
const releaseTag = process.env.FREEDOM_IPFS_RELEASE_TAG || 'v0.4.1';
const releaseBaseUrl = `https://github.com/solardev-xyz/freedom-ipfs/releases/download/${releaseTag}`;
const REQUEST_TIMEOUT_MS = 60000;
const MAX_DOWNLOAD_ATTEMPTS = 4;
const MAX_REDIRECTS = 5;

const prebuiltAssets = {
  'v0.4.1': {
    'darwin-arm64': {
      name: 'freedom-ipfs-node-electron41-darwin-arm64.tar.gz',
      sha256: 'f12f1fc868ab4dd2c24e2b9162ce21e811282aad12e02b7351dd3568e831400e',
    },
    'linux-x64': {
      name: 'freedom-ipfs-node-electron41-linux-x64.tar.gz',
      sha256: 'b9151cdf2b98e9d1f339d84f948ee71b4a1bd760379982f25fd24e4263701485',
    },
    'win32-x64': {
      name: 'freedom-ipfs-node-electron41-win32-x64.tar.gz',
      sha256: '53f22f0a4a1a9fce1bdab95b0a6dcb020d31014a1e543c7a0dfe2a3e993d421f',
    },
  },
  'v0.4.0': {
    'darwin-arm64': {
      name: 'freedom-ipfs-node-electron41-darwin-arm64.tar.gz',
      sha256: 'ccd6cbdde7b3856f8202677f1dbae94591e4dc83e11fd285ae5a255f9b00321d',
    },
  },
};

const packagePlatformByNodePlatform = {
  darwin: 'mac',
  linux: 'linux',
  win32: 'win',
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status || 1}`);
  }
}

function shouldBuildFromSource() {
  return (
    process.argv.includes('--from-source') ||
    process.env.FREEDOM_IPFS_NATIVE_FROM_SOURCE === '1' ||
    !!process.env.FREEDOM_IPFS_RUST_REPO
  );
}

function currentPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

function currentPackageTarget() {
  const osName = packagePlatformByNodePlatform[process.platform];
  if (!osName) return null;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  return arch ? `${osName}-${arch}` : null;
}

function releaseManifest() {
  const manifest = prebuiltAssets[releaseTag];
  if (!manifest) {
    throw new Error(
      `no checksum manifest for freedom-ipfs ${releaseTag}; update scripts/fetch-freedom-ipfs-native.js before using FREEDOM_IPFS_RELEASE_TAG`
    );
  }
  return manifest;
}

function currentAsset() {
  return releaseManifest()[currentPlatformKey()] || null;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('error', reject);
  });
}

function downloadOnce(url, destination, redirectsRemaining = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location) {
          reject(new Error(`download redirect missing Location header: ${url}`));
          return;
        }
        if (redirectsRemaining <= 0) {
          reject(new Error(`download exceeded ${MAX_REDIRECTS} redirects: ${url}`));
          return;
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadOnce(nextUrl, destination, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const file = fs.createWriteStream(destination);
      const fail = (err) => {
        file.close(() => {
          fs.unlink(destination, () => reject(err));
        });
      };
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', fail);
    });
    request.on('error', reject);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`download timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`));
    });
  });
}

async function download(url, destination) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadOnce(url, destination);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
        const delayMs = 1000 * attempt;
        console.warn(
          `[freedom-ipfs-native] download attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function prebuildDirForTarget(target) {
  return path.join(prebuildRoot, target);
}

function copyAddon(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

async function installPrebuilt() {
  const target = currentPackageTarget();
  const asset = currentAsset();
  if (!asset || !target) {
    console.warn(
      `[freedom-ipfs-native] no pinned ${releaseTag} addon for ${currentPlatformKey()}; skipping prebuilt download`
    );
    console.warn('[freedom-ipfs-native] set FREEDOM_IPFS_NATIVE_FROM_SOURCE=1 to build locally');
    return;
  }

  const url = `${releaseBaseUrl}/${asset.name}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfs-native-'));
  const archive = path.join(tmpDir, asset.name);

  try {
    console.log(`[freedom-ipfs-native] downloading ${url}`);
    await download(url, archive);

    const actual = await sha256(archive);
    if (actual !== asset.sha256) {
      throw new Error(
        `checksum mismatch for ${asset.name}: expected ${asset.sha256}, actual ${actual}`
      );
    }

    const prebuildDir = prebuildDirForTarget(target);
    fs.rmSync(prebuildDir, { recursive: true, force: true });
    fs.mkdirSync(prebuildDir, { recursive: true });
    run('tar', ['-xzf', archive, '-C', prebuildDir, ADDON_FILENAME]);
    const prebuildAddon = path.join(prebuildDir, ADDON_FILENAME);
    copyAddon(prebuildAddon, addonPath);
    console.log(`[freedom-ipfs-native] installed packaged addon ${prebuildAddon}`);
    console.log(`[freedom-ipfs-native] installed development addon ${addonPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function buildFromSource() {
  const rustEnv = { ...process.env };
  if (process.platform === 'darwin' && !rustEnv.MACOSX_DEPLOYMENT_TARGET) {
    rustEnv.MACOSX_DEPLOYMENT_TARGET = '11.0';
  }
  rustEnv.npm_config_freedom_ipfs_rust_repo = rustRepo;

  console.log(`[freedom-ipfs-native] building Rust static library in ${rustRepo}`);
  run('cargo', ['build', '-p', 'freedom-ipfs-mobile', '--release'], {
    cwd: rustRepo,
    env: rustEnv,
  });

  console.log(`[freedom-ipfs-native] building Node addon in ${addonDir}`);
  run(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['node-gyp', 'rebuild', `--freedom_ipfs_rust_repo=${rustRepo}`],
    {
      cwd: addonDir,
      env: rustEnv,
    }
  );

  const target = currentPackageTarget();
  if (target) {
    const prebuildAddon = path.join(prebuildDirForTarget(target), ADDON_FILENAME);
    copyAddon(addonPath, prebuildAddon);
    console.log(`[freedom-ipfs-native] staged source-built addon ${prebuildAddon}`);
  }

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
