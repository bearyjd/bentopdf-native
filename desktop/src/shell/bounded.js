'use strict';

/**
 * Bounds for main-process accumulators that renderer behaviour can grow
 * (blocked requests, permission decisions, handoff records, allowed URLs).
 */
const DEFAULT_CAP = 200;

/** Append to `list`, dropping the oldest entries beyond `max`. Returns `list`. */
function pushCapped(list, item, max = DEFAULT_CAP) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
  return list;
}

/** Add to `set`, dropping the oldest members beyond `max` (insertion order). Returns `set`. */
function addCapped(set, value, max = DEFAULT_CAP) {
  set.delete(value); // re-adding refreshes the position
  set.add(value);
  while (set.size > max) set.delete(set.values().next().value);
  return set;
}

/**
 * Per-key rate limit for log lines: at most `limit` per `windowMs`; the first
 * line past it in a window is replaced by one "suppressed" notice. `now` is
 * injectable. Returns `(key) => 'log' | 'notice' | 'drop'`.
 */
function createLogLimiter({ limit = 20, windowMs = 60000, now = Date.now, maxKeys = DEFAULT_CAP } = {}) {
  const windows = new Map(); // key -> {start, count}
  return (key) => {
    const t = now();
    const current = windows.get(key);
    if (!current || t - current.start >= windowMs) {
      windows.delete(key);
      windows.set(key, { start: t, count: 1 });
      while (windows.size > maxKeys) windows.delete(windows.keys().next().value);
      return 'log';
    }
    current.count += 1;
    if (current.count <= limit) return 'log';
    return current.count === limit + 1 ? 'notice' : 'drop';
  };
}

/**
 * Run `task(key)` calls one after another per key; different keys run
 * concurrently. A rejection reaches its own caller only.
 */
function serialByKey(task) {
  const tails = new Map();
  return (key) => {
    const run = (tails.get(key) || Promise.resolve()).then(() => task(key));
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

module.exports = { pushCapped, addCapped, createLogLimiter, serialByKey, DEFAULT_CAP };
