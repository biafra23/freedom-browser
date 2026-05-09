jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skillCatalog = require('./skill-catalog');
const { _internals } = skillCatalog;

const BUNDLED = skillCatalog.BUNDLED_SKILLS_DIR;

function makeMockPi(skillsByPath) {
  return {
    loadSkills: jest.fn(({ skillPaths }) => {
      const skills = [];
      for (const dir of skillPaths) {
        const list = skillsByPath[dir] || [];
        for (const s of list) {
          skills.push({
            ...s,
            filePath: s.filePath || path.join(dir, `${s.name}.md`),
          });
        }
      }
      return { skills, diagnostics: [] };
    }),
  };
}

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
});

afterEach(() => {
  _internals.setPiModule(null);
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe('stripFrontmatter', () => {
  test('removes a YAML frontmatter block', () => {
    const input = '---\nname: foo\ndescription: bar\n---\nbody text\n';
    expect(_internals.stripFrontmatter(input)).toBe('body text\n');
  });

  test('returns text unchanged when no frontmatter', () => {
    expect(_internals.stripFrontmatter('hello world')).toBe('hello world');
  });
});

describe('classifySource', () => {
  test('returns "builtin" for paths under the bundled dir', () => {
    expect(
      _internals.classifySource('/bundled/foo.md', { bundledReal: '/bundled', userReal: null })
    ).toBe('builtin');
  });

  test('returns "user" for paths under the user dir', () => {
    expect(
      _internals.classifySource('/user/foo.md', { bundledReal: '/bundled', userReal: '/user' })
    ).toBe('user');
  });

  test('returns null for paths outside both', () => {
    expect(
      _internals.classifySource('/etc/passwd', { bundledReal: '/bundled', userReal: '/user' })
    ).toBeNull();
  });
});

describe('getSkillCatalog', () => {
  test('tags a skill loaded from the bundled dir as builtin', async () => {
    _internals.setPiModule(
      makeMockPi({
        [BUNDLED]: [{ name: 'tldr', description: 'short', filePath: path.join(BUNDLED, 'tldr.md') }],
      })
    );
    const catalog = await skillCatalog.getSkillCatalog({ agentDir: tmpRoot });
    expect(catalog).toEqual([
      expect.objectContaining({ name: 'tldr', source: 'builtin', description: 'short' }),
    ]);
  });

  test('tags a skill from the user dir as user', async () => {
    const userDir = path.join(tmpRoot, 'skills');
    fs.mkdirSync(userDir);
    const userSkillPath = path.join(userDir, 'mine.md');
    fs.writeFileSync(userSkillPath, '---\nname: mine\ndescription: my skill\n---\nbody\n');
    _internals.setPiModule(
      makeMockPi({
        [BUNDLED]: [],
        [userDir]: [{ name: 'mine', description: 'my skill', filePath: userSkillPath }],
      })
    );
    const catalog = await skillCatalog.getSkillCatalog({ agentDir: tmpRoot });
    expect(catalog).toEqual([
      expect.objectContaining({ name: 'mine', source: 'user' }),
    ]);
  });

  test('drops a user skill that collides with a bundled name (bundled wins)', async () => {
    const userDir = path.join(tmpRoot, 'skills');
    fs.mkdirSync(userDir);
    const userTldrPath = path.join(userDir, 'tldr.md');
    fs.writeFileSync(userTldrPath, '---\nname: tldr\ndescription: hijacked\n---\nbody\n');
    _internals.setPiModule(
      makeMockPi({
        // Bundled comes first in skillPaths so Pi presents it first.
        [BUNDLED]: [
          { name: 'tldr', description: 'real one', filePath: path.join(BUNDLED, 'tldr.md') },
        ],
        [userDir]: [
          { name: 'tldr', description: 'hijacked', filePath: userTldrPath },
        ],
      })
    );
    const catalog = await skillCatalog.getSkillCatalog({ agentDir: tmpRoot });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ source: 'builtin', description: 'real one' });
  });

  test('drops skills whose realpath escapes both allowed directories', async () => {
    const escapeFile = path.join(tmpRoot, 'escape.md');
    fs.writeFileSync(escapeFile, 'content');
    _internals.setPiModule(
      makeMockPi({
        [BUNDLED]: [
          { name: 'sneaky', description: 'oops', filePath: escapeFile },
        ],
      })
    );
    const catalog = await skillCatalog.getSkillCatalog({ agentDir: tmpRoot });
    expect(catalog).toEqual([]);
  });

  test('throws when agentDir is missing', async () => {
    await expect(skillCatalog.getSkillCatalog({})).rejects.toThrow(/agentDir/);
  });
});

describe('readSkillByName', () => {
  test('returns body with frontmatter stripped + source tag for a known skill', async () => {
    const userDir = path.join(tmpRoot, 'skills');
    fs.mkdirSync(userDir);
    const filePath = path.join(userDir, 'foo.md');
    fs.writeFileSync(filePath, '---\nname: foo\ndescription: a skill\n---\nbody body body\n');
    _internals.setPiModule(
      makeMockPi({
        [BUNDLED]: [],
        [userDir]: [{ name: 'foo', description: 'a skill', filePath }],
      })
    );
    const result = await skillCatalog.readSkillByName({ agentDir: tmpRoot, name: 'foo' });
    expect(result).toEqual({
      name: 'foo',
      description: 'a skill',
      source: 'user',
      body: 'body body body',
    });
  });

  test('returns null for an unknown skill name', async () => {
    _internals.setPiModule(makeMockPi({ [BUNDLED]: [] }));
    const result = await skillCatalog.readSkillByName({ agentDir: tmpRoot, name: 'nonexistent' });
    expect(result).toBeNull();
  });

  test('returns null when name is empty or non-string', async () => {
    _internals.setPiModule(makeMockPi({ [BUNDLED]: [] }));
    expect(await skillCatalog.readSkillByName({ agentDir: tmpRoot, name: '' })).toBeNull();
    expect(await skillCatalog.readSkillByName({ agentDir: tmpRoot, name: null })).toBeNull();
  });
});
