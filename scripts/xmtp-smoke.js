/**
 * XMTP smoke test (module-driven).
 *
 * Stands up two XMTP clients on the dev network and verifies a full
 * publish→subscribe round-trip through src/main/messaging:
 *   - Alice runs through the production modules (xmtp-client + channel).
 *   - Bob is a "raw" SDK client standing in for another Freedom installation
 *     somewhere else in the world.
 * Alice creates a Channel with Bob, both sides exchange envelopes, and the
 * smoke confirms each side receives what the other published.
 *
 * Run:  node scripts/xmtp-smoke.js
 *
 * Notes:
 *  - Uses the `dev` XMTP environment.
 *  - On macOS, the @xmtp/node-bindings@6.0.0 prebuild needs a one-time
 *    libiconv repath after each `npm install`:
 *      install_name_tool -change \
 *        "/nix/store/<hash>-libiconv-109.100.2/lib/libiconv.2.dylib" \
 *        "/usr/lib/libiconv.2.dylib" \
 *        node_modules/@xmtp/node-bindings/dist/bindings_node.darwin-arm64.node
 *      codesign --force --sign - <same path>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const xmtpClient = require('../src/main/messaging/xmtp-client');
const channelMod = require('../src/main/messaging/channel');

const ETHEREUM_IDENTIFIER_KIND = 0;
const BANNER = '='.repeat(60);

function makeRawSigner(wallet) {
  return {
    type: 'EOA',
    getIdentifier: () => ({
      identifier: wallet.address.toLowerCase(),
      identifierKind: ETHEREUM_IDENTIFIER_KIND,
    }),
    signMessage: async (message) => {
      const sigHex = await wallet.signMessage(message);
      return Uint8Array.from(Buffer.from(sigHex.slice(2), 'hex'));
    },
  };
}

async function pollFor(label, fn, { tries = 30, delayMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function main() {
  const { Client } = await import('@xmtp/node-sdk');
  const { Wallet } = await import('ethers');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xmtp-smoke-'));
  console.log(`Scratch dir: ${tmpRoot}`);

  let cleanupOk = false;
  try {
    const aliceWallet = Wallet.createRandom();
    const bobWallet = Wallet.createRandom();
    console.log(`Alice address: ${aliceWallet.address}`);
    console.log(`Bob   address: ${bobWallet.address}`);

    // ---------------------------------------------------------------------
    // Alice — driven through the production modules
    // ---------------------------------------------------------------------
    console.log(`\n${BANNER}\nAlice → start xmtp-client (dev)…`);
    const tA = Date.now();
    const aliceInfo = await xmtpClient.start({
      privateKey: aliceWallet.privateKey,
      address: aliceWallet.address,
      dataDir: path.join(tmpRoot, 'alice'),
      env: 'dev',
    });
    console.log(`  ready in ${Date.now() - tA}ms`);
    console.log(`  inboxId        ${aliceInfo.inboxId}`);
    console.log(`  installationId ${aliceInfo.installationId}`);
    console.log(`  dbPath         ${aliceInfo.dbPath}`);

    // ---------------------------------------------------------------------
    // Bob — raw SDK client, simulates "another Freedom installation"
    // ---------------------------------------------------------------------
    console.log(`\nBob → create raw SDK client (dev)…`);
    const tB = Date.now();
    const bob = await Client.create(makeRawSigner(bobWallet), {
      env: 'dev',
      dbPath: path.join(tmpRoot, 'bob.db3'),
      dbEncryptionKey: crypto.randomBytes(32),
    });
    console.log(`  ready in ${Date.now() - tB}ms`);
    console.log(`  inboxId        ${bob.inboxId}`);
    console.log(`  installationId ${bob.installationId}`);

    // ---------------------------------------------------------------------
    // Alice creates a Channel with Bob via the channel module
    // ---------------------------------------------------------------------
    console.log(`\n${BANNER}\nAlice → createChannel(memberInboxIds=[bob])…`);
    const aliceClient = xmtpClient.getClient();
    const aliceChannel = await channelMod.createChannel(aliceClient, {
      memberInboxIds: [bob.inboxId],
      name: 'freedom-smoke-channel',
    });
    console.log(`  channel.id: ${aliceChannel.id}`);
    const aliceMembers = await aliceChannel.members();
    console.log(`  channel.members: ${aliceMembers.length} (${aliceMembers.join(', ')})`);

    // ---------------------------------------------------------------------
    // Set up Bob's listener BEFORE Alice publishes (avoids race)
    // ---------------------------------------------------------------------
    console.log(`\nBob → sync conversations and locate the new channel…`);
    const bobChannel = await pollFor(
      'Bob to discover the channel',
      async () => {
        await bob.conversations.sync();
        const convo = await bob.conversations.getConversationById(aliceChannel.id);
        if (convo && typeof convo.addMembers === 'function') return convo;
        return null;
      }
    );
    console.log(`  Bob sees channel: ${bobChannel.id}`);

    // ---------------------------------------------------------------------
    // Round-trip 1: Alice → Bob via channel.publish
    // ---------------------------------------------------------------------
    const taskFromAlice = {
      v: 1,
      kind: 'task',
      taskId: `T-${Date.now()}`,
      payload: { prompt: 'hello bob, summarize this' },
    };
    console.log(`\n${BANNER}\nAlice → channel.publish(${JSON.stringify(taskFromAlice)})…`);
    const tPub = Date.now();
    const aliceMsgId = await aliceChannel.publish(taskFromAlice);
    console.log(`  msgId=${aliceMsgId} in ${Date.now() - tPub}ms`);

    console.log(`\nBob → poll for Alice's message…`);
    const tPoll = Date.now();
    const bobReceived = await pollFor('Bob to receive Alice\'s task', async () => {
      await bobChannel.sync();
      const msgs = await bobChannel.messages();
      for (const m of msgs) {
        if (typeof m.content !== 'string') continue;
        try {
          const parsed = JSON.parse(m.content);
          if (parsed.taskId === taskFromAlice.taskId) return { msg: m, parsed };
        } catch { /* skip non-JSON system messages */ }
      }
      return null;
    });
    console.log(`  received in ${Date.now() - tPoll}ms`);
    console.log(`  parsed: ${JSON.stringify(bobReceived.parsed)}`);
    if (bobReceived.parsed.taskId !== taskFromAlice.taskId) {
      throw new Error('payload mismatch alice→bob');
    }

    // ---------------------------------------------------------------------
    // Round-trip 2: Bob → Alice via channel.subscribe
    // ---------------------------------------------------------------------
    const resultFromBob = {
      v: 1,
      kind: 'result',
      taskId: taskFromAlice.taskId,
      cid: 'bafy-fake-cid',
      ok: true,
    };

    console.log(`\n${BANNER}\nAlice → channel.subscribe()…`);
    const aliceInbox = [];
    const unsubscribe = await aliceChannel.subscribe(async (msg) => {
      aliceInbox.push(msg);
    });

    console.log(`Bob   → sendText(${JSON.stringify(resultFromBob)})…`);
    const tSend = Date.now();
    await bobChannel.sendText(JSON.stringify(resultFromBob));
    console.log(`  sent in ${Date.now() - tSend}ms`);

    console.log(`Alice → wait for handler call…`);
    const tWait = Date.now();
    const received = await pollFor(
      'Alice to receive Bob\'s result',
      async () => aliceInbox.find((m) => m.parsed?.taskId === resultFromBob.taskId),
      { tries: 30, delayMs: 500 }
    );
    console.log(`  handler fired in ${Date.now() - tWait}ms`);
    console.log(`  from:    ${received.from}`);
    console.log(`  parsed:  ${JSON.stringify(received.parsed)}`);
    console.log(`  sentAt:  ${received.sentAt.toISOString()}`);

    if (received.from !== bob.inboxId) {
      throw new Error(`from mismatch: got ${received.from}, expected ${bob.inboxId}`);
    }
    if (received.parsed.cid !== resultFromBob.cid) {
      throw new Error('payload mismatch bob→alice');
    }

    // Confirm own-message filtering: Alice's earlier publish should not
    // have appeared in her own subscribe callback. Match on (taskId, kind)
    // so Bob's result — which shares the taskId — doesn't trigger a false
    // positive.
    const ownEcho = aliceInbox.find(
      (m) => m.parsed?.taskId === taskFromAlice.taskId && m.parsed?.kind === 'task'
    );
    if (ownEcho) {
      throw new Error('subscribe leaked own message — includeOwn filter broken');
    }
    console.log(`  (own message correctly excluded from subscribe handler)`);

    await unsubscribe();
    xmtpClient.stop();

    console.log(`\n${BANNER}\nSUCCESS — both round-trips worked through the modules.`);
    cleanupOk = true;
  } finally {
    if (cleanupOk) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      console.log(`Cleaned up ${tmpRoot}`);
    } else {
      console.log(`Leaving ${tmpRoot} in place for inspection.`);
    }
  }
}

main().catch((err) => {
  console.error('\nXMTP smoke FAILED:', err);
  process.exit(1);
});
