/**
 * Agent Sessions Store
 *
 * SQLite-backed persistence for agent chat sessions and their
 * messages. Mirrors the `history.js` shape (better-sqlite3, WAL,
 * pragma user_version migrations).
 *
 * Schema (v1):
 *   agent_sessions(id, title, agent_id, model_id, created_at, updated_at)
 *   agent_messages(id, session_id, role, content, parts_json, created_at)
 *
 * `parts_json` is a forward-compat blob for tool calls / tool results /
 * reasoning content arriving in Phase 5. v1 readers ignore it.
 */

const log = require('../logger');
const { app, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const IPC = require('../../shared/ipc-channels');

let db = null;
let statements = null;
let dbPathOverride = null;

function setDbPathForTests(p) {
  dbPathOverride = p;
}

function getDbPath() {
  if (dbPathOverride) return dbPathOverride;
  return path.join(app.getPath('userData'), 'agent-sessions.sqlite');
}

function getDb() {
  if (db) return db;
  const dbPath = getDbPath();
  log.info('[AgentSessions] Opening database:', dbPath);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateDatabase();
  return db;
}

function closeDb() {
  if (db) {
    log.info('[AgentSessions] Closing database');
    db.close();
    db = null;
    statements = null;
  }
}

function migrateDatabase() {
  const version = db.pragma('user_version', { simple: true });
  log.info('[AgentSessions] Current schema version:', version);

  if (version < 1) {
    log.info('[AgentSessions] Running migration to version 1');
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        agent_id TEXT,
        model_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT,
        parts_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_messages_session
        ON agent_messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated
        ON agent_sessions(updated_at DESC);
    `);
    db.pragma('user_version = 1');
  }
}

function getStatements() {
  if (statements) return statements;
  const database = getDb();
  statements = {
    insertSession: database.prepare(`
      INSERT INTO agent_sessions (id, title, agent_id, model_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getSessionById: database.prepare(`
      SELECT * FROM agent_sessions WHERE id = ?
    `),
    listSessions: database.prepare(`
      SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT ?
    `),
    getMostRecentSession: database.prepare(`
      SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT 1
    `),
    renameSession: database.prepare(`
      UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?
    `),
    touchSession: database.prepare(`
      UPDATE agent_sessions SET updated_at = ? WHERE id = ?
    `),
    deleteSession: database.prepare(`
      DELETE FROM agent_sessions WHERE id = ?
    `),
    insertMessage: database.prepare(`
      INSERT INTO agent_messages (id, session_id, role, content, parts_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getMessagesBySession: database.prepare(`
      SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at ASC
    `),
  };
  return statements;
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function createSession({ title = null, agentId = null, modelId = null } = {}) {
  const id = newId();
  const now = Date.now();
  getStatements().insertSession.run(id, title, agentId, modelId, now, now);
  return { id, title, agent_id: agentId, model_id: modelId, created_at: now, updated_at: now };
}

function getSession(id) {
  const stmts = getStatements();
  const session = stmts.getSessionById.get(id);
  if (!session) return null;
  const messages = stmts.getMessagesBySession.all(id);
  return { ...session, messages };
}

function listSessions(limit = 50) {
  return getStatements().listSessions.all(limit);
}

function getMostRecentSession() {
  const session = getStatements().getMostRecentSession.get();
  if (!session) return null;
  const messages = getStatements().getMessagesBySession.all(session.id);
  return { ...session, messages };
}

function renameSession(id, title) {
  const result = getStatements().renameSession.run(title, Date.now(), id);
  return result.changes > 0;
}

function deleteSession(id) {
  const result = getStatements().deleteSession.run(id);
  return result.changes > 0;
}

function appendMessage({ sessionId, role, content = null, parts = null }) {
  if (!sessionId) throw new Error('sessionId is required');
  if (!role) throw new Error('role is required');
  const id = newId();
  const now = Date.now();
  const partsJson = parts ? JSON.stringify(parts) : null;
  const stmts = getStatements();
  const tx = getDb().transaction(() => {
    stmts.insertMessage.run(id, sessionId, role, content, partsJson, now);
    stmts.touchSession.run(now, sessionId);
  });
  tx();
  return { id, session_id: sessionId, role, content, parts_json: partsJson, created_at: now };
}

function registerSessionsIpc() {
  ipcMain.handle(IPC.AGENT_SESSION_LIST, (_event, payload = {}) => {
    return listSessions(payload.limit ?? 50);
  });
  ipcMain.handle(IPC.AGENT_SESSION_GET, (_event, payload = {}) => {
    return getSession(payload.id);
  });
  ipcMain.handle(IPC.AGENT_SESSION_GET_RECENT, () => {
    return getMostRecentSession();
  });
  ipcMain.handle(IPC.AGENT_SESSION_CREATE, (_event, payload = {}) => {
    return createSession(payload);
  });
  ipcMain.handle(IPC.AGENT_SESSION_RENAME, (_event, payload = {}) => {
    return { ok: renameSession(payload.id, payload.title) };
  });
  ipcMain.handle(IPC.AGENT_SESSION_DELETE, (_event, payload = {}) => {
    return { ok: deleteSession(payload.id) };
  });
  ipcMain.handle(IPC.AGENT_SESSION_APPEND_MESSAGE, (_event, payload = {}) => {
    return appendMessage(payload);
  });
}

module.exports = {
  registerSessionsIpc,
  closeDb,
  // Direct API for callers that don't go through IPC.
  createSession,
  getSession,
  listSessions,
  getMostRecentSession,
  renameSession,
  deleteSession,
  appendMessage,
  // Test hooks.
  _internals: { setDbPathForTests, newId },
};
