import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { solveHandshakePow } from './pure-api-client.mjs';

const clientPub = 'test-client-public-key';
const timestamp = 1786932000000;
const nonce = solveHandshakePow(clientPub, timestamp);
const digest = createHash('sha256')
  .update(`${clientPub}:${timestamp}:${nonce}`)
  .digest();

assert.equal(digest[0], 0);
assert.equal(digest[1], 0);
console.log('handshake proof-of-work test passed');
