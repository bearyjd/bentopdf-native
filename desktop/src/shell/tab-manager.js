'use strict';

const { tabsToDiscard, LIVE_VIEW_BUDGET } = require('./tab-policy');

const DEFAULT_PAGE = '/index.html';

/** Partition name of a tab: in-memory (no `persist:`), never reused (ids only grow). */
const partitionFor = (id) => `bento-tab-${id}`;

/**
 * @typedef {{id: number, partition: string, page: string, toolId: string|null, docId: string|null,
 *            lastActive: number, live: boolean, epoch: number}} Tab
 * @typedef {{create(tab: Tab): object, load(view: object, page: string): Promise<void>,
 *            show(view: object): void, hide(view: object): void, destroy(view: object): void}} ViewAdapter
 */

/**
 * Tabs of the one shell window. Each tab owns one view (an Electron
 * WebContentsView in its own partition, created by the injected `views`
 * adapter, so this module stays testable without Electron). The live views
 * together weigh at most `liveBudget` slots (tab-policy.js); a discarded tab
 * keeps `page`/`toolId`/`docId` and gets a fresh view, a reload and `onLoaded`
 * (document handoff) when activated. `onLoaded` is started once the page has
 * loaded but NOT awaited: a slow handoff must not block activate/open/navigate
 * (its failures are its own to report; a rejection lands in `onError`).
 * `epoch` counts the tab's navigations (navigate(), and `noteNavigation` for every main-frame
 * navigation of its view); a handoff compares it with the value it started with and drops
 * itself when the page it was meant for is gone.
 * Tab records are frozen and replaced, never mutated.
 */
function createTabManager({ views, liveBudget = LIVE_VIEW_BUDGET, weights, onLoaded = async () => {}, onChange = () => {}, onError = () => {} }) {
  let tabs = new Map(); // id -> frozen Tab (insertion order = strip order)
  const live = new Map(); // id -> view
  let activeId = null;
  let nextId = 1;
  let clock = 0;

  const set = (tab) => {
    const frozen = Object.freeze({ ...tab, live: live.has(tab.id) });
    tabs = new Map(tabs).set(tab.id, frozen);
    return frozen;
  };

  async function loadInto(tab) {
    const view = live.get(tab.id);
    try {
      await views.load(view, tab.page);
    } catch (err) {
      onError(err, tab);
      return;
    }
    if (live.get(tab.id) !== view) return; // discarded, closed or replaced while loading
    const current = tabs.get(tab.id);
    try {
      Promise.resolve(onLoaded(current, view)).catch((err) => onError(err, current));
    } catch (err) {
      onError(err, current);
    }
  }

  function discard(id) {
    const view = live.get(id);
    if (!view) return;
    live.delete(id);
    views.destroy(view);
    set(tabs.get(id));
  }

  function enforceCap() {
    for (const id of tabsToDiscard([...tabs.values()], { activeId, budget: liveBudget, weights })) discard(id);
  }

  function ensureLive(tab) {
    if (live.has(tab.id)) return null;
    live.set(tab.id, views.create(tab));
    return loadInto(set(tab));
  }

  /** Make `id` the visible tab; reload it if it was discarded. Resolves when loaded. */
  async function activate(id) {
    const tab = tabs.get(id);
    if (!tab) throw new Error('unknown tab');
    const previous = activeId;
    activeId = id;
    const loading = ensureLive(tab);
    clock += 1;
    set({ ...tabs.get(id), lastActive: clock });
    if (previous !== null && previous !== id && live.has(previous)) views.hide(live.get(previous));
    views.show(live.get(id));
    enforceCap();
    onChange();
    await loading;
  }

  /** New tab showing `page` (a validated app path) for `toolId`/`docId`; becomes active. */
  async function open({ page = DEFAULT_PAGE, toolId = null, docId = null } = {}) {
    const id = nextId;
    nextId += 1;
    set({ id, partition: partitionFor(id), page, toolId, docId, lastActive: 0, epoch: 0 });
    await activate(id);
    return tabs.get(id);
  }

  /** Load another tool (and/or document) into an existing tab. */
  async function navigate(id, { page, toolId = null, docId = null }) {
    const tab = tabs.get(id);
    if (!tab) throw new Error('unknown tab');
    const next = set({ ...tab, page, toolId, docId, epoch: tab.epoch + 1 });
    enforceCap(); // the new tool may weigh more than the old one
    if (live.has(id)) await loadInto(next);
    else if (id === activeId) await activate(id);
    onChange();
  }

  /** The page navigated itself (e.g. a link to another tool): remember it for reloads. */
  function recordPage(id, page, toolId = null) {
    const tab = tabs.get(id);
    if (!tab) return;
    const moved = set({ ...tab, epoch: tab.epoch + 1 });
    if (moved.page === page) return;
    set({ ...moved, page, toolId });
    enforceCap(); // the new page may weigh more than the old one
    onChange();
  }

  /** The view started a main-frame navigation: whatever was meant for the old page is stale. */
  function noteNavigation(id) {
    const tab = tabs.get(id);
    if (tab) set({ ...tab, epoch: tab.epoch + 1 });
  }

  async function close(id) {
    if (!tabs.has(id)) throw new Error('unknown tab');
    discard(id);
    const rest = new Map(tabs);
    rest.delete(id);
    tabs = rest;
    if (activeId === id) {
      activeId = null;
      const recent = [...tabs.values()].sort((a, b) => b.lastActive - a.lastActive)[0];
      if (recent) await activate(recent.id);
    }
    onChange();
  }

  /** Window teardown: destroy every view and forget every tab. No callbacks fire. */
  function closeAll() {
    for (const id of [...live.keys()]) discard(id);
    tabs = new Map();
    activeId = null;
  }

  /** Cycle through the strip order; `step` is +1 or -1. */
  async function cycle(step) {
    const ids = [...tabs.keys()];
    if (ids.length === 0) return;
    const at = ids.indexOf(activeId);
    await activate(ids[(at + step + ids.length) % ids.length]);
  }

  const list = () => [...tabs.values()].map((t) => Object.freeze({ ...t, active: t.id === activeId }));

  return Object.freeze({
    open,
    activate,
    navigate,
    recordPage,
    noteNavigation,
    close,
    closeAll,
    next: () => cycle(1),
    previous: () => cycle(-1),
    list,
    get: (id) => tabs.get(id),
    has: (id) => tabs.has(id),
    viewOf: (id) => live.get(id),
    activeId: () => activeId,
  });
}

module.exports = { createTabManager, partitionFor, DEFAULT_PAGE };
