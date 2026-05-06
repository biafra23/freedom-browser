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

test('typing a bare HTTPS domain auto-prefixes the scheme and stays inside the harness', async ({
  window,
}) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('example.com');
  await input.press('Enter');

  await expect(input).toHaveValue('https://example.com');

  // Prove the navigation actually went through the harness stub
  // (`makeHttpStubHandler` in src/main/test-harness.js) rather than
  // out to the public internet. The stub embeds the request URL in a
  // <p data-test="harness-http-stub-url"> element, so the presence of
  // that text inside the active webview is unambiguous evidence the
  // request was intercepted at the protocol-handler layer and served
  // in-process. Without this assertion the spec would still pass even
  // if the harness regressed back to letting Chromium reach the
  // network.
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv || typeof wv.executeJavaScript !== 'function') return null;
          try {
            return await wv.executeJavaScript(
              'document.querySelector(\'[data-test="harness-http-stub-url"]\')?.textContent || null'
            );
          } catch {
            return null;
          }
        }),
      { message: 'Waiting for harness http(s) stub to be served', timeout: 5_000 }
    )
    .toBe('https://example.com/');
});
