const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, '..', 'ollama-bin');

// Ollama release tarballs/zips contain a flat tree of the `ollama` binary
// next to its required GPU runtimes (libggml-*, mlx_metal_v*, cuda libs,
// rocm libs, etc.). Unlike Bee/IPFS which ship a single self-contained
// binary, Ollama needs the whole extracted directory next to the
// executable, so we preserve the full archive contents under
// `ollama-bin/<platform>-<arch>/` and let `ollama-manager.js` invoke the
// binary at its canonical relative path.
//
// The macOS tarball is a universal binary (arm64 + x86_64), so the same
// asset is unpacked into both `mac-arm64/` and `mac-x64/`.
async function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/ollama/ollama/releases/latest',
      headers: { 'User-Agent': 'Freedom-Updater' },
    };

    https
      .get(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Failed to fetch release: ${res.statusCode}`));
          }
        });
      })
      .on('error', reject);
  });
}

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}...`);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, { headers: { 'User-Agent': 'Freedom-Updater' } }, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          file.close();
          fs.unlink(dest, () => {});
          downloadFile(response.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

function extractArchive(archivePath, targetDir) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) {
    execSync(`tar -xzf "${archivePath}" -C "${targetDir}"`, { stdio: 'inherit' });
    return;
  }
  if (lower.endsWith('.tar.zst')) {
    // bsdtar (macOS) and GNU tar 1.31+ auto-detect zstd. On older Linux
    // distros without zstd-aware tar, install `zstd` via the package
    // manager — fall back here if `tar -xf` fails.
    try {
      execSync(`tar -xf "${archivePath}" -C "${targetDir}"`, { stdio: 'inherit' });
    } catch {
      execSync(`zstd -dc "${archivePath}" | tar -xf - -C "${targetDir}"`, {
        stdio: 'inherit',
        shell: '/bin/bash',
      });
    }
    return;
  }
  if (lower.endsWith('.zip')) {
    execSync(`unzip -oq "${archivePath}" -d "${targetDir}"`, { stdio: 'inherit' });
    return;
  }
  throw new Error(`Unsupported archive format: ${archivePath}`);
}

function findOllamaBinary(rootDir, exeName) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === exeName) {
        return full;
      }
      if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return null;
}

function emptyDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

async function fetchAssetTo(asset, targetDir) {
  emptyDir(targetDir);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const tempDest = path.join(targetDir, asset.name);
  await downloadFile(asset.browser_download_url, tempDest);

  console.log(`Extracting ${asset.name}...`);
  extractArchive(tempDest, targetDir);
  fs.unlinkSync(tempDest);
}

function parsePlatformFilter(argv) {
  const arg = argv.find((a) => a.startsWith('--platforms='));
  if (!arg) return null;
  const list = arg
    .slice('--platforms='.length)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
}

async function main() {
  try {
    const platformFilter = parsePlatformFilter(process.argv.slice(2));
    if (platformFilter) {
      console.log(`Platform filter: ${[...platformFilter].join(', ')}`);
    }

    console.log('Fetching latest Ollama release info...');
    const release = await fetchLatestRelease();
    console.log(`Latest version: ${release.tag_name}`);

    const assets = release.assets;

    // Asset name -> spec. We pick the *standard* (non-GPU-specific) builds.
    // Ollama also ships rocm/mlx/jetpack variants — those are larger and
    // hardware-specific; we ship the generic builds and let users opt in
    // to vendor variants later.
    const assetMap = {
      'ollama-darwin.tgz': {
        // Universal binary for both Apple Silicon and Intel Macs.
        targets: [
          { os: 'mac', arch: 'arm64' },
          { os: 'mac', arch: 'x64' },
        ],
      },
      'ollama-linux-amd64.tar.zst': {
        targets: [{ os: 'linux', arch: 'x64' }],
      },
      'ollama-linux-arm64.tar.zst': {
        targets: [{ os: 'linux', arch: 'arm64' }],
      },
      'ollama-windows-amd64.zip': {
        targets: [{ os: 'win', arch: 'x64', exe: true }],
      },
      'ollama-windows-arm64.zip': {
        targets: [{ os: 'win', arch: 'arm64', exe: true }],
      },
    };

    // Cache assets by name so we only download the universal mac asset once.
    const fetchedAssets = new Map();

    for (const [assetName, spec] of Object.entries(assetMap)) {
      const filteredTargets = platformFilter
        ? spec.targets.filter((t) => platformFilter.has(`${t.os}-${t.arch}`))
        : spec.targets;
      if (filteredTargets.length === 0) continue;

      const asset = assets.find((a) => a.name === assetName);
      if (!asset) {
        console.warn(`Could not find Ollama release asset: ${assetName}`);
        continue;
      }

      for (let i = 0; i < filteredTargets.length; i++) {
        const target = filteredTargets[i];
        const targetDir = path.join(OUTPUT_DIR, `${target.os}-${target.arch}`);

        if (i === 0) {
          // First (or only) target gets the actual download.
          await fetchAssetTo(asset, targetDir);
          fetchedAssets.set(assetName, targetDir);
        } else {
          // Subsequent targets reuse the same archive contents (mac universal).
          const sourceDir = fetchedAssets.get(assetName);
          console.log(
            `Reusing ${assetName} contents for ${target.os}-${target.arch} (universal binary)`
          );
          emptyDir(targetDir);
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          execSync(`cp -R "${sourceDir}/." "${targetDir}/"`, { stdio: 'inherit' });
        }

        const exeName = target.exe ? 'ollama.exe' : 'ollama';
        const binaryPath = findOllamaBinary(targetDir, exeName);

        if (!binaryPath) {
          console.error(
            `Failed to locate '${exeName}' binary after extraction for ${target.os}-${target.arch}`
          );
          continue;
        }

        if (!target.exe) {
          fs.chmodSync(binaryPath, '755');
        }

        const relativePath = path.relative(targetDir, binaryPath);
        console.log(
          `Successfully installed Ollama for ${target.os}-${target.arch} (binary at ${relativePath})`
        );
      }
    }

    console.log('All Ollama downloads complete.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
