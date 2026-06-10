/**
 * User data migration module
 *
 * One-time startup migrations, run before any other module touches userData:
 *
 * 1. "Freedom Browser" → "Freedom" directory rename (app name change).
 *    Preserves settings, bookmarks, history, favicons, and node data.
 *
 * 2. `bee-data/` → `ant-data/` (Bee → Ant node swap). Carries over the
 *    injected node identity so upgrading users keep their Swarm wallet
 *    (overlay address, postage stamps, chequebook funds).
 */

const log = require('./logger');
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const OLD_APP_NAME = 'Freedom Browser';
const MIGRATION_MARKER = '.migrated-from-freedom-browser';

/**
 * Get the old userData path (before app name change)
 */
function getOldUserDataPath() {
  const currentPath = app.getPath('userData');
  const parentDir = path.dirname(currentPath);
  return path.join(parentDir, OLD_APP_NAME);
}

/**
 * Check if directory is empty or only contains the migration marker
 */
function isEffectivelyEmpty(dir) {
  if (!fs.existsSync(dir)) return true;

  const entries = fs.readdirSync(dir);
  if (entries.length === 0) return true;
  if (entries.length === 1 && entries[0] === MIGRATION_MARKER) return true;

  return false;
}

/**
 * Migrate user data from old "Freedom Browser" directory to new "Freedom" directory
 *
 * Uses move (rename) instead of copy for speed and to avoid doubling disk usage.
 * ant-data/ and ipfs-data/ can be gigabytes - moving is instant, copying takes minutes.
 *
 * This function should be called early in app startup, before any modules
 * try to access userData.
 *
 * @returns {boolean} true if migration was performed, false otherwise
 */
function migrateUserData() {
  const newPath = app.getPath('userData');
  const oldPath = getOldUserDataPath();
  const markerPath = path.join(newPath, MIGRATION_MARKER);

  // Skip if we've already migrated
  if (fs.existsSync(markerPath)) {
    return false;
  }

  // Skip if old directory doesn't exist
  if (!fs.existsSync(oldPath)) {
    // Create marker to indicate no migration needed
    try {
      if (!fs.existsSync(newPath)) {
        fs.mkdirSync(newPath, { recursive: true });
      }
      fs.writeFileSync(markerPath, `No migration needed - old directory not found: ${oldPath}`);
    } catch {
      // Ignore marker creation errors
    }
    return false;
  }

  // Skip if new directory already has data (not just marker)
  if (!isEffectivelyEmpty(newPath)) {
    log.info('[Migration] New userData directory already has data, skipping migration');
    try {
      fs.writeFileSync(markerPath, `Migration skipped - new directory already has data`);
    } catch {
      // Ignore marker creation errors
    }
    return false;
  }

  log.info('[Migration] Migrating user data from:', oldPath);
  log.info('[Migration] To:', newPath);

  try {
    // Remove new directory if it exists but is empty (so we can rename old to new)
    if (fs.existsSync(newPath)) {
      const entries = fs.readdirSync(newPath);
      if (entries.length === 0) {
        fs.rmdirSync(newPath);
      }
    }

    // Try to rename the entire directory (instant on same filesystem)
    if (!fs.existsSync(newPath)) {
      try {
        fs.renameSync(oldPath, newPath);
        log.info('[Migration] Renamed directory successfully (fast path)');

        // Create migration marker
        const markerContent = [
          `Migration completed: ${new Date().toISOString()}`,
          `Method: rename (fast)`,
          `From: ${oldPath}`,
          `To: ${newPath}`,
        ].join('\n');
        fs.writeFileSync(markerPath, markerContent);

        return true;
      } catch (renameErr) {
        // Rename failed (possibly cross-filesystem), fall back to move items
        log.info(
          '[Migration] Rename failed, falling back to item-by-item move:',
          renameErr.message
        );
        fs.mkdirSync(newPath, { recursive: true });
      }
    }

    // Fall back: move items one by one
    const entries = fs.readdirSync(oldPath, { withFileTypes: true });
    let migratedItems = [];

    for (const entry of entries) {
      const srcPath = path.join(oldPath, entry.name);
      const destPath = path.join(newPath, entry.name);

      try {
        fs.renameSync(srcPath, destPath);
        log.info(`[Migration] Moved: ${entry.name}`);
        migratedItems.push(entry.name);
      } catch (err) {
        log.error(`[Migration] Failed to move ${entry.name}:`, err.message);
      }
    }

    // Try to remove the now-empty old directory
    try {
      const remaining = fs.readdirSync(oldPath);
      if (remaining.length === 0) {
        fs.rmdirSync(oldPath);
        log.info('[Migration] Removed empty old directory');
      }
    } catch {
      // Ignore - old directory may have items we couldn't move
    }

    // Create migration marker with details
    const markerContent = [
      `Migration completed: ${new Date().toISOString()}`,
      `Method: move (item-by-item)`,
      `From: ${oldPath}`,
      `To: ${newPath}`,
      `Items migrated: ${migratedItems.join(', ')}`,
    ].join('\n');

    fs.writeFileSync(markerPath, markerContent);

    log.info(`[Migration] Successfully migrated ${migratedItems.length} items`);
    return true;
  } catch (err) {
    log.error('[Migration] Migration failed:', err);
    return false;
  }
}

