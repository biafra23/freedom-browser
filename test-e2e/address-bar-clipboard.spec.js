// Address-bar clipboard on Windows/Linux (issue #69).
//
// Playwright keyboard events can satisfy native <input> editing without the
// application Edit menu, so these specs assert menu wiring and the chrome
// right-click menu that users rely on when accelerators are missing.

const { test, expect } = require('./fixtures');

const isDarwin = process.platform === 'darwin';
const modifier = process.env.E2E_CLIPBOARD_MODIFIER || (isDarwin ? 'Meta' : 'Control');

async function getTopMenuLabels(electronApp) {
  return electronApp.evaluate(({ Menu }) => {
    return Menu.getApplicationMenu()?.items.map((item) => item.role || item.label) ?? [];
  });
}

test.describe('address bar clipboard', () => {
  test.skip(isDarwin, 'issue #69 is Windows/Linux only');

  test('application menu excludes macOS-only roles', async ({ electronApp }) => {
    const top = await getTopMenuLabels(electronApp);
    expect(top).not.toContain('appMenu');
    expect(top).not.toContain('windowMenu');
    expect(top.some((entry) => /file/i.test(String(entry)))).toBe(true);
    expect(top).toContain('Edit');
  });

  test('Edit menu exposes clipboard roles', async ({ electronApp }) => {
    const roles = await electronApp.evaluate(({ Menu }) => {
      const topItems = Menu.getApplicationMenu()?.items ?? [];
      const editSubmenu =
        topItems.find((item) => item.label === 'Edit')?.submenu ??
        topItems.find((item) => item.submenu?.items?.some((entry) => entry.role === 'copy'))?.submenu;
      return editSubmenu?.items.map((item) => item.role).filter(Boolean) ?? [];
    });
    expect(roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll']));
  });

  test('right-click shows Cut/Copy/Paste/Select All on the address bar', async ({ window }) => {
    const input = window.locator('[data-test="address-input"]');
    const menu = window.locator('[data-test="chrome-input-context-menu"]');

    await input.click();
    await input.fill('context-menu-69');
    await input.click({ button: 'right' });

    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Cut' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Paste' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Select All' })).toBeVisible();
  });

  test('context menu Copy writes selection to the clipboard', async ({ window, electronApp }) => {
    const input = window.locator('[data-test="address-input"]');
    const menu = window.locator('[data-test="chrome-input-context-menu"]');
    const sample = 'copy-via-menu-69';

    await input.click();
    await input.fill(sample);
    await input.press(`${modifier}+a`);
    await input.click({ button: 'right' });
    await menu.getByRole('button', { name: 'Copy' }).click();

    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(sample);
  });

  test('Ctrl shortcuts copy, cut, and paste in the address bar', async ({ window, electronApp }) => {
    const input = window.locator('[data-test="address-input"]');
    const sample = 'freedom-clipboard-69';

    await input.click();
    await input.fill(sample);

    await input.press(`${modifier}+a`);
    await input.press(`${modifier}+c`);

    const copied = await electronApp.evaluate(async ({ clipboard }) => clipboard.readText());
    expect(copied).toBe(sample);

    await input.fill('');
    await expect(input).toHaveValue('');

    await input.press(`${modifier}+v`);
    await expect(input).toHaveValue(sample);

    await input.press(`${modifier}+a`);
    await input.press(`${modifier}+x`);
    await expect(input).toHaveValue('');

    const cut = await electronApp.evaluate(async ({ clipboard }) => clipboard.readText());
    expect(cut).toBe(sample);
  });
});
