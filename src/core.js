'use strict';

const fs = require('node:fs');
const path = require('node:path');

function canonicalPath(input) {
  let current = path.resolve(input);
  const missing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  try { current = fs.realpathSync.native(current); } catch { /* URI may be virtual or removed */ }
  return path.join(current, ...missing);
}

function relativeInside(root, candidate) {
  const base = canonicalPath(root);
  const target = canonicalPath(candidate);
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) ? rel : null;
}

function isWithinScope(scope, root, candidate) {
  const rel = relativeInside(root, candidate);
  if (rel === null || scope.mode === 'none') return false;
  if (!scope.directories || scope.directories.length === 0) return true;
  return scope.directories.some(directory => {
    const target = path.resolve(root, directory);
    return relativeInside(root, target) !== null && relativeInside(target, candidate) !== null;
  });
}

function classifyChange(change, baseline, scope, root, headChanged) {
  if (headChanged) return { kind: 'invalid', warning: '分支或 HEAD 已变化，需重建基线' };
  const prior = baseline?.files?.[change.key];
  let kind = 'new';
  if (prior) kind = prior.digest === change.digest && prior.status === change.status ? 'existing' : 'uncertain';
  const inScope = isWithinScope(scope || { mode: 'none' }, root, change.uri.fsPath);
  return {
    kind,
    warning: !inScope || scope?.mode !== 'write' ? '超出声明的可改范围（仅提示，未阻止写入）' : undefined
  };
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

module.exports = { canonicalPath, relativeInside, isWithinScope, classifyChange, escapeMarkdown };
