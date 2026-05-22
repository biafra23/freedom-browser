// Address-bar clipboard on Windows/Linux (issue #69).
//
// Playwright keyboard events can satisfy native <input> editing without the
// application Edit menu, so these specs assert menu wiring and the chrome
// right-click menu that users rely on when accelerators are missing.

const { test, expect } = require('./fixtures');

const isDarwin = process.platform === 'darwin';
const modifier = process.env.E2E_CLIPBOARD_MODIFIER || (isDarwin ? 'Meta' : 'Control');

async function getEditAccelerators(electronApp) {
  return electronApp.evaluate(() => {
    const { Menu } = require('electron');
    const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Edit');
    if (!edit?.submenu) return {};
    const pick = (role) => edit.submenu.items.find((item) => item.role === role)?.accelerator ?? null;
    return {
      cut: pick('cut'),
      copy: pick('copy'),
      paste: pick('paste'),
      selectAll: pick('selectAll'),
    };
  });
}

async function getTopMenuLabels(electronApp) {
  return electronApp.evaluate(() => {
    const { Menu } = require('electron');
    return Menu.getApplicationMenu()?.items.map((item) => item.role || item.label) ?? [];
  });
}

test.describe('address bar clipboard', () => {
  test.skip(isDarwin, 'issue #69 is Windows/Linux only');

  test('application menu excludes macOS-only roles', async ({ electronApp }) => {
    const top = await getTopMenuLabels(electronApp);
    expect(top).not.toContain('appMenu');
    expect(top[0]).toBe('File');
    expect(top).toContain('Edit');
  });

  test('Edit menu registers Ctrl+C/V/X/A accelerators', async ({ electronApp }) => {
    const accelerators = await getEditAccelerators(electronApp);
    expect(accelerators.copy).toBe('Ctrl+C');
    expect(accelerators.cut).toBe('Ctrl+X');
    expect(accelerators.paste).toBe('Ctrl+V');
    expect(accelerators.selectAll).toBe('Ctrl+A');
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

  test('context menu Paste inserts clipboard text', async ({ window, electronApp }) => {
    const input = window.locator('[data-test="address-input"]');
    const menu = window.locator('[data-test="chrome-input-context-menu"]');
    const sample = 'paste-via-menu-69';

    await electronApp.evaluate(async ({ clipboard }, text) => clipboard.writeText(text), sample);
    await input.click();
    await input.fill('');
    await input.click({ button: 'right' });
    await menu.getByRole('button', { name: 'Paste' }).click();

    await expect(input).toHaveValue(sample);
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
