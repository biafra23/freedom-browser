describe('dapp-x402 renderer helpers', () => {
  test('normalizes cap-consumed origins the same way as permission banner keys', async () => {
    const mod = await import('./dapp-x402-utils.js');

    expect(mod.normalizeX402BannerOrigin('bzz://Paywall.eth/article')).toBe('paywall.eth');
    expect(mod.normalizeX402BannerOrigin('ipfs://QmRootCid/path')).toBe('ipfs://QmRootCid');
    expect(mod.normalizeX402BannerOrigin('https://api.example/paid')).toBe('https://api.example');
  });

  test('shows the chooser when a pinned selected option becomes unfundable', async () => {
    const mod = await import('./dapp-x402-utils.js');

    expect(mod.shouldShowChooserForSelection(1, true)).toBe(false);
    expect(mod.shouldShowChooserForSelection(1, false)).toBe(true);
    expect(mod.shouldShowChooserForSelection(2, true)).toBe(true);
  });

  test('detects selected balance or fundability changes for full card rerender', async () => {
    const mod = await import('./dapp-x402-utils.js');
    const before = [
      { balance: '10000', fundable: true },
      { balance: '50000', fundable: true },
    ];

    expect(mod.selectedAcceptChanged(before, [
      { balance: '10000', fundable: true },
      { balance: '0', fundable: false },
    ], 0)).toBe(false);

    expect(mod.selectedAcceptChanged(before, [
      { balance: '0', fundable: false },
      { balance: '50000', fundable: true },
    ], 0)).toBe(true);
  });
});
