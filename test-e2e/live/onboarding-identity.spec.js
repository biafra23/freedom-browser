// End-to-end regression for the issue #90 follow-up.
//
// Boots the real app (no test harness) so an actual Ant (antd) node starts,
// then drives the password onboarding wizard to completion. The wizard's
// force-reinjection stops the running node, wipes its stale state, reinjects
// the keystore, and restarts it. (The original Bee-era bug was an EPERM on
// Windows wiping the LevelDB statestore while the node held its LOCK; antd
// has no statestore, but this stop → wipe → reinject → restart flow is still
// the cross-platform proof that identity injection works against a live node.)
//
// On success the wizard reaches the success screen with no error dialog and
// identities are reported as injected on every platform.
//
// Requires the Ant and IPFS binaries (npm run ant:download / ipfs:download);
// skipped if either is absent.

const { test, expect, HAS_BINARIES } = require('../onboarding-fixtures');

const STRONG_PASSWORD = 'Freedom-E2E-Test-Passphrase-2026!';

test.describe('Onboarding wizard creates node identities (issue #90)', () => {
  test.skip(!HAS_BINARIES, 'Ant and/or IPFS binary missing — run npm run ant:download && npm run ipfs:download');

  test('completes the password setup with a running Ant node', async ({ window: win }) => {
    // Surface any wizard error dialog (alert) instead of letting Playwright
    // silently auto-dismiss it — these are how onboarding reports failures.
    const dialogMessages = [];
    win.on('dialog', (dialog) => {
      dialogMessages.push(dialog.message());
      dialog.dismiss().catch(() => {});
    });

    // 1) Wait for the real Ant node to come up — the wizard must inject the
    //    identity while a live node is running, which is what issue #90 broke.
    await expect
      .poll(async () => (await win.evaluate(() => window.ant.getStatus())).status, {
        timeout: 120_000,
        intervals: [1000],
      })
      .toBe('running');

    // 2) Open the onboarding wizard (same entry point as the sidebar button).
    await win.evaluate(() => document.getElementById('onboarding-modal').showModal());
    await win.locator('[data-step="welcome"]').waitFor({ state: 'visible' });

    // 3) Choose the password ("secure setup") path. Works whether the welcome
    //    screen shows the Touch-ID layout (link) or the standard layout (button).
    await win.locator('[data-step="welcome"] [data-action="create"]:visible').first().click();

    // 4) Enter a strong password; the confirm field only appears once the
    //    password is strong enough.
    await win.locator('[data-step="create-password"]').waitFor({ state: 'visible' });
    await win.fill('#create-password', STRONG_PASSWORD);
    await win.locator('#create-password-confirm').waitFor({ state: 'visible' });
    await win.fill('#create-password-confirm', STRONG_PASSWORD);
    const continueBtn = win.locator('[data-step="create-password"] [data-action="create-vault"]');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    // 5) On machines with Touch ID the wizard offers it next — skip it so the
    //    flow is identical to CI runners (which have no Touch ID). Check
    //    visibility (not DOM order): the touch-id step precedes backup in the
    //    markup, so a positional `.first()` would wrongly latch onto the hidden
    //    touch-id step on platforms that skip straight to backup.
    const touchIdStep = win.locator('[data-step="touch-id"]');
    const backupStep = win.locator('[data-step="backup"]');
    await expect
      .poll(async () => (await touchIdStep.isVisible()) || (await backupStep.isVisible()))
      .toBe(true);
    if (await touchIdStep.isVisible()) {
      await touchIdStep.locator('[data-action="skip-touch-id"]').click();
    }

    // 6) Acknowledge the recovery phrase and finish. This is what triggers
    //    saveVault + injectAll(force) → injectBeeIdentity, which stops the
    //    running Ant node, wipes its stale state, reinjects, and restarts it.
    await backupStep.waitFor({ state: 'visible' });
    await win.check('#backup-confirmed');
    const finishBtn = win.locator('[data-step="backup"] [data-action="continue-to-verify"]');
    await expect(finishBtn).toBeEnabled();
    await finishBtn.click();

    // 7) The success screen only appears if injection succeeded.
    await win.locator('[data-step="complete"]').waitFor({ state: 'visible', timeout: 120_000 });

    // No error dialog should have fired during setup.
    expect(dialogMessages.join('\n')).not.toMatch(/Failed to|still in use/i);

    // Identities are reported as injected for the started/relevant nodes.
    const status = await win.evaluate(() => window.identity.getStatus());
    expect(status.beeInjected).toBe(true);
    expect(status.ipfsInjected).toBe(true);

    // The Ant node was restarted and is healthy again with the injected identity.
    await expect
      .poll(async () => (await win.evaluate(() => window.ant.getStatus())).status, {
        timeout: 120_000,
        intervals: [1000],
      })
      .toBe('running');
  });
});
