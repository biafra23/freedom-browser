// Settings — verify that the saveSettings IPC + the renderer's
// settings:updated subscription combine to flip theme classes on the
// document. The on-disk settings page lives at freedom://settings and
// is rendered inside a webview; we drive the same IPC it would call,
// which exercises the same end-to-end pipeline without coupling the
// spec to the page's internal markup.

const { test, expect } = require('./fixtures');

test('switching theme to "light" sets data-theme on <html>', async ({ window }) => {
  // Default theme is "system"; on macOS dark-mode CI this would be dark
  // (no data-theme attribute). Drive an explicit transition to "light".
  await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'light' }));

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');

  await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'dark' }));

  // Dark mode removes the data-theme attribute (root selector applies
  // by default). We assert that toHaveAttribute fails — the attribute
  // is absent.
  await expect(window.locator('html')).not.toHaveAttribute('data-theme', 'light');
});

test('saveSettings persists across renderer reload', async ({ window }) => {
  await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'light' }));
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');

  await window.reload();
  await window.waitForSelector('[data-test="address-input"]');

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
});
