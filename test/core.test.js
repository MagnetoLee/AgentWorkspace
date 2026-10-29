'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { relativeInside, isWithinScope, classifyChange } = require('../src/core');

test('scope rejects siblings and symlink escapes', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-scope-'));
  try {
    const root = path.join(base, 'repo');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(base, 'other'));
    fs.symlinkSync(path.join(base, 'other'), path.join(root, 'link'));
    assert.equal(relativeInside(root, path.join(root, 'src', 'a.js')), path.join('src', 'a.js'));
    assert.equal(relativeInside(root, path.join(base, 'repo-other', 'a.js')), null);
    assert.equal(relativeInside(root, path.join(root, 'link', 'a.js')), null);
    assert.equal(isWithinScope({ mode: 'write', directories: ['src'] }, root, path.join(root, 'src', 'a.js')), true);
    assert.equal(isWithinScope({ mode: 'write', directories: ['src'] }, root, path.join(root, 'README.md')), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('baseline distinguishes existing, new and uncertain changes', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-baseline-'));
  try {
    const uri = { fsPath: path.join(base, 'a.js') };
    const scope = { mode: 'write', directories: [] };
    const baseline = { files: { 'a.js': { digest: 'old', status: 'modified' } } };
    assert.equal(classifyChange({ key: 'a.js', uri, digest: 'old', status: 'modified' }, baseline, scope, base, false).kind, 'existing');
    assert.equal(classifyChange({ key: 'a.js', uri, digest: 'new', status: 'modified' }, baseline, scope, base, false).kind, 'uncertain');
    assert.equal(classifyChange({ key: 'b.js', uri, digest: 'new', status: 'modified' }, baseline, scope, base, false).kind, 'new');
    assert.equal(classifyChange({ key: 'b.js', uri, digest: 'new', status: 'modified' }, baseline, { mode: 'read' }, base, false).warning.includes('超出'), true);
    assert.equal(classifyChange({ key: 'b.js', uri, digest: 'new', status: 'modified' }, baseline, scope, base, true).kind, 'invalid');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
