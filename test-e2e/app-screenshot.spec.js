// Captures a screenshot of the running app on each platform.
//
// The `window` fixture only resolves once the browser chrome has mounted
// (address bar visible), so the screenshot reflects a fully-rendered app.
// The PNG is written under `playwright-screenshots/` for the CI job to
// upload as an artifact.

const path = require('path');
const { test } = require('./fixtures');

const repoRoot = path.resolve(__dirname, '..');

test('capture running app screenshot', async ({ window }) => {
  // Let layout and fonts settle so the capture isn't mid-paint.
  await window.waitForTimeout(500);

  const outPath = path.join(repoRoot, 'playwright-screenshots', `app-${process.platform}.png`);
  await window.screenshot({ path: outPath });
});
