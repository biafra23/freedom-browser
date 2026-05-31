describe('dapp-tx helpers', () => {
  test('decodes ERC-20 transfer calldata into ledger context', async () => {
    const { buildDappTxContext, decodeErc20Transfer } = await import('./dapp-tx.js');
    const recipient = '1111111111111111111111111111111111111111';
    const amount = 123456789n;
    const data = '0xa9059cbb' +
      recipient.padStart(64, '0') +
      amount.toString(16).padStart(64, '0');

    expect(decodeErc20Transfer(data)).toEqual({
      toAddress: `0x${recipient}`,
      amount: amount.toString(10),
    });
    expect(buildDappTxContext('https://app.example', {
      to: '0xTokenContract000000000000000000000000000000',
      data,
    })).toEqual({
      origin: 'https://app.example',
      asset: '0xtokencontract000000000000000000000000000000',
      toAddress: `0x${recipient}`,
      amount: amount.toString(10),
      metadata: { erc20Method: 'transfer' },
    });
  });

  test('leaves non-transfer calls as origin-only context', async () => {
    const { buildDappTxContext, decodeErc20Transfer } = await import('./dapp-tx.js');

    expect(decodeErc20Transfer('0x095ea7b3')).toBeNull();
    expect(buildDappTxContext('https://app.example', {
      to: '0xTokenContract000000000000000000000000000000',
      data: '0x095ea7b3',
    })).toEqual({ origin: 'https://app.example' });
  });
});
