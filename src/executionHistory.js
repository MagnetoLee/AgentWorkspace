'use strict';

function mergeObserved(previous, current, at, scannedRoots) {
  const next = { ...(previous || {}) };
  const seen = new Set();
  for (const item of current) {
    if (item.kind === 'existing') continue;
    const id = `${item.root}\n${item.key}`;
    seen.add(id);
    const prior = next[id];
    if (!prior || prior.digest !== item.digest || prior.status !== item.status || prior.kind !== item.kind || prior.warning !== item.warning || !prior.present) {
      next[id] = { ...item, firstSeenAt: prior?.firstSeenAt || at, lastSeenAt: at, present: true };
    }
  }
  for (const [id, item] of Object.entries(next)) {
    if (item.present && !seen.has(id) && (!scannedRoots || scannedRoots.includes(item.root))) next[id] = { ...item, present: false, lastSeenAt: at };
  }
  return next;
}

function observedCount(record) { return Object.keys(record?.observed || {}).length; }

module.exports = { mergeObserved, observedCount };
