const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, '..', 'bee-bin');

function fetchReleaseOnce() {
  return new Promise((resolve, reject) => {
    // Authenticate when a token is available (e.g. GITHUB_TOKEN in CI) to lift
    // the 60 req/hour unauthenticated limit that shared runner IPs often hit.
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const headers = {
      'User-Agent': 'Freedom-Updater',
      Accept: 'application/vnd.github+json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const options = {
      hostname: 'api.github.com',
      path: '/repos/ethersphere/bee/releases/latest',
      headers,
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

async function fetchLatestRelease() {
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchReleaseOnce();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = 1000 * attempt;
        console.warn(
          `Release fetch attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// Abort a stalled request instead of letting it hang until the CI job-level
// timeout (a hung binary download can otherwise burn a whole e2e job).
const REQUEST_TIMEOUT_MS = 60000;

function downloadFileOnce(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const fail = (err) => {
      file.close();
      fs.unlink(dest, () => reject(err));
    };
    const req = https
      .get(url, { headers: { 'User-Agent': 'Freedom-Updater' } }, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          file.close();
          fs.unlink(dest, () => {
            downloadFileOnce(response.headers.location, dest).then(resolve).catch(reject);
          });
          return;
        }
        if (response.statusCode !== 200) {
          fail(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
        file.on('error', fail);
      })
      .on('error', fail);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Download timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`));
    });
  });
}

async function downloadFile(url, dest) {
  console.log(`Downloading ${url} to ${dest}...`);
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await downloadFileOnce(url, dest);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delayMs = 1000 * attempt;
        console.warn(
          `Download attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function main() {
  try {
    console.log('Fetching latest Bee release info...');
    const release = await fetchLatestRelease();
    console.log(`Latest version: ${release.tag_name}`);

    const assets = release.assets;
    const targets = [
      { os: 'mac', arch: 'arm64', keywords: ['darwin', 'arm64'] },
      { os: 'mac', arch: 'x64', keywords: ['darwin', 'amd64'] },
      { os: 'linux', arch: 'x64', keywords: ['linux', 'amd64'] },
      { os: 'linux', arch: 'arm64', keywords: ['linux', 'arm64'] },
      { os: 'win', arch: 'x64', keywords: ['windows', 'amd64'], exe: true },
      // Note: Bee doesn't provide Windows ARM64 builds - we copy x64 as fallback below
    ];

    for (const target of targets) {
      const asset = assets.find(
        (a) =>
          target.keywords.every((k) => a.name.toLowerCase().includes(k)) &&
          !a.name.endsWith('.rpm') &&
          !a.name.endsWith('.deb')
      );

      if (!asset) {
        console.warn(`Could not find asset for ${target.os}-${target.arch}`);
        continue;
      }

      const targetDir = path.join(OUTPUT_DIR, `${target.os}-${target.arch}`);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const binName = target.exe ? 'bee.exe' : 'bee';
      const destFile = path.join(targetDir, binName);

      const tempDest = path.join(targetDir, asset.name);
      await downloadFile(asset.browser_download_url, tempDest);

      if (asset.name.endsWith('.tar.gz') || asset.name.endsWith('.tgz')) {
        console.log(`Extracting ${asset.name}...`);
        execSync(`tar -xzf "${tempDest}" -C "${targetDir}"`);
        fs.unlinkSync(tempDest);
      } else if (asset.name.endsWith('.zip')) {
        console.log(`Extracting ${asset.name}...`);
        execSync(`unzip -o "${tempDest}" -d "${targetDir}"`);
        fs.unlinkSync(tempDest);
      } else {
        fs.renameSync(tempDest, destFile);
      }

      if (fs.existsSync(destFile)) {
        if (!target.exe) fs.chmodSync(destFile, '755');
        console.log(`Successfully installed Bee for ${target.os}-${target.arch}`);
      } else {
        const findBee = (dir) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if ((entry.name === 'bee' || entry.name === 'bee.exe') && entry.isFile())
              return path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = findBee(path.join(dir, entry.name));
              if (found) return found;
            }
          }
          return null;
        };

        const foundBin = findBee(targetDir);
        if (foundBin) {
          fs.renameSync(foundBin, destFile);
          if (!target.exe) fs.chmodSync(destFile, '755');
          console.log(`Found and installed Bee binary for ${target.os}-${target.arch}`);
        } else {
          console.error(
            `Failed to locate 'bee' binary after download/extraction for ${target.os}-${target.arch}`
          );
        }
      }
    }

    // Copy win-x64 binary to win-arm64 (Bee doesn't provide ARM64 builds, but Windows ARM64 can run x64 via emulation)
    const winX64Dir = path.join(OUTPUT_DIR, 'win-x64');
    const winArm64Dir = path.join(OUTPUT_DIR, 'win-arm64');
    const winX64Bin = path.join(winX64Dir, 'bee.exe');
    const winArm64Bin = path.join(winArm64Dir, 'bee.exe');

    if (fs.existsSync(winX64Bin)) {
      if (!fs.existsSync(winArm64Dir)) {
        fs.mkdirSync(winArm64Dir, { recursive: true });
      }
      fs.copyFileSync(winX64Bin, winArm64Bin);
      console.log('Copied win-x64 Bee binary to win-arm64 (emulation fallback)');
    }

    console.log('All downloads complete.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
