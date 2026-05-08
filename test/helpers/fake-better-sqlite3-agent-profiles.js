// In-memory fake of better-sqlite3 sized to the agent_profiles table.
// Mirrors the prepared SQL strings used by src/main/agent/agent-profiles.js;
// throws on unrecognised SQL so schema drift surfaces as a test failure
// (matches the pattern in the other fake-better-sqlite3-* helpers).

class FakeBetterSqlite3AgentProfilesDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.profiles = new Map();
    this.userVersion = 0;
  }

  pragma(stmt, opts = {}) {
    if (stmt === 'journal_mode = WAL') return 'wal';
    if (stmt === 'user_version' && opts.simple) return this.userVersion;
    if (stmt === 'user_version = 1') {
      this.userVersion = 1;
      return this.userVersion;
    }
    return null;
  }

  exec() {}

  close() {}

  prepare(sql) {
    const norm = sql.replace(/\s+/g, ' ').trim();

    if (norm.startsWith('INSERT INTO agent_profiles')) {
      return {
        run: (id, name, systemPrompt, allowedToolTiers, isDefault, createdAt, updatedAt) => {
          this.profiles.set(id, {
            id,
            name,
            system_prompt: systemPrompt,
            allowed_tool_tiers: allowedToolTiers,
            is_default: isDefault,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return { changes: 1, lastInsertRowid: id };
        },
      };
    }

    if (norm === 'SELECT * FROM agent_profiles WHERE id = ?') {
      return { get: (id) => this.profiles.get(id) || null };
    }

    if (norm.startsWith('SELECT * FROM agent_profiles WHERE is_default = 1 LIMIT 1')) {
      return {
        get: () => [...this.profiles.values()].find((p) => p.is_default === 1) || null,
      };
    }

    if (
      norm.startsWith(
        'SELECT * FROM agent_profiles ORDER BY is_default DESC, created_at ASC'
      )
    ) {
      return {
        all: () =>
          [...this.profiles.values()].sort((a, b) => {
            if (a.is_default !== b.is_default) return b.is_default - a.is_default;
            return a.created_at - b.created_at;
          }),
      };
    }

    if (norm === 'SELECT COUNT(*) AS count FROM agent_profiles') {
      return { get: () => ({ count: this.profiles.size }) };
    }

    if (norm.startsWith('UPDATE agent_profiles SET name = COALESCE(?, name)')) {
      return {
        run: (name, systemPrompt, allowedToolTiers, updatedAt, id) => {
          const p = this.profiles.get(id);
          if (!p) return { changes: 0 };
          if (name !== null) p.name = name;
          if (systemPrompt !== null) p.system_prompt = systemPrompt;
          if (allowedToolTiers !== null) p.allowed_tool_tiers = allowedToolTiers;
          p.updated_at = updatedAt;
          return { changes: 1 };
        },
      };
    }

    if (norm === 'DELETE FROM agent_profiles WHERE id = ? AND is_default = 0') {
      return {
        run: (id) => {
          const p = this.profiles.get(id);
          if (!p || p.is_default === 1) return { changes: 0 };
          this.profiles.delete(id);
          return { changes: 1 };
        },
      };
    }

    throw new Error(`Unrecognised SQL in fake-better-sqlite3-agent-profiles: ${norm}`);
  }
}

module.exports = FakeBetterSqlite3AgentProfilesDatabase;
