// Tab strip — open via the new-tab button, close via the per-tab close
// affordance, count tabs from the renderer DOM directly.

const { test, expect } = require('./fixtures');

test('starts with one tab, can open more, can close them', async ({ window }) => {
  const tabs = window.locator('[data-test="tab"]');
  await expect(tabs).toHaveCount(1);

  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(tabs).toHaveCount(2);

  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(tabs).toHaveCount(3);

  // Close the first tab via its close button. Its data-tab-id is "1"
  // because tabs.js counts from one and never recycles ids.
  await window.locator('[data-test="tab"][data-tab-id="1"] [data-test="tab-close"]').click();
  await expect(tabs).toHaveCount(2);
});

test('clicking a tab activates it', async ({ window }) => {
  const tabs = window.locator('[data-test="tab"]');
  await expect(tabs).toHaveCount(1);

  // Open a second tab; new tabs become active automatically.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(tabs).toHaveCount(2);
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/active/);

  // Switch back to the first tab.
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="1"]')).toHaveClass(/active/);
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).not.toHaveClass(/active/);
});
