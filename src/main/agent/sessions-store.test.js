const FakeBetterSqlite3AgentSessionsDatabase = require('../../../test/helpers/fake-better-sqlite3-agent-sessions');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../../test/helpers/main-process-test-utils');

function loadSessionsStoreModule(options = {}) {
  return loadMainModule(require.resolve('./sessions-store'), {
    ...options,
    extraMocks: {
      'better-sqlite3': () => FakeBetterSqlite3AgentSessionsDatabase,
      [require.resolve('../logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    },
  });
}

const IPC = require('../../shared/ipc-channels');

describe('agent sessions store', () => {
  let userDataDir;
  let mod;
  let ipcMain;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    mod = null;
    ipcMain = null;
  });

  afterEach(() => {
    if (mod?.closeDb) mod.closeDb();
    removeTempUserDataDir(userDataDir);
  });

  function load() {
    const result = loadSessionsStoreModule({ userDataDir });
    mod = result.mod;
    ipcMain = result.ipcMain;
    return result;
  }

  describe('createSession', () => {
    test('creates a session with generated id and timestamps', () => {
      load();
      const session = mod.createSession({ modelId: 'gemma4:e2b' });
      expect(session.id).toMatch(/^[a-f0-9]{16}$/);
      expect(session.model_id).toBe('gemma4:e2b');
      expect(session.title).toBeNull();
      expect(session.created_at).toEqual(session.updated_at);
      expect(typeof session.created_at).toBe('number');
    });

    test('persists the session so getSession can read it back', () => {
      load();
      const created = mod.createSession({ title: 'foo' });
      const fetched = mod.getSession(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.title).toBe('foo');
      expect(fetched.messages).toEqual([]);
    });
  });

  describe('appendMessage', () => {
    test('writes a user message under the session and returns it', () => {
      load();
      const session = mod.createSession();
      const msg = mod.appendMessage({
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
      load();
      const session = mod.createSession();
      const parts = { toolCalls: [{ id: 't1', name: 'navigate', args: { url: 'x' } }] };
      const msg = mod.appendMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'calling tool',
        parts,
      });
      expect(JSON.parse(msg.parts_json)).toEqual(parts);
    });

    test('returns messages in created_at order via getSession', () => {
      load();
      const session = mod.createSession();
      let now = session.created_at + 1;
      jest.spyOn(Date, 'now').mockImplementation(() => now++);
      mod.appendMessage({ sessionId: session.id, role: 'user', content: 'first' });
      mod.appendMessage({ sessionId: session.id, role: 'assistant', content: 'second' });
      mod.appendMessage({ sessionId: session.id, role: 'user', content: 'third' });
      Date.now.mockRestore();
      const { messages } = mod.getSession(session.id);
      expect(messages.map((m) => m.content)).toEqual(['first', 'second', 'third']);
    });

    test('touches updated_at on the parent session', () => {
      load();
      const session = mod.createSession();
      const before = session.updated_at;
      const msAfter = before + 1;
      jest.spyOn(Date, 'now').mockReturnValue(msAfter);
      mod.appendMessage({ sessionId: session.id, role: 'user', content: 'x' });
      Date.now.mockRestore();
      const refreshed = mod.getSession(session.id);
      expect(refreshed.updated_at).toBe(msAfter);
    });

    test('rejects when sessionId is missing', () => {
      load();
      expect(() => mod.appendMessage({ role: 'user', content: 'x' })).toThrow(/sessionId/);
    });

    test('rejects when role is missing', () => {
      load();
      const session = mod.createSession();
      expect(() => mod.appendMessage({ sessionId: session.id, content: 'x' })).toThrow(/role/);
    });

    test('rejects unknown role at the SQL layer', () => {
      load();
      const session = mod.createSession();
      expect(() =>
        mod.appendMessage({ sessionId: session.id, role: 'invalid', content: 'x' })
      ).toThrow(/CHECK constraint/);
    });
  });

  describe('listSessions and getMostRecentSession', () => {
    test('lists sessions ordered by updated_at DESC', () => {
      load();
      let now = 1;
      jest.spyOn(Date, 'now').mockImplementation(() => now++);
      mod.createSession({ title: 'a' });
      mod.createSession({ title: 'b' });
      Date.now.mockRestore();
      const result = mod.listSessions();
      expect(result.map((s) => s.title)).toEqual(['b', 'a']);
    });

    test('getMostRecentSession returns null when none exist', () => {
      load();
      expect(mod.getMostRecentSession()).toBeNull();
    });

    test('getMostRecentSession includes messages', () => {
      load();
      const session = mod.createSession({ title: 'only' });
      mod.appendMessage({ sessionId: session.id, role: 'user', content: 'hi' });
      const recent = mod.getMostRecentSession();
      expect(recent.id).toBe(session.id);
      expect(recent.messages).toHaveLength(1);
      expect(recent.messages[0].content).toBe('hi');
    });
  });

  describe('renameSession and deleteSession', () => {
    test('rename updates the title', () => {
      load();
      const session = mod.createSession();
      expect(mod.renameSession(session.id, 'New title')).toBe(true);
      expect(mod.getSession(session.id).title).toBe('New title');
    });

    test('rename returns false for unknown id', () => {
      load();
      expect(mod.renameSession('nonexistent', 'x')).toBe(false);
    });

    test('delete cascades to messages', () => {
      load();
      const session = mod.createSession();
      mod.appendMessage({ sessionId: session.id, role: 'user', content: 'doomed' });
      expect(mod.deleteSession(session.id)).toBe(true);
      expect(mod.getSession(session.id)).toBeNull();
    });

    test('delete returns false for unknown id', () => {
      load();
      expect(mod.deleteSession('nonexistent')).toBe(false);
    });
  });

  describe('registerSessionsIpc', () => {
    test('registers all seven session IPC channels', () => {
      load();
      mod.registerSessionsIpc();
      expect([...ipcMain.handlers.keys()].sort()).toEqual(
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
      load();
      mod.registerSessionsIpc();
      const session = await ipcMain.invoke(IPC.AGENT_SESSION_CREATE, { modelId: 'gemma4:e2b' });
      await ipcMain.invoke(IPC.AGENT_SESSION_APPEND_MESSAGE, {
        sessionId: session.id,
        role: 'user',
        content: 'hi',
      });
      const fetched = await ipcMain.invoke(IPC.AGENT_SESSION_GET, { id: session.id });
      expect(fetched.messages).toHaveLength(1);
      expect(fetched.messages[0].content).toBe('hi');
    });
  });
});
