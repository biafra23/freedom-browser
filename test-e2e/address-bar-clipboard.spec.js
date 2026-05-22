// Address-bar clipboard (issue #69).
//
// Win/Linux: application Edit menu must expose clipboard roles when the menu
// bar is hidden. All platforms: chrome right-click menu must edit the address
// bar (execCommand loses selection when the menu steals focus).

const { test, expect } = require('./fixtures');

const isDarwin = process.platform === 'darwin';
const modifier = process.env.E2E_CLIPBOARD_MODIFIER || (isDarwin ? 'Meta' : 'Control');

async function readApplicationMenu(electronApp) {
  let menu;
  await expect
    .poll(async () => {
      menu = await electronApp.evaluate(inspectApplicationMenu());
      return menu.ready;
    })
    .toBe(true);
  return menu;
}

function inspectApplicationMenu() {
  return ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) {
      return { ready: false };
    }

    const top = menu.items.map((item) => item.role || item.label);
    const editSubmenu =
      menu.items.find((item) => item.label === 'Edit')?.submenu ??
      menu.items.find((item) => item.submenu?.items?.some((entry) => entry.role === 'copy'))
        ?.submenu;
    const roles = editSubmenu?.items.map((item) => item.role).filter(Boolean) ?? [];

    return {
      ready: true,
      top,
      hasAppMenu: top.includes('appMenu'),
      hasWindowMenu: top.includes('windowMenu'),
      hasFileMenu: top.some((entry) => /file/i.test(String(entry))),
      hasEditMenu: Boolean(editSubmenu),
      roles,
    };
  };
}

test.describe('address bar application menu (Windows/Linux)', () => {
  test.skip(isDarwin, 'macOS uses native app/window/edit menu roles');

  test('application menu excludes macOS-only roles', async ({ electronApp, window }) => {
    await expect(window.locator('[data-test="address-input"]')).toBeVisible();
    const menu = await readApplicationMenu(electronApp);
    expect(menu.hasAppMenu).toBe(false);
    expect(menu.hasWindowMenu).toBe(false);
    expect(menu.hasFileMenu).toBe(true);
    expect(menu.hasEditMenu).toBe(true);
  });

  test('Edit menu exposes clipboard roles', async ({ electronApp, window }) => {
    await expect(window.locator('[data-test="address-input"]')).toBeVisible();
    const menu = await readApplicationMenu(electronApp);
    const roles = menu.roles.map((role) => role.toLowerCase());
    expect(roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectall']));
  });
});

test.describe('address bar chrome context menu', () => {
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

  test('context menu Cut clears selection and copies to clipboard', async ({ window, electronApp }) => {
    const input = window.locator('[data-test="address-input"]');
    const menu = window.locator('[data-test="chrome-input-context-menu"]');
    const sample = 'cut-via-menu-69';

    await input.click();
    await input.fill(sample);
    await input.press(`${modifier}+a`);
    await input.click({ button: 'right' });
    await menu.getByRole('button', { name: 'Cut' }).click();

    await expect(input).toHaveValue('');
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(sample);
  });

  test('context menu Paste inserts clipboard text', async ({ window, electronApp }) => {
    const input = window.locator('[data-test="address-input"]');
    const menu = window.locator('[data-test="chrome-input-context-menu"]');
    const sample = 'paste-via-menu-69';

    await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), sample);
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(sample);

    await input.click();
    await input.fill('');
    await input.click({ button: 'right' });
    await menu.getByRole('button', { name: 'Paste' }).click();

    await expect.poll(async () => input.inputValue(), { timeout: 15_000 }).toBe(sample);
  });

  test('context menu Select All selects the full address', async ({ window }) => {
    const input = window.locator('[data-test="address-input"]');
    const menu = window.locator('[data-test="chrome-input-context-menu"]');
    const sample = 'select-all-via-menu-69';

    await input.click();
    await input.fill(sample);
    await input.click({ button: 'right' });
    await menu.getByRole('button', { name: 'Select All' }).click();

    await expect
      .poll(
        async () =>
          input.evaluate((el) => ({
            start: el.selectionStart,
            end: el.selectionEnd,
            length: el.value.length,
          })),
        { timeout: 30_000 }
      )
      .toEqual({ start: 0, end: sample.length, length: sample.length });
  });

  test(`${modifier} shortcuts copy, cut, and paste in the address bar`, async ({ window, electronApp }) => {
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
