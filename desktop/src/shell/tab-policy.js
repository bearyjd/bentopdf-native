'use strict';

const { LIVE_VIEW_BUDGET, weightOfTool } = require('./live-budget');

/**
 * Live-view limit. A tab's view (a whole renderer) is "live" until discarded;
 * a discarded tab keeps its tool and document id and is reloaded on
 * activation. The limit is a weighted slot budget (live-budget.js), not a
 * measurement of memory.
 *
 * Which live tabs to discard so that the live weights sum to at most `budget`.
 * The active tab is never discarded (it may alone exceed the budget); the
 * least recently active background tabs go first. Pure: takes
 * `[{id, live, lastActive, toolId?}]`, returns ids, mutates nothing.
 */
function tabsToDiscard(tabs, { activeId, budget = LIVE_VIEW_BUDGET, weightOf = (t) => weightOfTool(t.toolId) } = {}) {
  if (!Number.isInteger(budget) || budget < 1) throw new RangeError('budget must be an integer >= 1');
  const live = tabs.filter((t) => t.live);
  let total = live.reduce((sum, t) => sum + weightOf(t), 0);
  const discard = [];
  const candidates = live.filter((t) => t.id !== activeId).sort((a, b) => a.lastActive - b.lastActive || a.id - b.id);
  for (const tab of candidates) {
    if (total <= budget) break;
    discard.push(tab.id);
    total -= weightOf(tab);
  }
  return discard;
}

module.exports = { tabsToDiscard, LIVE_VIEW_BUDGET };
