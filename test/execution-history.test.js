'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeObserved, observedCount } = require('../src/executionHistory');

test('execution history keeps changed files after Git becomes clean', () => {
  const item = { root: 'file:///repo', key: 'src/a.js', uri: 'file:///repo/src/a.js', status: '7', digest: 'abc', kind: 'new', warning: undefined };
  const first = mergeObserved({}, [item], '2026-10-30T10:00:00Z');
  assert.equal(observedCount({ observed: first }), 1);
  assert.equal(first['file:///repo\nsrc/a.js'].present, true);
  const clean = mergeObserved(first, [], '2026-10-30T10:01:00Z');
  assert.equal(clean['file:///repo\nsrc/a.js'].present, false);
  assert.equal(clean['file:///repo\nsrc/a.js'].firstSeenAt, '2026-10-30T10:00:00Z');
});

test('unchanged files from before execution are not recorded as results', () => {
  const item = { root: 'file:///repo', key: 'src/a.js', kind: 'existing' };
  assert.deepEqual(mergeObserved({}, [item], 'now'), {});
});

test('a temporarily unavailable repository does not erase observed state', () => {
  const item = { root: 'file:///repo', key: 'a.js', kind: 'new', digest: 'a', status: '7' };
  const first = mergeObserved({}, [item], 'start');
  const next = mergeObserved(first, [], 'later', []);
  assert.equal(next['file:///repo\na.js'].present, true);
});