// Bee-only LevelDB state antd cannot read. Dropped during bee-data → ant-data
// migration so users don't carry gigabytes of dead cache. `stamperstore` is
// deliberately KEPT: antd's bee-recover feature reads a carried-over bee
// stamperstore to seed the bucket counters of rediscovered postage batches.
const BEE_ONLY_DIRS = ['statestore', 'localstore', 'kademlia-metrics'];

// Identity-critical items carried over when ant-data already exists and a
// whole-directory rename isn't possible. `keys/` holds the injected Web3 v3
// keystore (swarm.key); `config.yaml` holds the password that decrypts it
// (ant-manager's ensureConfig preserves that password on rewrite).
const BEE_CARRY_ITEMS = ['keys', 'config.yaml', 'stamperstore'];

/**
 * Migrate the Bee-era node data directory (`bee-data/`) to the Ant location
 * (`ant-data/`) so an upgrading user's injected Swarm identity survives the
 * Bee → Ant node swap. Without this, antd starts on an empty ant-data/ and
 * self-generates a throwaway identity — a different overlay address with none
 * of the user's postage stamps or chequebook funds — and nothing re-injects
 * the real key outside the onboarding wizard.
 *
 * Idempotent without a marker file: it only acts when bee-data/ holds an
 * injected keystore (`keys/swarm.key`) and ant-data/ does not. Either path
 * (rename or item-by-item carry) makes the precondition false afterwards.
 *
 * Must run before the Ant node starts.
 *
 * @returns {boolean} true if a migration was performed
 */
function migrateBeeDataToAntData() {
  // Set only by tests/E2E runs that want a throwaway data dir — never migrate
  // real user data into those.
  if (process.env.FREEDOM_ANT_DATA) {
    return false;
  }

  const baseDir = app.isPackaged
    ? app.getPath('userData')
    : path.join(__dirname, '..', '..');
  const oldDir = path.join(baseDir, 'bee-data');
  const newDir = path.join(baseDir, 'ant-data');

  // Only an injected keystore is worth carrying over; everything else in
  // bee-data is disposable node cache.
  if (!fs.existsSync(path.join(oldDir, 'keys', 'swarm.key'))) {
    return false;
  }

  // Never clobber an identity that has already been injected into ant-data.
  if (fs.existsSync(path.join(newDir, 'keys', 'swarm.key'))) {
    log.info('[Migration] ant-data already has an injected identity, leaving bee-data untouched');
    return false;
  }

  log.info('[Migration] Migrating Bee node data from:', oldDir);
  log.info('[Migration] To:', newDir);

  try {
    if (!fs.existsSync(newDir)) {
      // Fast path: same parent directory, so rename the whole thing.
      fs.renameSync(oldDir, newDir);
      log.info('[Migration] Renamed bee-data to ant-data (fast path)');
    } else {
      // ant-data exists (e.g. antd already ran and self-generated a throwaway
      // identity). Carry over the identity-critical items, then drop antd's
      // self-generated identity so the injected keystore wins on next start.
      for (const item of BEE_CARRY_ITEMS) {
        const src = path.join(oldDir, item);
        const dest = path.join(newDir, item);
        if (!fs.existsSync(src)) continue;
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(src, dest);
        log.info(`[Migration] Carried over ${item} from bee-data`);
      }
      for (const idFile of ['identity.json', 'signing.key']) {
        const stale = path.join(newDir, idFile);
        if (fs.existsSync(stale)) {
          fs.rmSync(stale, { force: true });
          log.info(`[Migration] Removed antd self-generated ${idFile}`);
        }
      }
    }

    // Drop Bee-only LevelDB state antd can't use (can be gigabytes).
    for (const dir of BEE_ONLY_DIRS) {
      const stale = path.join(newDir, dir);
      if (fs.existsSync(stale)) {
        fs.rmSync(stale, { recursive: true, force: true });
        log.info(`[Migration] Removed Bee-only ${dir}/`);
      }
    }

    log.info('[Migration] Bee → Ant node data migration complete');
    return true;
  } catch (err) {
    // Leave whatever state we reached in place; the preconditions above make a
    // retry on next launch safe.
    log.error('[Migration] bee-data → ant-data migration failed:', err);
    return false;
  }
}

module.exports = {
  migrateUserData,
  migrateBeeDataToAntData,
  getOldUserDataPath,
};
