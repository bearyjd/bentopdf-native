'use strict';

/**
 * Live-view memory cap. A tab's view (a whole renderer: one LibreOffice run
 * alone is ~1.7 GiB RSS, docs/m2-findings.md) is "live" until discarded; a
 * discarded tab keeps its tool and document id and is reloaded on activation.
 */
const DEFAULT_MAX_LIVE = 3;

/**
 * Which live tabs to discard so that at most `maxLive` stay alive. The active
 * tab is never discarded; the least recently active background tabs go first.
 * Pure: takes `[{id, live, lastActive}]`, returns ids, mutates nothing.
 */
function tabsToDiscard(tabs, { activeId, maxLive = DEFAULT_MAX_LIVE } = {}) {
  if (!Number.isInteger(maxLive) || maxLive < 1) throw new RangeError('maxLive must be an integer >= 1');
  const live = tabs.filter((t) => t.live);
  const excess = live.length - maxLive;
  if (excess <= 0) return [];
  return live
    .filter((t) => t.id !== activeId)
    .sort((a, b) => a.lastActive - b.lastActive || a.id - b.id)
    .slice(0, excess)
    .map((t) => t.id);
}

module.exports = { tabsToDiscard, DEFAULT_MAX_LIVE };
