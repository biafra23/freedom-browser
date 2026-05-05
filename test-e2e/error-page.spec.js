// Error page — when the swarm probe returns `not_found`, the renderer
// routes the active webview to `pages/error.html` with the original
// URL preserved in the address bar. We assert both via the chrome and
// the webview's URL (the error page itself is loaded from the host
// pages/ directory so it's accessible to Playwright as a frame).

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

test('a probe-not-found bzz:// navigation lands on the error page', async ({
  window,
  harness,
}) => {
  // Force the Swarm probe stub to time out for this hash so navigation
  // routes to error.html instead of the (also-stubbed) bzz:// fixture.
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: false, reason: 'not_found' });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`bzz://${SAMPLE_BZZ_HASH}`);
  await input.press('Enter');

  // Address bar keeps the original URL so the user knows what failed.
  // The renderer's error path canonicalises to bzz://<hash>/ (trailing
  // slash); the success path strips it. Match either form.
  await expect(input).toHaveValue(new RegExp(`^bzz://${SAMPLE_BZZ_HASH}/?$`));

  // Active webview is the one whose container is visible. We poll its
  // src until it reports the error.html path; navigation is async.
  await expect
    .poll(
      async () => {
        return window.evaluate(() => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          return wv?.getURL?.() || wv?.getAttribute?.('src') || '';
        });
      },
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .toMatch(/pages\/error\.html\?error=swarm_content_not_found/);
});
