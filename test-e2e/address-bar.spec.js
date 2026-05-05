// Address-bar input → URL normalisation pipeline.
//
// We assert at the chrome layer (input value, protocol icon) rather than
// inside the webview, since webview rendering is content-handler-specific
// and the harness already gives us deterministic content.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

test('typing a 64-char hex hash normalises to bzz:// in the address bar', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, {
    body: '<!doctype html><title>fixture</title><h1>fixture</h1>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(SAMPLE_BZZ_HASH);
  await input.press('Enter');

  // The renderer rewrites the input value to the canonical bzz:// form
  // synchronously inside loadTarget; no need to wait for the webview.
  await expect(input).toHaveValue(`bzz://${SAMPLE_BZZ_HASH}`);
});

test('typing a bzz:// URL with a path preserves the path in the address bar', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, {
    body: '<!doctype html><title>fixture</title>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`bzz://${SAMPLE_BZZ_HASH}/about`);
  await input.press('Enter');

  await expect(input).toHaveValue(`bzz://${SAMPLE_BZZ_HASH}/about`);
});

test('typing a bare HTTPS domain auto-prefixes the scheme', async ({ window }) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('example.com');
  await input.press('Enter');

  await expect(input).toHaveValue('https://example.com');
});
