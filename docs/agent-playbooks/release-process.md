# Release Process Playbook

Use this playbook when cutting a new Freedom release (any `MAJOR.MINOR.PATCH` bump).

It complements `changelog-process.md` — that playbook covers the mechanics of writing `CHANGELOG.md`; this one covers the surrounding branch, version-bump, build, tag, and publish steps.

## 0. Create a release branch first

All release work happens on a dedicated branch off `main`, never on `main` directly.

Naming convention (matches prior releases like `release/0.6.2`):

```
release/<version>
```

For example, for 0.7.0:

```
git checkout main
git pull --ff-only
git checkout -b release/0.7.0
```

Rationale:

- Keeps `main` unblocked while the release is being stabilized.
- Gives a clear target for last-minute build/changelog fixups without polluting feature history.
- The artifacts you build, upload, and tag all come from this branch, so a broken build can be fixed here before anything lands on `main`.

## 1. Promote the dev version

Between releases, `main` carries a `<next>-dev` version (see Step 10). On the release branch, strip that suffix so the build advertises the real release number.

Update the version string in exactly these two files:

- `package.json` — top-level `"version"`.
- `package-lock.json` — the two top-level `"version"` entries (root object and the `""` package entry). Ignore any `0.X.Y` strings inside transitive dependency version ranges (e.g. `iconv-lite`).

No other source file hard-codes the version — the renderer, `electron-builder`, and `electron-updater` all read it from `package.json` at runtime/build time.

If the release version differs from the in-flight `<next>-dev` (for example, the cycle was opened as `0.7.1-dev` but is being shipped as `0.8.0`), set the new version directly here — the dev suffix exists to make local builds self-identify, not to commit you to a specific number.

Commit style (matches prior releases):

```
chore(release): bump version to <version>
```

## 2. Refresh dependencies

On the release branch, before finalizing the changelog, bring npm packages and bundled binaries to their current stable versions. Per `AGENTS.md` rule 9, **this requires explicit releaser approval per bump** — agents working through this step should triage and propose, not unilaterally upgrade.

### npm dependencies

Run `npm outdated --json` and triage:

- **In-range bumps** (`wanted == latest`): patch and minor updates that semver guarantees back-compat for. Default to taking them all unless one has a known regression.
- **Out-of-range bumps** (`wanted < latest`): a new major (or a constrained range still pointing at an older line). Defer to a dedicated release cycle unless the major bump is the headline of this release. Electron majors (which bring Chromium and Node leaps) in particular should get their own cycle.

