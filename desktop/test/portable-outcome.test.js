'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classifyPortableSecondInstance: c, EXIT_FAIL, EXIT_KNOWN_ISSUE_11 } = require('./portable-outcome');

test('only the #11 signature (healthy first instance + hung or silent second) is the known code 3', () => {
  assert.equal(c({ firstAlive: true, secondExit: 'timeout' }).code, EXIT_KNOWN_ISSUE_11);
  assert.equal(c({ firstAlive: true, secondExit: 0 }).code, EXIT_KNOWN_ISSUE_11);
  assert.equal(c({ firstAlive: true, secondExit: 0 }).known, true);
});

test('every other outcome is a real failure (1), never 3', () => {
  for (const input of [
    { firstAlive: false, secondExit: 'timeout' },
    { firstAlive: false, secondExit: 0 },
    { firstAlive: undefined, secondExit: 0 },
    { firstAlive: true, secondExit: 1 },
    { firstAlive: true, secondExit: 2 },
    { firstAlive: true, secondExit: 4294967295 },
    { firstAlive: true, secondExit: 'not launched' },
    { firstAlive: true, secondExit: undefined },
    {},
  ]) {
    const r = c(input);
    assert.equal(r.code, EXIT_FAIL, JSON.stringify(input));
    assert.equal(r.known, false);
  }
});

test('the policy never reports success: nothing in the portable exe can prove forwarding', () => {
  for (const secondExit of [0, 1, 'timeout']) assert.notEqual(c({ firstAlive: true, secondExit }).code, 0);
});
