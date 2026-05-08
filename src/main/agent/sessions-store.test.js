jest.mock('electron', () => {
  const handlers = new Map();
  return {
    ipcMain: {
      handle: jest.fn((channel, handler) => handlers.set(channel, handler)),
      _handlers: handlers,
    },
    app: {
      getPath: jest.fn(() => '/tmp'),
    },
  };
});

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Hand-coded fake covering the prepared statements in sessions-store.js.
// Same approach as test/helpers/fake-better-sqlite3.js for history.
class MockAgentDb {
  constructor() {
    this.sessions = new Map();
    this.messages = []; // ordered by created_at
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
          // Cascade.
          this.messages = this.messages.filter((m) => m.session_id !== id);
          return { changes: 1 };
        },
      };
    }

    if (norm.startsWith('INSERT INTO agent_messages')) {
      return {
        run: (id, sessionId, role, content, partsJson, createdAt) => {
          // Enforce role CHECK constraint at the fake level.
          if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
            throw new Error(`CHECK constraint failed: role`);
          }
          // Foreign key: session must exist.
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

    throw new Error(`Unrecognised SQL in fake: ${norm}`);
  }
}

jest.mock('better-sqlite3', () => {
  return jest.fn(() => new MockAgentDb());
});

const { ipcMain } = require('electron');
const IPC = require('../../shared/ipc-channels');
const store = require('./sessions-store');

beforeEach(() => {
  // Reset the singleton DB so each test gets a fresh in-memory MockAgentDb.
  store.closeDb();
  ipcMain.handle.mockClear();
  ipcMain._handlers.clear();
});

afterAll(() => {
  store.closeDb();
});

describe('createSession', () => {
  test('creates a session with generated id and timestamps', () => {
    const session = store.createSession({ modelId: 'gemma4:e2b' });
    expect(session.id).toMatch(/^[a-f0-9]{16}$/);
    expect(session.model_id).toBe('gemma4:e2b');
    expect(session.title).toBeNull();
    expect(session.created_at).toEqual(session.updated_at);
    expect(typeof session.created_at).toBe('number');
  });

  test('persists the session so getSession can read it back', () => {
    const created = store.createSession({ title: 'foo' });
    const fetched = store.getSession(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe('foo');
    expect(fetched.messages).toEqual([]);
  });
});

describe('appendMessage', () => {
  test('writes a user message under the session and returns it', () => {
    const session = store.createSession();
    const msg = store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'hello',
    });
    expect(msg.id).toMatch(/^[a-f0-9]{16}$/);
    expect(msg.session_id).toBe(session.id);
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
    expect(msg.parts_json).toBeNull();
  });

  test('serialises parts to parts_json when provided', () => {
    const session = store.createSession();
    const parts = { toolCalls: [{ id: 't1', name: 'navigate', args: { url: 'x' } }] };
    const msg = store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'calling tool',
      parts,
    });
    expect(JSON.parse(msg.parts_json)).toEqual(parts);
  });

  test('returns messages in created_at order via getSession', () => {
    const session = store.createSession();
    let now = session.created_at + 1;
    jest.spyOn(Date, 'now').mockImplementation(() => now++);
    store.appendMessage({ sessionId: session.id, role: 'user', content: 'first' });
    store.appendMessage({ sessionId: session.id, role: 'assistant', content: 'second' });
    store.appendMessage({ sessionId: session.id, role: 'user', content: 'third' });
    Date.now.mockRestore();
    const { messages } = store.getSession(session.id);
    expect(messages.map((m) => m.content)).toEqual(['first', 'second', 'third']);
  });

  test('touches updated_at on the parent session', () => {
    const session = store.createSession();
    const before = session.updated_at;
    const msAfter = before + 1;
    jest.spyOn(Date, 'now').mockReturnValue(msAfter);
    store.appendMessage({ sessionId: session.id, role: 'user', content: 'x' });
    Date.now.mockRestore();
    const refreshed = store.getSession(session.id);
    expect(refreshed.updated_at).toBe(msAfter);
  });

  test('rejects when sessionId is missing', () => {
    expect(() => store.appendMessage({ role: 'user', content: 'x' })).toThrow(/sessionId/);
  });

  test('rejects when role is missing', () => {
    const session = store.createSession();
    expect(() => store.appendMessage({ sessionId: session.id, content: 'x' })).toThrow(/role/);
  });

  test('rejects unknown role at the SQL layer', () => {
    const session = store.createSession();
    expect(() =>
      store.appendMessage({ sessionId: session.id, role: 'invalid', content: 'x' })
    ).toThrow(/CHECK constraint/);
  });
});

