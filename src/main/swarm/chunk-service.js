/**
 * Chunk Service
 *
 * Low-level Swarm CAC/SOC primitives for the page-facing window.swarm API.
 * Runs in the main process only; provider-ipc owns permission checks.
 */

const { PrivateKey, BeeResponseError, Identifier, EthAddress } = require('@ethersphere/bee-js');
const { getBee, selectBestBatch, toHex } = require('./swarm-service');

function spanToResult(span) {
  const value = span.toBigInt();
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function makeSemanticError(reason, message, cause) {
  const err = new Error(message);
  err.reason = reason;
  if (cause) err.cause = cause;
  return err;
}

function isChunkNotFoundError(err) {
  return err instanceof BeeResponseError && err.status === 404;
}

function ensureSameReference(actual, expected, type) {
  const normalizedActual = actual.replace(/^0x/, '').toLowerCase();
  const normalizedExpected = expected.replace(/^0x/, '').toLowerCase();
  if (normalizedActual !== normalizedExpected) {
    throw makeSemanticError(
      'chunk_type_mismatch',
      `Downloaded bytes do not validate as the requested ${type} chunk`
    );
  }
}

async function selectChunkBatch() {
  const batchId = await selectBestBatch(4096);
  if (!batchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }
  return batchId;
}

function getSignerAddress(signerPrivateKey) {
  const signer = new PrivateKey(signerPrivateKey);
  return signer.publicKey().address().toChecksum();
}

async function publishChunk(data, options = {}) {
  const bee = getBee();
  const chunk = bee.makeContentAddressedChunk(data, options.span);
  const batchId = await selectChunkBatch();

  await bee.uploadChunk(batchId, chunk, { pin: true, deferred: false });

  return {
    reference: toHex(chunk.address),
    batchIdUsed: batchId,
  };
}

async function readChunk(reference) {
  const bee = getBee();

  try {
    const raw = await bee.downloadChunk(reference);
    const chunk = bee.unmarshalContentAddressedChunk(raw);
    ensureSameReference(toHex(chunk.address), reference, 'content-addressed');

    return {
      data: Buffer.from(chunk.payload.toUint8Array()).toString('base64'),
      encoding: 'base64',
      span: spanToResult(chunk.span),
    };
  } catch (err) {
    if (isChunkNotFoundError(err)) {
      throw makeSemanticError('chunk_not_found', `Chunk not found: ${reference}`, err);
    }
    if (err.reason === 'chunk_type_mismatch') throw err;
    if (err.message && err.message.includes('payload size')) {
      throw makeSemanticError(
        'chunk_type_mismatch',
        `Downloaded bytes do not validate as the requested content-addressed chunk`,
        err
      );
    }
    throw err;
  }
}

async function writeSingleOwnerChunk(signerPrivateKey, identifier, data, options = {}) {
  const bee = getBee();
  const signer = new PrivateKey(signerPrivateKey);
  const chunk = bee.makeContentAddressedChunk(data, options.span);
  const soc = chunk.toSingleOwnerChunk(identifier, signer);
  const batchId = await selectChunkBatch();

  await bee.uploadChunk(batchId, soc, { pin: true, deferred: false });

  return {
    reference: toHex(soc.address),
    owner: soc.owner.toChecksum(),
    identifier: soc.identifier.toHex(),
    batchIdUsed: batchId,
  };
}

async function readSingleOwnerChunk(params) {
  const bee = getBee();
  const { address, owner, identifier } = params;
  const reference = address || toHex(
    bee.calculateSingleOwnerChunkAddress(new Identifier(identifier), new EthAddress(owner))
  );

  try {
    const raw = await bee.downloadChunk(reference);
    let soc;
    try {
      soc = bee.unmarshalSingleOwnerChunk(raw, reference);
    } catch (err) {
      throw makeSemanticError(
        'chunk_type_mismatch',
        'Downloaded bytes do not validate as the requested Single Owner Chunk',
        err
      );
    }

    return {
      data: Buffer.from(soc.payload.toUint8Array()).toString('base64'),
      encoding: 'base64',
      span: spanToResult(soc.span),
      reference: toHex(soc.address),
      owner: soc.owner.toChecksum(),
      identifier: soc.identifier.toHex(),
      signature: soc.signature.toHex(),
    };
  } catch (err) {
    if (isChunkNotFoundError(err)) {
      throw makeSemanticError('chunk_not_found', 'Single Owner Chunk not found', err);
    }
    if (
      err.reason === 'chunk_type_mismatch' ||
      (err.message && err.message.includes('SOC data does not match'))
    ) {
      throw makeSemanticError(
        'chunk_type_mismatch',
        'Downloaded bytes do not validate as the requested Single Owner Chunk',
        err
      );
    }
    throw err;
  }
}

module.exports = {
  publishChunk,
  readChunk,
  writeSingleOwnerChunk,
  readSingleOwnerChunk,
  getSignerAddress,
  spanToResult,
  isChunkNotFoundError,
};
