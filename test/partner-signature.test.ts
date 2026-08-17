import assert from 'node:assert/strict';
import { test } from 'node:test';

import { timingSafeEqualStrings } from '../src/shared/auth/partner-signature.js';

test('timingSafeEqualStrings matches identical strings', () => {
  assert.equal(timingSafeEqualStrings('abc123', 'abc123'), true);
});

test('timingSafeEqualStrings rejects differing strings of the same length', () => {
  assert.equal(timingSafeEqualStrings('abc123', 'abc124'), false);
});

test('timingSafeEqualStrings rejects strings of different lengths without throwing', () => {
  assert.equal(timingSafeEqualStrings('short', 'a-much-longer-value'), false);
});

test('timingSafeEqualStrings treats the empty string safely', () => {
  assert.equal(timingSafeEqualStrings('', ''), true);
  assert.equal(timingSafeEqualStrings('', 'nonempty'), false);
});