describe('listSessions and getMostRecentSession', () => {
  test('lists sessions ordered by updated_at DESC', () => {
    let now = 1;
    jest.spyOn(Date, 'now').mockImplementation(() => now++);
    store.createSession({ title: 'a' });
    store.createSession({ title: 'b' });
    Date.now.mockRestore();
    const result = store.listSessions();
    expect(result.map((s) => s.title)).toEqual(['b', 'a']);
  });

  test('getMostRecentSession returns null when none exist', () => {
    expect(store.getMostRecentSession()).toBeNull();
  });

  test('getMostRecentSession includes messages', () => {
    const session = store.createSession({ title: 'only' });
    store.appendMessage({ sessionId: session.id, role: 'user', content: 'hi' });
    const recent = store.getMostRecentSession();
    expect(recent.id).toBe(session.id);
    expect(recent.messages).toHaveLength(1);
    expect(recent.messages[0].content).toBe('hi');
  });
});

describe('renameSession and deleteSession', () => {
  test('rename updates the title', () => {
    const session = store.createSession();
    expect(store.renameSession(session.id, 'New title')).toBe(true);
    expect(store.getSession(session.id).title).toBe('New title');
  });

  test('rename returns false for unknown id', () => {
    expect(store.renameSession('nonexistent', 'x')).toBe(false);
  });

  test('delete cascades to messages', () => {
    const session = store.createSession();
    store.appendMessage({ sessionId: session.id, role: 'user', content: 'doomed' });
    expect(store.deleteSession(session.id)).toBe(true);
    expect(store.getSession(session.id)).toBeNull();
  });

  test('delete returns false for unknown id', () => {
    expect(store.deleteSession('nonexistent')).toBe(false);
  });
});

describe('registerSessionsIpc', () => {
  test('registers all seven session IPC channels', () => {
    store.registerSessionsIpc();
    expect([...ipcMain._handlers.keys()].sort()).toEqual(
      [
        IPC.AGENT_SESSION_LIST,
        IPC.AGENT_SESSION_GET,
        IPC.AGENT_SESSION_GET_RECENT,
        IPC.AGENT_SESSION_CREATE,
        IPC.AGENT_SESSION_RENAME,
        IPC.AGENT_SESSION_DELETE,
        IPC.AGENT_SESSION_APPEND_MESSAGE,
      ].sort()
    );
  });

  test('AGENT_SESSION_CREATE → AGENT_SESSION_APPEND_MESSAGE → AGENT_SESSION_GET round-trips', async () => {
    store.registerSessionsIpc();
    const create = ipcMain._handlers.get(IPC.AGENT_SESSION_CREATE);
    const append = ipcMain._handlers.get(IPC.AGENT_SESSION_APPEND_MESSAGE);
    const get = ipcMain._handlers.get(IPC.AGENT_SESSION_GET);

    const session = await create(null, { modelId: 'gemma4:e2b' });
    await append(null, { sessionId: session.id, role: 'user', content: 'hi' });
    const fetched = await get(null, { id: session.id });

    expect(fetched.messages).toHaveLength(1);
    expect(fetched.messages[0].content).toBe('hi');
  });
});
