const crypto = require('crypto');

/**
 * Generate a random hex id for in-process tracking (chat streams, session
 * rows, message rows, future tool-call ids). Default 8 bytes → 16 hex chars,
 * which is short enough to log readably and long enough that collisions
 * within a process lifetime are not a concern.
 */
function newId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { newId };
