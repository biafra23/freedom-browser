/**
 * Agent Profiles
 *
 * SQLite-backed CRUD for "agent profiles" — named LLM-driven agents
 * with their own system prompt and allowed tool-tier list. The
 * permission broker (Phase 5a-ii) reads `allowed_tool_tiers` to
 * decide which tools are visible to a given agent at the model layer.
 *
 * One default profile is auto-created on first init so the rest of
 * the system always has something to attach sessions to. The default
 * profile cannot be deleted; renaming and changing its tier list /
 * system prompt is fine.
 *
 * Schema (v1):
 *   agent_profiles(id, name, system_prompt, allowed_tool_tiers,
 *                  is_default, created_at, updated_at)
 *
 * `allowed_tool_tiers` is a JSON-encoded array of tier strings.
 * Phase 5a-ii defines the canonical tier list; this module stores
 * whatever the caller hands it.
 */

const log = require('../logger');
const { app, ipcMain } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const IPC = require('../../shared/ipc-channels');
const { newId } = require('../../shared/random-id');

// Conservative default for the auto-created profile: can read the
// current tab and drive the browser within consent gates, can hit
// public networks for reads. Excludes anything that sends user data
// outward, costs money, or signs.
const DEFAULT_TIERS = [
  'local_safe',
  'local_sensitive',
  'external_network',
  'browser_mutation',
];

const DEFAULT_PROFILE_NAME = 'Local AI';

let db = null;
let statements = null;

function getDb() {
  if (db) return db;
  const dbPath = path.join(app.getPath('userData'), 'agent-profiles.sqlite');
  log.info('[AgentProfiles] Opening database:', dbPath);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateDatabase();
  ensureDefaultProfile();
  return db;
}

function closeDb() {
  if (db) {
    log.info('[AgentProfiles] Closing database');
    db.close();
    db = null;
    statements = null;
  }
}

function migrateDatabase() {
  const version = db.pragma('user_version', { simple: true });
  log.info('[AgentProfiles] Current schema version:', version);

  if (version < 1) {
    log.info('[AgentProfiles] Running migration to version 1');
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        system_prompt TEXT,
        allowed_tool_tiers TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_profiles_default
        ON agent_profiles(is_default);
    `);
    db.pragma('user_version = 1');
  }
}

function getStatements() {
  if (statements) return statements;
  const database = getDb();
  statements = {
    insert: database.prepare(`
      INSERT INTO agent_profiles
        (id, name, system_prompt, allowed_tool_tiers, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    getById: database.prepare(`SELECT * FROM agent_profiles WHERE id = ?`),
    getDefault: database.prepare(
      `SELECT * FROM agent_profiles WHERE is_default = 1 LIMIT 1`
    ),
    list: database.prepare(
      `SELECT * FROM agent_profiles ORDER BY is_default DESC, created_at ASC`
    ),
    countAll: database.prepare(`SELECT COUNT(*) AS count FROM agent_profiles`),
    update: database.prepare(`
      UPDATE agent_profiles
      SET name = COALESCE(?, name),
          system_prompt = COALESCE(?, system_prompt),
          allowed_tool_tiers = COALESCE(?, allowed_tool_tiers),
          updated_at = ?
      WHERE id = ?
    `),
    // Refuse to delete the default profile — keeps the system always
    // having something to attach sessions to.
    deleteIfNotDefault: database.prepare(
      `DELETE FROM agent_profiles WHERE id = ? AND is_default = 0`
    ),
  };
  return statements;
}

function ensureDefaultProfile() {
  const stmts = getStatements();
  const { count } = stmts.countAll.get();
  if (count > 0) return;

  log.info('[AgentProfiles] No profiles found, creating default');
  const now = Date.now();
  stmts.insert.run(
    newId(),
    DEFAULT_PROFILE_NAME,
    null,
    JSON.stringify(DEFAULT_TIERS),
    1,
    now,
    now
  );
}

function rowToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    system_prompt: row.system_prompt,
    allowed_tool_tiers: row.allowed_tool_tiers ? JSON.parse(row.allowed_tool_tiers) : [],
    is_default: !!row.is_default,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listProfiles() {
  return getStatements().list.all().map(rowToObject);
}

function getProfile(id) {
  if (!id) return null;
  return rowToObject(getStatements().getById.get(id));
}

function getDefaultProfile() {
  return rowToObject(getStatements().getDefault.get());
}

function createProfile({ name, systemPrompt = null, allowedToolTiers = DEFAULT_TIERS } = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('name is required');
  }
  if (!Array.isArray(allowedToolTiers)) {
    throw new Error('allowedToolTiers must be an array');
  }
  const id = newId();
  const now = Date.now();
  getStatements().insert.run(
    id,
    name,
    systemPrompt,
    JSON.stringify(allowedToolTiers),
    0,
    now,
    now
  );
  return getProfile(id);
}

function updateProfile(id, { name, systemPrompt, allowedToolTiers } = {}) {
  if (!id) throw new Error('id is required');
  const tiers =
    allowedToolTiers !== undefined ? JSON.stringify(allowedToolTiers) : null;
  const result = getStatements().update.run(
    name ?? null,
    systemPrompt ?? null,
    tiers,
    Date.now(),
    id
  );
  return result.changes > 0;
}

function deleteProfile(id) {
  if (!id) throw new Error('id is required');
  const result = getStatements().deleteIfNotDefault.run(id);
  return result.changes > 0;
}

function registerProfilesIpc() {
  ipcMain.handle(IPC.AGENT_PROFILE_LIST, () => listProfiles());
  ipcMain.handle(IPC.AGENT_PROFILE_GET, (_event, payload = {}) => getProfile(payload.id));
  ipcMain.handle(IPC.AGENT_PROFILE_GET_DEFAULT, () => getDefaultProfile());
  ipcMain.handle(IPC.AGENT_PROFILE_CREATE, (_event, payload = {}) => createProfile(payload));
  ipcMain.handle(IPC.AGENT_PROFILE_UPDATE, (_event, payload = {}) => {
    return { ok: updateProfile(payload.id, payload) };
  });
  ipcMain.handle(IPC.AGENT_PROFILE_DELETE, (_event, payload = {}) => {
    return { ok: deleteProfile(payload.id) };
  });
}

module.exports = {
  registerProfilesIpc,
  closeDb,
  listProfiles,
  getProfile,
  getDefaultProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  DEFAULT_TIERS,
};
