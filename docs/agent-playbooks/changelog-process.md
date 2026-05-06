# Changelog Process Playbook

Use this playbook when asked to update `CHANGELOG.md` for a new version.

## Procedure

1. Find the baseline commit. Prefer the previous release's tag, which is unambiguous regardless of dev-suffix bookkeeping:
   - `git rev-list -n 1 v<prev>` (e.g. `v0.7.0`).
   - Fallback if the tag is unavailable: `git log --oneline -p -- package.json` and pick the most recent version-line edit *before* the current release branch's "promote dev version" commit. With the dev-suffix workflow, the baseline is normally the `chore(release): open <current>-dev cycle` commit on `main`.
2. Gather all commits since baseline:
   - `git log --pretty=format:"%H%n%s%n%b%n---" <baseline>..HEAD`
3. Get the release date from git history:
   - `git show -s --format="%ad" --date=short HEAD`
4. Categorize entries using Keep a Changelog headings, in this order:
   - `### Added`
   - `### Changed`
   - `### Deprecated` (when applicable)
   - `### Removed` (when applicable)
   - `### Fixed`
   - `### Security`

   The order matches Keep a Changelog and the project's prior releases. Do not reorder — `Security` last keeps the heaviest, most prose-dense section out of the reader's path when they're scanning for what changed for them. Omit any heading that has no entries.
5. Skip housekeeping commits:
   - TODO/changelog commits
   - version-bump commits, including `chore(release): open <next>-dev cycle` and `chore(release): bump version to <version>`
   - dependency lock-only updates
   - README/docs rewrites
   - internal refactors without user impact
   - test-only commits
   - **developer-only fixes**: console-noise cleanup on `npm start`, dev-server bugs, build/lint/CI issues, anything whose impact is only visible to people running from source. The changelog audience is the binary user — if the fix doesn't affect them, drop the entry.
6. Merge related commits into a single user-facing entry.
7. Inspect PR merge commits by reviewing underlying commits.
8. Re-run the git log before editing to catch late commits.
9. Prepend the new version section above the previous one. If a `## [Unreleased]` heading is present, replace it with `## [<version>] - <YYYY-MM-DD>`. If it is absent (rare, since the dev cycle on `main` accumulates entries under `[Unreleased]`), add the new version heading directly. When writing the first user-facing change in the next dev cycle, re-introduce a `## [Unreleased]` heading above the latest released version.

## Output Style

The shipped releases (e.g. `0.6.x`, `0.7.0`) are the canonical voice. When drafting a new release, read the most recent shipped entry first and match its density. Drift is easy and shows up immediately in side-by-side comparison.

### Voice rules (apply across all sections)

- **One thought per bullet.** If you joined two ideas with `;` or `. `, split into two bullets. Bullets are not paragraphs.
- **No bold lead-ins.** Every entry opens with plain prose. Bold is for inline emphasis only. Plain-text labels on explainer sub-bullets (e.g. `Reasoning: …` on a "why this matters" sub-bullet) are fine — the rule is about bold marketing emphasis, not structural clarity.
- **No trailing periods** on bullet entries.
- **No cross-references between sections.** Don't write "see Added" or "as in the Security entry above" — each bullet stands alone.
- **State user impact, not implementation.** Mechanism lives in the code, not the changelog. `Tab spinner stays on through ENS link clicks` — not `Tab spinner stays on because handler now awaits the resolver promise before clearing state`.
- **Drop internal commentary.** `(already latest)` next to a version, `(precautionary)` qualifiers, project-internal context: noise.
- **Migration guidance points to README**, doesn't duplicate it. Use a conversational pointer like `(see README for site-author migration)` rather than inlining the migration content.

### Per-section voice

| Section | Lead pattern | Example |
| --- | --- | --- |
| Added | noun phrase (the *thing* added) | `Verification shield in the address bar` |
| Changed | noun phrase or subject-led | `Speculative gateway prefetch during ENS quorum waves` |
| Security | imperative verb-led for actions taken, subject-led for state changes | `Pinned uuid to ^14.0.0`; `Multi-RPC quorum required for ENS lookups` |
| Fixed | subject-led "X now does Y" / "X no longer does Y" | `Tab loading spinner stays on through ENS link clicks` |

### Structure rules

- **Multi-surface features = one parent bullet + sub-bullets**, not multiple top-level entries. The `0.7.0` `Experimental Identity & Wallet system:` block is the model.
- **Dependency lists are flat comma lists**, not nested semicolons or sub-bullets. Match `0.7.0`'s `Updated bundled nodes: Bee 2.7.0 → 2.7.1, Kubo 0.39.0 → 0.40.1, Radicle 1.6.1 → 1.8.0`.

### Deduplicate across sections

Each shipped change appears exactly once. The common drafting failure is restating the same change in a second section using different framing:

- **Added ↔ Security**: a new feature with security motivation belongs in Added, not in both. Don't restate the threat-model framing as a separate Security bullet — the Added entry's user-facing surface (toggle name, settings page, interstitial) already conveys the property.
- **Added ↔ Fixed**: polish on a feature that ships in this release is part of Added, not a separate Fixed entry. "X consistently with Y" or "X tightens its CSP" on a brand-new X is how it shipped, not a regression fix.
- **Fixed entries describe regressions on shipped functionality.** If the underlying surface didn't exist before this release, the entry belongs in Added (or doesn't belong at all).

When in doubt, ask: *did this thing exist in the previous release?* If no, it's Added. If yes and it now behaves differently, it's Changed / Fixed / Security depending on the kind of difference.

### Categorising dependency updates

Dependency updates inside an active major series almost always carry upstream security fixes. Default to **Security** for these (matching `0.6.1`'s `Updated dependencies: Electron 39→40, …` placement). Use Changed only when the bump is purely a feature pickup with no security content.

### Review gate

An agent draft is a starting point, not a final. After drafting, diff the new section against the previous shipped release and trim/restructure until per-entry density matches. The releaser must read and amend the changelog commit before §5 (upload) and §6 (tag) of the release process — see `release-process.md`.
