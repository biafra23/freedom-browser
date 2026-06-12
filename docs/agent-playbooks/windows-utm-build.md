# Windows-in-UTM Build Playbook

Use this playbook to produce and run a **native Windows build** of Freedom on a
UTM virtual machine running on an Apple Silicon Mac — for example to manually
verify a Windows-specific fix, or to smoke-test the packaged artifact on real
Windows (see `release-process.md` §6).

## When to use this (vs. cross-building)

`release-process.md` §5 cross-builds the Windows installer from the mac host
(`npm run dist -- --win --x64`). That is correct for producing the *distributable*,
but a mac cross-build is **not runnable on Windows for ad-hoc testing**:
`better-sqlite3` is a native module that is `require`d at startup
(`src/main/payment-history.js` → `src/main/index.js`), so an app packaged on macOS
ships the darwin `.node` and crashes on launch under Windows.

Build **natively inside the VM** when you need an app that actually launches on
Windows. The VM compiles/fetches the correct native-module ABI and bundles the
correct-arch Bee/IPFS binaries.

## Prerequisites

- UTM installed with a Windows VM. The CLI lives at
  `/Applications/UTM.app/Contents/MacOS/utmctl`.
- The VM's **QEMU guest agent** must be running (it ships with UTM's Windows
  guest tools). All automation below goes through it.
- Node.js + npm + git installed inside the guest. Verify with the probe in the
  cheat sheet below.

### Obtaining the Windows VM

A UTM Windows VM on Apple Silicon must be **Windows 11 on ARM (arm64)**. Get the
image from an official Microsoft source:

- Microsoft publishes the Arm64 disk image directly:
  <https://www.microsoft.com/en-us/software-download/windows11arm64> (multi-edition
  Arm64 ISO; use Firefox/Chrome — Microsoft's page is flaky in Safari).
- UTM's recommended route is **CrystalFetch** (free, Mac App Store), which builds
  the ISO by downloading the files straight from Microsoft's servers. See UTM's
  [Windows guide](https://docs.getutm.app/guides/windows/).

### Activation is a non-issue for build/testing

A fresh install from the multi-edition ISO comes up **unactivated** — `slmgr.vbs
/dli` reports `License Status: Notification` (reason `0xC004F034`) using the
generic edition-selector key (`…8HVX7` for Home). This is expected and **does not
block anything** we need: Windows runs indefinitely in this state (cosmetic
watermark + locked personalization only), and building/running/testing Freedom is
unaffected. Do not treat the watermark as a build problem, and don't apply a
product key unless the box is being kept as a long-lived environment with a valid
license.

## utmctl cheat sheet

```
UTMCTL=/Applications/UTM.app/Contents/MacOS/utmctl
"$UTMCTL" list                              # UUIDs, names, status
"$UTMCTL" start "<VM>"                       # boot (no-op if running)
"$UTMCTL" ip-address "<VM>"                  # guest IPs
"$UTMCTL" exec "<VM>" --cmd <prog> [args…]   # run an executable in the guest
"$UTMCTL" file push "<VM>" '<guest\path>'    # uploads stdin  -> guest file
"$UTMCTL" file pull "<VM>" '<guest\path>'    # guest file -> stdout
```

## Hard-won gotchas (read before automating)

These are the failure modes that waste the most time:

1. **`exec` runs an executable directly — not a shell.** `echo`, `dir`, `if`,
   `mkdir`, `where`, redirection, `&`, `%VAR%` are all `cmd.exe` builtins. Always
   wrap shell-ish commands:

   ```
   "$UTMCTL" exec "<VM>" --cmd 'C:\Windows\System32\cmd.exe' '/c' '<command line>'
   ```

2. **`exec` does not stream stdout, and for long commands it returns before the
   process finishes.** Redirect to a log file and poll it; optionally append an
   exit sentinel:

   ```
   ... '/c' 'npm ci > C:\freedom-build\npmci.log 2>&1 & echo EXIT=%ERRORLEVEL%>>C:\freedom-build\npmci.log'
   ```

   Then `file pull` the log on a timer. A log that is **locked** on pull
   (`cannot access the file because it is being used by another process`) means
   the command is still running — wait and retry. Use a plain `tasklist` dump to
   confirm whether `node.exe`/`git.exe` is still alive.

3. **The guest agent runs as `NT AUTHORITY\SYSTEM`.** `%USERPROFILE%` is
   `C:\WINDOWS\system32\config\systemprofile`, not the interactive user. To place
   files for the human tester, write to an explicit path like
   `C:\Users\<user>\Desktop` or `C:\Users\Public\Desktop`.

4. **Nested quoting through bash → utmctl → cmd is fragile.** Anything with
   spaces or inner quotes (e.g. `"Freedom Setup 0.7.4-dev.exe"`, `findstr /C:"…"`,
   `tasklist /FI "IMAGENAME eq node.exe"`) tends to get mangled — `eq` becomes an
   "invalid argument", quoted paths lose their quotes. **Fix:** write a `.bat`
   locally, `file push` it, and `exec` the `.bat`. Let the batch file own all the
   quoting. Avoid `tasklist` filters; dump everything and filter on the mac side.

5. **`file push`/`pull` go through the guest agent and are slow (~0.2 MB/s).**
   A 55 MB binary ≈ 4 min; 78 MB ≈ 5.5 min. Run pushes in the background and
   parallelize independent work (e.g. kick off `npm ci`, which does not need the
   bundled binaries, while the binaries upload).

## Architecture: it's Windows-on-ARM

A UTM Windows VM on Apple Silicon is **Windows on ARM (arm64)**. Two traps:

- `%PROCESSOR_ARCHITECTURE%` may report `AMD64` because the guest-agent/`cmd.exe`
  process is an emulated x64 process. **Do not trust it.** The authoritative
  signal is Node:

  ```
  "$UTMCTL" exec "<VM>" --cmd 'C:\Windows\System32\cmd.exe' '/c' 'node -p "process.platform+process.arch" > C:\freedom-build\arch.txt 2>&1'
  ```

  Expect `win32arm64` → build `--arm64`.
- `better-sqlite3` has a prebuilt **win-arm64 Electron** binary, so `npm ci`'s
  `electron-builder install-app-deps` finishes without needing Visual Studio
  Build Tools (`buildFromSource=false`). If you ever target an arch with no
  prebuild, you must install MSVC + Python in the guest first.

## End-to-end build

All commands run via the `cmd.exe /c '… > log 2>&1'` + poll pattern from above.

1. **Clone the branch under test into the guest** (the repo is public):

   ```
   git clone --branch <branch> --depth 1 https://github.com/solardev-xyz/freedom-browser.git C:\freedom-build\repo
   ```

   Confirm `git -C C:\freedom-build\repo log --oneline -1` is the commit you expect.

2. **Provide the Windows binaries.** `npm run check-binaries -- --win --arm64`
   requires `bee-bin/win-arm64/bee.exe` and
   `native/freedom-ipfs-node/prebuilds/win-arm64/freedom_ipfs_native.node`
   (Radicle is intentionally skipped on Windows — see `scripts/check-binaries.js`).
   The Bee fetch needs auth, so the reliable path is to **push the local
   binaries/addons** rather than download them in the guest:

   ```
   "$UTMCTL" exec "<VM>" --cmd 'C:\Windows\System32\cmd.exe' '/c' 'mkdir C:\freedom-build\repo\bee-bin\win-arm64 2>nul & mkdir C:\freedom-build\repo\native\freedom-ipfs-node\prebuilds\win-arm64 2>nul'
   "$UTMCTL" file push "<VM>" 'C:\freedom-build\repo\bee-bin\win-arm64\bee.exe' < bee-bin/win-arm64/bee.exe
   "$UTMCTL" file push "<VM>" 'C:\freedom-build\repo\native\freedom-ipfs-node\prebuilds\win-arm64\freedom_ipfs_native.node' < native/freedom-ipfs-node/prebuilds/win-arm64/freedom_ipfs_native.node
   ```

   Verify each pushed file's byte size matches the source (`dir` in guest vs.
   `stat -f %z` on mac) — a truncated push is a common silent failure.

