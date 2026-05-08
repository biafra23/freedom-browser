// In-memory fake of better-sqlite3 sized to the agent_sessions /
// agent_messages tables. Mirrors the prepared SQL strings used by
// src/main/agent/sessions-store.js; throws on anything else so a
// schema drift surfaces as a test failure (matches the pattern in
// fake-better-sqlite3-publishes.js).

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

class FakeBetterSqlite3AgentSessionsDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.sessions = new Map();
    this.messages = [];
    this.userVersion = 0;
  }

  pragma(stmt, opts = {}) {
    if (stmt === 'journal_mode = WAL') return 'wal';
    if (stmt === 'foreign_keys = ON') return 1;
    if (stmt === 'user_version' && opts.simple) return this.userVersion;
    if (stmt === 'user_version = 1') {
      this.userVersion = 1;
      return this.userVersion;
    }
    return null;
  }

  exec() {}

  transaction(fn) {
    return (...args) => fn(...args);
  }

  close() {}

  prepare(sql) {
    const norm = sql.replace(/\s+/g, ' ').trim();

    if (norm.startsWith('INSERT INTO agent_sessions')) {
      return {
        run: (id, title, agentId, modelId, createdAt, updatedAt) => {
          this.sessions.set(id, {
            id,
            title,
            agent_id: agentId,
            model_id: modelId,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return { changes: 1, lastInsertRowid: id };
        },
      };
    }

    if (norm === 'SELECT * FROM agent_sessions WHERE id = ?') {
      return { get: (id) => this.sessions.get(id) || null };
    }

    if (norm.startsWith('SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT 1')) {
      return {
        get: () =>
          [...this.sessions.values()].sort((a, b) => b.updated_at - a.updated_at)[0] || null,
      };
    }

    if (norm.startsWith('SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT ?')) {
      return {
        all: (limit) =>
          [...this.sessions.values()]
            .sort((a, b) => b.updated_at - a.updated_at)
            .slice(0, limit),
      };
    }

    if (norm === 'UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?') {
      return {
        run: (title, updatedAt, id) => {
          const s = this.sessions.get(id);
          if (!s) return { changes: 0 };
          s.title = title;
          s.updated_at = updatedAt;
          return { changes: 1 };
        },
      };
    }

    if (norm === 'UPDATE agent_sessions SET updated_at = ? WHERE id = ?') {
      return {
        run: (updatedAt, id) => {
          const s = this.sessions.get(id);
          if (!s) return { changes: 0 };
          s.updated_at = updatedAt;
          return { changes: 1 };
        },
      };
    }

    if (norm === 'DELETE FROM agent_sessions WHERE id = ?') {
      return {
        run: (id) => {
          if (!this.sessions.has(id)) return { changes: 0 };
          this.sessions.delete(id);
          // Cascade to messages.
          this.messages = this.messages.filter((m) => m.session_id !== id);
          return { changes: 1 };
        },
      };
    }

    if (norm.startsWith('INSERT INTO agent_messages')) {
      return {
        run: (id, sessionId, role, content, partsJson, createdAt) => {
          // Enforce CHECK + FOREIGN KEY constraints at the fake level.
          if (!ALLOWED_ROLES.has(role)) {
            throw new Error(`CHECK constraint failed: role`);
          }
          if (!this.sessions.has(sessionId)) {
            throw new Error(`FOREIGN KEY constraint failed`);
          }
          this.messages.push({
            id,
            session_id: sessionId,
            role,
            content,
            parts_json: partsJson,
            created_at: createdAt,
          });
          return { changes: 1, lastInsertRowid: id };
        },
      };
    }

    if (
      norm === 'SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at ASC'
    ) {
      return {
        all: (sessionId) =>
          this.messages
            .filter((m) => m.session_id === sessionId)
            .sort((a, b) => a.created_at - b.created_at),
      };
    }

    throw new Error(`Unrecognised SQL in fake-better-sqlite3-agent-sessions: ${norm}`);
  }
}

module.exports = FakeBetterSqlite3AgentSessionsDatabase;
