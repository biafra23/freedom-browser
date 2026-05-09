/**
 * Skill Catalog
 *
 * Freedom-owned wrapper around Pi's `loadSkills`. Centralises three
 * concerns the rest of the codebase shouldn't have to think about:
 *
 *   1. **Path safety.** Each loaded skill's realpath must resolve under
 *      the bundled skills directory or `<agentDir>/skills`. Symlinks
 *      pointing outside (e.g., `/etc/passwd`) get filtered out, so
 *      neither `getSkillCatalog` callers nor `read_skill` can be
 *      tricked into surfacing arbitrary files.
 *   2. **Bundled-wins collisions.** A user-authored skill with the
 *      same name as a built-in is dropped. Built-in names are
 *      reserved so model behaviour stays predictable across
 *      installations.
 *   3. **Source tagging.** Every catalog entry knows whether it came
 *      from the bundled set or the user's directory — surfaced in the
 *      system prompt so the agent can treat user-authored recipes
 *      with appropriate caution.
 *
 * Pure(ish): the only side effect is reading from disk. Pi is loaded
 * via the shared `pi-runtime` cache, so tests can inject a mock via
 * `pi-runtime._internals.setPiModule`.
 */

const fs = require('node:fs');
const path = require('node:path');
const log = require('../logger');

const BUNDLED_SKILLS_DIR = path.join(__dirname, 'skills');

// Local Pi cache, separate from pi-runtime's. Originally tried sharing
// pi-runtime's `_internals.loadPi`, but the require cycle (pi-runtime
// → listFreedomSkills → skill-catalog → pi-runtime) leaves
// `piRuntime` as an empty exports object even with a lazy require
// inside listFreedomSkills. Owning our own cache sidesteps the cycle
// entirely; tests inject via the `setPiModule` _internals export.
let _piModule = null;
async function loadPi() {
  if (!_piModule) {
    _piModule = await import('@earendil-works/pi-coding-agent');
  }
  return _piModule;
}

// Strip a YAML frontmatter block from the top of a skill .md file.
// Pi has its own `stripFrontmatter` export; we keep a local copy so
// this is sync (no `loadPi()` dependency) and so the implementation
// can't drift if Pi ships a behaviour change. CRLF handled via `\r?`.
const FRONTMATTER_RE = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/;
function stripFrontmatter(text) {
  const match = FRONTMATTER_RE.exec(text);
  return match ? text.slice(match[0].length) : text;
}

// fs.realpathSync that returns null instead of throwing — used to
// canonicalise both the directory boundaries and each skill's filePath
// so symlink shenanigans can't smuggle a file out of bounds.
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function classifySource(realPath, { bundledReal, userReal }) {
  if (bundledReal && (realPath === bundledReal || realPath.startsWith(`${bundledReal}${path.sep}`))) {
    return 'builtin';
  }
  if (userReal && (realPath === userReal || realPath.startsWith(`${userReal}${path.sep}`))) {
    return 'user';
  }
  return null;
}

function buildSkillPaths({ agentDir, userReal }) {
  // BUNDLED first so Pi's collision diagnostics treat user-authored
  // duplicates as the loser. We re-enforce bundled-wins below in case
  // Pi's behaviour ever changes.
  if (!agentDir) return [BUNDLED_SKILLS_DIR];
  const userDir = path.join(agentDir, 'skills');
  return userReal ? [BUNDLED_SKILLS_DIR, userDir] : [BUNDLED_SKILLS_DIR];
}

/**
 * Load every visible skill, with source + safety filtering applied.
 *
 * @param {object} args
 * @param {string} args.agentDir
 * @returns {Promise<Array<{name, description, source, filePath}>>}
 */
async function getSkillCatalog({ agentDir }) {
  if (!agentDir) throw new Error('getSkillCatalog requires an agentDir');
  const userDir = path.join(agentDir, 'skills');
  const bundledReal = safeRealpath(BUNDLED_SKILLS_DIR);
  const userReal = fs.existsSync(userDir) ? safeRealpath(userDir) : null;

  const pi = await loadPi();
  const result = pi.loadSkills({
    cwd: agentDir,
    agentDir,
    skillPaths: buildSkillPaths({ agentDir, userReal }),
    includeDefaults: false,
  });

  const byName = new Map();
  for (const skill of result?.skills || []) {
    const real = safeRealpath(skill.filePath);
    if (!real) continue;
    const source = classifySource(real, { bundledReal, userReal });
    if (!source) {
      log.warn(`[skill-catalog] dropping out-of-scope skill: ${skill.filePath}`);
      continue;
    }
    const existing = byName.get(skill.name);
    // Bundled-wins: a builtin replaces a user entry; anything else is
    // dropped on collision.
    const incomingWins = source === 'builtin' && existing?.source !== 'builtin';
    if (existing && !incomingWins) continue;
    byName.set(skill.name, {
      name: skill.name,
      description: skill.description,
      source,
      filePath: real,
    });
  }
  return [...byName.values()];
}

/**
 * Resolve a skill by name and return its body (frontmatter stripped).
 * Returns null when no matching skill exists. Does NOT trust the name
 * blindly — the file is only read if the catalog has it under a safe
 * realpath.
 */
async function readSkillByName({ agentDir, name }) {
  if (!agentDir) throw new Error('readSkillByName requires an agentDir');
  if (typeof name !== 'string' || name.length === 0) return null;
  const catalog = await getSkillCatalog({ agentDir });
  const entry = catalog.find((s) => s.name === name);
  if (!entry) return null;
  let raw;
  try {
    raw = fs.readFileSync(entry.filePath, 'utf-8');
  } catch (err) {
    log.warn(`[skill-catalog] read failed for ${entry.filePath}: ${err?.message || err}`);
    return null;
  }
  return {
    name: entry.name,
    description: entry.description,
    source: entry.source,
    body: stripFrontmatter(raw).trim(),
  };
}

module.exports = {
  getSkillCatalog,
  readSkillByName,
  BUNDLED_SKILLS_DIR,
  _internals: {
    stripFrontmatter,
    classifySource,
    safeRealpath,
    buildSkillPaths,
    loadPi,
    setPiModule: (mod) => {
      _piModule = mod;
    },
  },
};