Apply approved bumps with `npm update` (matches `0.7.1`'s `chore(deps): refresh in-range bumps` commit). This updates `package-lock.json` to the resolved versions without touching the declared `^` ranges in `package.json`, because the ranges already permit those versions. Use `npm install <pkg>@<version>` only when you need to widen a `^` range or pin an exact version. Re-run `npm ci && npm run lint && npm test` before committing to catch regressions.

### Audit warnings

After updating, run `npm audit` and decide per advisory:

- **Auto-fixable, non-breaking**: take `npm audit fix`.
- **Auto-fixable but `--force` required** (downgrades a top-level dep across a major): do **not** take the auto-fix. Add an `overrides` block in `package.json` pinning just the transitive to a non-vulnerable version. `0.7.1` did exactly this for `uuid` under `@metamask/utils`; the same pattern applies to anything where the auto-fix would regress a direct dependency.
- **Not exploitable in our usage**: document why in the commit body (`0.7.1`'s commit explains the `uuid.v3/v5/v6` advisory is unreachable from our import graph).

### Bundled binaries (Bee, Kubo / IPFS, Radicle)

Each fetch script resolves the latest from a **vendor-specific** upstream — do **not** use GitHub tags as a stand-in, they can lag the actual release pointer (Radicle in particular publishes new releases to `files.radicle.xyz` first; GitHub `/tags` showed `1.7.1` as the latest stable while `1.9.1` was already shipping).

| Binary | Authoritative source the fetch script reads |
|---|---|
| Bee (`scripts/fetch-bee.js`) | `https://api.github.com/repos/ethersphere/bee/releases/latest` |
| Kubo (`scripts/fetch-ipfs.js`) | `https://dist.ipfs.tech/kubo/versions` |
| Radicle main (`scripts/fetch-radicle.js`) | `https://files.radicle.xyz/releases/latest` |
| Radicle httpd (same script) | `https://files.radicle.xyz/releases/radicle-httpd/latest` |

To check whether the bundled binary is stale, compare its self-reported version against the source above:

```
./bee-bin/<arch>/bee version
./ipfs-bin/<arch>/ipfs --version
./radicle-bin/<arch>/rad --version
./radicle-bin/<arch>/radicle-httpd --version
```

For each binary that's behind, re-run its fetch script (`npm run bee:download` / `ipfs:download` / `radicle:download` — each fetches every supported arch) and verify the result still passes `npm run check-binaries`. Note: `*-bin/` directories are gitignored, so the binary refresh produces no file-tree change. The build pipeline (§5) re-fetches at artifact-build time, so what ends up shipping is whatever upstream `latest` resolves to then — document the version in the changelog and in the `chore(build): update bundled <name> to <version>` commit body.

### Commit style

Match `0.7.1`'s grouping: one commit for npm refresh (lockfile + any `overrides`), a separate commit per bundled-binary group only if the upstream version changed. Body lists the bumps as `name old -> new` lines (no decorative arrows) and documents any audit decisions taken (see Audit warnings above).

```
chore(deps): refresh in-range bumps[ and clear <advisory> audit advisory]
chore(build): update bundled <binary> to <version>
```

### Changelog placement

Per `changelog-process.md` § Categorising dependency updates, dependency updates inside an active major series default to `Security` (they almost always carry upstream security fixes). The next step (§3 Finalize the changelog) is where this lands.

## 3. Finalize the changelog

Follow `changelog-process.md` in full. Key points for release branches:

- The baseline for `git log` is the last `package.json` version bump commit.
- Replace the `## [Unreleased]` heading with `## [<version>] - <YYYY-MM-DD>` using the date from `git show -s --format="%ad" --date=short HEAD`.
- Do **not** leave an empty `## [Unreleased]` section behind. The first user-facing change after the release re-introduces the heading above the latest version.

Commit style:

```
docs(changelog): add user-facing <version> release notes
```

**Review gate (when drafted by an agent).** If the changelog entries were drafted by an agent — or by anyone other than the releaser — **do not create the `docs(changelog): …` commit yet**. Leave the `CHANGELOG.md` edits unstaged (or staged, but uncommitted) on the release branch, present the diff to the releaser, and wait for explicit approval before committing. Iterating in the working tree is cheaper than amending a commit, and avoids the `git commit --amend` ambiguity for agents whose tooling discourages amending without an explicit user request. `CHANGELOG.md` is not read by §4 (verify) or §5 (build distributables), so those steps can run in parallel with the review. §6 (upload + website) and §7 (tag) freeze the changelog state visible to end users and must wait until the commit lands.

If the changelog is already committed when a correction is requested (e.g. the releaser drafted it themselves, or this gate was missed), amend the existing `docs(changelog): …` commit rather than stacking a second changelog commit.

## 4. Verify before building

On the release branch, with a clean working tree:

```
npm ci
npm run lint
npm test
npm run check-binaries
```

Spot-check the app once (`npm start`) and confirm the About/version surface reflects the new number.

## 5. Build distributables

Run from the release branch. All builds read the version from `package.json`.

### macOS (signed + notarized, inline)

```
npm run dist -- --mac
```

`build.mac.notarize: true` in `package.json` makes `electron-builder` submit and staple the notarization in the same invocation. The command blocks until Apple finishes notarizing — expect several minutes. This is the default mac release flow.

**Fallback — async notarization.** If notarization is slow or flaky and you need to do it out-of-band (for example to retry or to free the terminal), use the split scripts instead:

```
npm run dist:mac:prepare-notary     # builds with --no-notarize
npm run dist:mac:submit-notary      # uploads to Apple
npm run dist:mac:notary-status      # polls status
npm run dist:mac:notary-log         # fetch log if it fails
npm run dist:mac:staple-notary      # staple once accepted
```

These require `.env` credentials via `dotenv-cli` and are implemented in `scripts/macos-notary.js`.

### Linux

```
npm run dist:linux:x64:docker
npm run dist:linux:arm64:docker
```

Both run `electron-builder` inside a Linux container and download the matching Radicle binaries for the target arch.

### Windows

```
npm run dist -- --win --x64
```

`electron-builder` cross-builds the Windows NSIS installer and zip from the mac host — no Windows machine required. Windows builds intentionally ship without Radicle (see `README.md`).

## 6. Upload binaries and update the website

1. Upload the generated artifacts from `dist/` to `https://freedom.baby/downloads`, including the `latest*.yml` manifests so existing installs pick up the update via `electron-updater` (which is configured with `publish.provider = generic` pointing at that URL).
2. Update the Freedom website to point at the new version:
   - Download links and per-platform file-size metadata.
   - Version string in the downloads intro (e.g. `Alpha release (<version>)`).
   - `Changelog` link — pin to the release branch so the page shows the CHANGELOG state that matches the binaries being served: `https://github.com/solardev-xyz/freedom-browser/blob/release/<version>/CHANGELOG.md`. Do not link to `main`, which will absorb future releases' in-progress notes.

Do this **before** tagging — if an upload reveals a broken artifact, you want to be able to fix it on the release branch without already having a tag pointing at a broken commit.

## 7. Tag the release

On the release branch, from the commit you actually built and shipped:

```
git tag -a v<version> -m "Release <version>"
```

Tag format is `v<version>` (lowercase `v`), matching `v0.6.2`. Do not push the tag yet — push it together with the merge in the next step so `main` and the tag move as one.

## 8. Merge the release branch into main

Optionally open a PR from `release/<version>` into `main` for review. Otherwise merge directly:

```
git checkout main
git pull --ff-only
git merge --no-ff release/<version>
git push origin main
git push origin v<version>
```

The `--no-ff` is deliberate — it preserves the release branch as a visible bubble in `main`'s history, which matches how earlier releases landed.

## 9. Post-release housekeeping

- Confirm the GitHub release page lists the correct artifacts and release notes.
- Keep the `release/<version>` branch around (do not delete) — it matches the historical pattern and is the natural base for a `hotfix/<version>.<patch>` branch later if needed.
- Any build-only fixes that land after the version bump should be committed on the release branch with `fix(build): ...` messages, same as the `0.6.2` cycle did.

## 10. Open the next dev cycle on `main`

Immediately after the merge, bump `main` to the next dev version so local/CI builds and the About dialog stop advertising the just-shipped release.

Default to a patch bump — e.g. after shipping `0.7.0`, set `main` to `0.7.1-dev`. If the next cycle later turns out to be a minor or major (or you decide upfront), re-bump to `0.8.0-dev` / `1.0.0-dev`; nothing downstream depends on the suffix's exact `MINOR.PATCH`.

Update the same two files as Step 1:

- `package.json` — top-level `"version"`.
- `package-lock.json` — both top-level `"version"` entries.

Commit on `main` (not on the release branch):

```
chore(release): open <next>-dev cycle
```

Why a `-dev` suffix rather than a bare `<next>`:

- The About dialog (`app.getVersion()`) and the updater User-Agent in `src/main/updater.js` are the only surfaces that show the version. With the suffix, a screenshot or bug report from a local build self-identifies as unreleased, instead of falsely claiming the previous release.
- Per semver, `<next>-dev` sorts strictly below `<next>`, so the eventual release will always look like an upgrade to a dev install (never a downgrade).
- Note: a `-dev` suffix does **not** rescue dev installs from missing a hotfix on the previous line. By semver, `0.8.0-dev > 0.7.1` (major/minor/patch dominate; pre-release tags only break ties within the same triple). This is acceptable here because dev builds are run by developers from source, not via `electron-updater`. If you ever hand pre-release builds to non-developer testers, revisit this.
