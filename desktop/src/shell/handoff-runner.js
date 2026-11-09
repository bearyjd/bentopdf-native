'use strict';

/**
 * Hand a tab's document to its tool page (grant, settle, inject). Dependencies are injected so the
 * supersede guards (sequence, view, epoch, URL re-check) can be unit-tested without Electron.
 * Runs in the background: progress and failure go to the tab's status, never to the caller.
 */
function createHandoff({ tabs, store, registry, toolIpc, origin, handoffSeq, handoffs, beforeInject, logLimited, getStatus, setStatus, adapterFor, handoffScript, isTargetPage, pushCapped, sanitizeText }) {
  return async function handoff(tab, view) {
    const seq = (handoffSeq.get(tab.id) || 0) + 1;
    handoffSeq.set(tab.id, seq);
    const doc = tab.docId && tab.toolId ? store.get(tab.docId) : undefined;
    if (!doc) {
      if (getStatus(tab.id)) setStatus(tab.id, null);
      return;
    }
    const wc = view.webContents;
    // Superseded when a newer handoff started, the view was replaced, or the tab navigated (epoch).
    const latest = () => handoffSeq.get(tab.id) === seq && tabs.viewOf(tab.id) === view && !wc.isDestroyed() && tabs.get(tab.id)?.epoch === tab.epoch;
    // A handoff dropped before it finished must not leave its own 'Loading...' behind (hash-only navigation fires no
    // did-navigate that would clear it). A newer handoff owns the status once handoffSeq has moved on.
    const abandon = () => {
      if (handoffSeq.get(tab.id) === seq && tabs.has(tab.id) && getStatus(tab.id)?.kind === 'loading') setStatus(tab.id, null);
    };
    const toolName = registry.get(tab.toolId).name;
    setStatus(tab.id, { kind: 'loading', text: `Loading ${doc.name} into ${toolName}...` });
    try {
      const entry = doc.bytes
        ? toolIpc.grantBytes(wc, doc.name, doc.bytes)
        : await toolIpc.grantPath(wc, doc.filePath, { dev: doc.dev, ino: doc.ino });
      await beforeInject({ tabId: tab.id, toolId: tab.toolId });
      // Re-check right before injecting: the grant (or the settle delay) may have outlived the page.
      if (!latest() || !isTargetPage(wc.getURL(), origin, tab.page)) return abandon();
      // userGesture=false: the page must not get transient user activation from us.
      const count = await wc.executeJavaScript(handoffScript([entry], adapterFor(tab.toolId)), false);
      if (!latest()) return abandon();
      if (store.has(doc.id)) store.touch(doc.id);
      pushCapped(handoffs, Object.freeze({ tabId: tab.id, toolId: tab.toolId, docId: doc.id, count }));
      setStatus(tab.id, null);
    } catch (err) {
      const reason = sanitizeText(err && err.message); // page-originated text: capped, no control characters
      logLimited(tab.partition, `handoff ${sanitizeText(doc.name)} -> ${tab.toolId} (tab ${tab.id}): ${reason}`);
      if (latest()) setStatus(tab.id, { kind: 'error', text: sanitizeText(`Could not open ${doc.name} in ${toolName}: ${reason}`) });
      else abandon();
    }
  };
}

module.exports = { createHandoff };
