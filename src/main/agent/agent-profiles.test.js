const FakeBetterSqlite3AgentProfilesDatabase = require('../../../test/helpers/fake-better-sqlite3-agent-profiles');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../../test/helpers/main-process-test-utils');

function loadAgentProfilesModule(options = {}) {
  return loadMainModule(require.resolve('./agent-profiles'), {
    ...options,
    extraMocks: {
      'better-sqlite3': () => FakeBetterSqlite3AgentProfilesDatabase,
      [require.resolve('../logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    },
  });
}

const IPC = require('../../shared/ipc-channels');

describe('agent-profiles', () => {
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
    const result = loadAgentProfilesModule({ userDataDir });
    mod = result.mod;
    ipcMain = result.ipcMain;
    return result;
  }

  describe('default profile', () => {
    test('auto-created on first access with safe tier defaults', () => {
      load();
      const def = mod.getDefaultProfile();
      expect(def).not.toBeNull();
      expect(def.name).toBe('Local AI');
      expect(def.is_default).toBe(true);
      expect(def.allowed_tool_tiers).toEqual([
        'local_safe',
        'local_sensitive',
        'external_network',
        'browser_mutation',
      ]);
    });

    test('not re-created on subsequent calls', () => {
      load();
      const first = mod.getDefaultProfile();
      const second = mod.getDefaultProfile();
      expect(first.id).toBe(second.id);
      expect(mod.listProfiles()).toHaveLength(1);
    });

    test('cannot be deleted', () => {
      load();
      const def = mod.getDefaultProfile();
      expect(mod.deleteProfile(def.id)).toBe(false);
      expect(mod.getDefaultProfile()).not.toBeNull();
    });

    test('can be renamed and have its system prompt updated', () => {
      load();
      const def = mod.getDefaultProfile();
      expect(mod.updateProfile(def.id, { name: 'Renamed', systemPrompt: 'You are…' })).toBe(true);
      const refreshed = mod.getDefaultProfile();
      expect(refreshed.name).toBe('Renamed');
      expect(refreshed.system_prompt).toBe('You are…');
      expect(refreshed.is_default).toBe(true);
    });
  });

  describe('createProfile', () => {
    test('creates a non-default profile with the given fields', () => {
      load();
      const created = mod.createProfile({
        name: 'Researcher',
        systemPrompt: 'Be terse.',
        allowedToolTiers: ['local_safe'],
      });
      expect(created.id).toMatch(/^[a-f0-9]{16}$/);
      expect(created.name).toBe('Researcher');
      expect(created.system_prompt).toBe('Be terse.');
      expect(created.allowed_tool_tiers).toEqual(['local_safe']);
      expect(created.is_default).toBe(false);
    });

    test('rejects when name is missing', () => {
      load();
      expect(() => mod.createProfile({})).toThrow(/name is required/);
    });

    test('rejects when allowedToolTiers is not an array', () => {
      load();
      expect(() =>
        mod.createProfile({ name: 'x', allowedToolTiers: 'local_safe' })
      ).toThrow(/array/);
    });
  });

  describe('listProfiles', () => {
    test('lists default first then by created_at ascending', () => {
      load();
      mod.createProfile({ name: 'B' });
      mod.createProfile({ name: 'C' });
      const list = mod.listProfiles();
      expect(list[0].is_default).toBe(true);
      expect(list[0].name).toBe('Local AI');
      expect(list[1].name).toBe('B');
      expect(list[2].name).toBe('C');
    });
  });

  describe('updateProfile / deleteProfile', () => {
    test('update returns false for unknown id', () => {
      load();
      expect(mod.updateProfile('nonexistent', { name: 'x' })).toBe(false);
    });

    test('delete returns false for unknown id and for the default', () => {
      load();
      expect(mod.deleteProfile('nonexistent')).toBe(false);
      expect(mod.deleteProfile(mod.getDefaultProfile().id)).toBe(false);
    });

    test('delete removes a non-default profile', () => {
      load();
      const created = mod.createProfile({ name: 'Throwaway' });
      expect(mod.deleteProfile(created.id)).toBe(true);
      expect(mod.getProfile(created.id)).toBeNull();
    });
  });

  describe('registerProfilesIpc', () => {
    test('registers all six profile IPC channels', () => {
      load();
      mod.registerProfilesIpc();
      expect([...ipcMain.handlers.keys()].sort()).toEqual(
        [
          IPC.AGENT_PROFILE_LIST,
          IPC.AGENT_PROFILE_GET,
          IPC.AGENT_PROFILE_GET_DEFAULT,
          IPC.AGENT_PROFILE_CREATE,
          IPC.AGENT_PROFILE_UPDATE,
          IPC.AGENT_PROFILE_DELETE,
        ].sort()
      );
    });

    test('AGENT_PROFILE_GET_DEFAULT returns the auto-created profile', async () => {
      load();
      mod.registerProfilesIpc();
      const def = await ipcMain.invoke(IPC.AGENT_PROFILE_GET_DEFAULT);
      expect(def.is_default).toBe(true);
      expect(def.allowed_tool_tiers.length).toBeGreaterThan(0);
    });

    test('CREATE → LIST → GET → UPDATE → DELETE round-trip', async () => {
      load();
      mod.registerProfilesIpc();

      const created = await ipcMain.invoke(IPC.AGENT_PROFILE_CREATE, {
        name: 'Tester',
        allowedToolTiers: ['local_safe'],
      });
      expect(created.id).toMatch(/^[a-f0-9]{16}$/);

      const all = await ipcMain.invoke(IPC.AGENT_PROFILE_LIST);
      expect(all.map((p) => p.name)).toContain('Tester');

      const fetched = await ipcMain.invoke(IPC.AGENT_PROFILE_GET, { id: created.id });
      expect(fetched.allowed_tool_tiers).toEqual(['local_safe']);

      const updated = await ipcMain.invoke(IPC.AGENT_PROFILE_UPDATE, {
        id: created.id,
        name: 'Tester v2',
      });
      expect(updated.ok).toBe(true);

      const refreshed = await ipcMain.invoke(IPC.AGENT_PROFILE_GET, { id: created.id });
      expect(refreshed.name).toBe('Tester v2');

      const deleted = await ipcMain.invoke(IPC.AGENT_PROFILE_DELETE, { id: created.id });
      expect(deleted.ok).toBe(true);
      expect(await ipcMain.invoke(IPC.AGENT_PROFILE_GET, { id: created.id })).toBeNull();
    });
  });
});