3. **Install dependencies** (can run in parallel with step 2's uploads):

   ```
   cd /d C:\freedom-build\repo & npm ci
   ```

   Success looks like `• finished moduleName=better-sqlite3 arch=arm64` and
   `added N packages`.

4. **Build the distributable:**

   ```
   cd /d C:\freedom-build\repo & npm run dist -- --win --arm64
   ```

   `electron-builder` downloads the win32-arm64 Electron + NSIS toolchain on first
   run and emits, in `C:\freedom-build\repo\dist`:

   - `Freedom Setup <version>.exe` — one-click NSIS installer
   - `Freedom-<version>-arm64-win.zip` — portable build
   - `win-arm64-unpacked\Freedom.exe` — unpacked app

5. **Place the artifact for the tester.** Copy to the interactive user's Desktop
   via a pushed `.bat` (avoids the quoting traps with the space in the filename):

   ```bat
   @echo off
   copy /Y "C:\freedom-build\repo\dist\Freedom Setup <version>.exe" "C:\Users\<user>\Desktop\Freedom Setup <version>-arm64.exe"
   echo COPY_EXIT=%ERRORLEVEL%
   ```

## Testing notes

- The build is **unsigned**, so Windows SmartScreen/Defender shows
  "Windows protected your PC" → **More info → Run anyway**.
- It is an **arm64** build; the bundled Bee/IPFS are the arm64 binaries.
- For issue-#90-class checks: onboarding → create a new wallet → "Setting up node
  identities" should complete without the `EPERM … statestore` error.

## Cleanup / VM lifecycle

- Leave the VM in the state you found it. If you started it from `stopped`,
  offer to `"$UTMCTL" stop "<VM>"` when done.
- Remove scratch dirs you created (`C:\freedom-build`, any `C:\issue90`-style probes) once
  the tester has copied what they need — but never delete user files.
