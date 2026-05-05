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
4. Categorize entries using Keep a Changelog headings:
   - `### Added`
   - `### Changed`
   - `### Fixed`
   - `### Security`
   - (also `### Deprecated` and `### Removed` when applicable)
5. Skip housekeeping commits:
   - TODO/changelog commits
   - version-bump commits, including `chore(release): open <next>-dev cycle` and `chore(release): bump version to <version>`
   - dependency lock-only updates
   - README/docs rewrites
   - internal refactors without user impact
   - test-only commits
6. Merge related commits into a single user-facing entry.
7. Inspect PR merge commits by reviewing underlying commits.
8. Re-run the git log before editing to catch late commits.
9. Prepend the new version section above the previous one. If a `## [Unreleased]` heading is present, replace it with `## [<version>] - <YYYY-MM-DD>`. If it is absent (rare, since the dev cycle on `main` accumulates entries under `[Unreleased]`), add the new version heading directly. When writing the first user-facing change in the next dev cycle, re-introduce a `## [Unreleased]` heading above the latest released version.

## Output Style

- Write user-facing outcomes, not implementation noise.
- Prefer concise bullets that explain impact.
