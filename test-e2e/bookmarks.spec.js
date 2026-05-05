// Bookmarks bar — add via the IPC the address-bar star uses, and assert
// the bar reflects the new entry. Removal goes through the same IPC.

const { test, expect } = require('./fixtures');

// Force the bookmarks bar to be visible on every page. Without this the
// bar is only shown on the home page, which complicates assertions when
// the active tab navigates away.
test.use({ seedSettings: { showBookmarkBar: true } });

test('adding a bookmark via IPC shows it in the bookmarks bar', async ({ window }) => {
  const items = window.locator('[data-test="bookmarks-bar"] [data-test="bookmark-item"]');
  const initialCount = await items.count();

  await window.evaluate(() =>
    window.electronAPI.addBookmark({
      label: 'Test Bookmark',
      target: 'https://example.com/freedom-e2e',
    })
  );

  // The bookmarks bar reads from the IPC at init and after explicit
  // user actions; there's no "bookmarks changed" broadcast for external
  // mutations. Reloading the renderer forces a fresh load.
  await window.reload();
  await window.waitForSelector('[data-test="address-input"]');

  await expect(items).toHaveCount(initialCount + 1);
  await expect(
    window.locator(
      '[data-test="bookmarks-bar"] [data-test="bookmark-item"][data-hash="https://example.com/freedom-e2e"]'
    )
  ).toBeVisible();

  // Cleanup also goes through the IPC contract.
  await window.evaluate(() =>
    window.electronAPI.removeBookmark('https://example.com/freedom-e2e')
  );

  await window.reload();
  await window.waitForSelector('[data-test="address-input"]');
  await expect(
    window.locator(
      '[data-test="bookmarks-bar"] [data-test="bookmark-item"][data-hash="https://example.com/freedom-e2e"]'
    )
  ).toHaveCount(0);
});
