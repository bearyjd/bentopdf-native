'use strict';

const { serialByKey } = require('./bounded');

/**
 * Opens a path as a document in a tab. The path is validated by the store; the record is read
 * once, synchronously right after the store accepted it (nothing awaited in between), and only
 * that snapshot is used afterwards: the document can be closed or evicted while the tab opens,
 * which must end in a clear error, never in a dereference of a missing record.
 */
function createDocumentOpener({ store, recents, tabs, pushState }) {
  async function openNow(filePath) {
    const doc = await store.addFromPath(filePath);
    const record = store.get(doc.id);
    if (!record) throw new Error(`${doc.name} was closed while it was being opened`);
    recents.add(record.filePath);
    const existing = tabs.list().find((t) => t.docId === doc.id);
    if (existing) await tabs.activate(existing.id);
    else await tabs.open({ docId: doc.id });
    pushState();
    return doc;
  }
  const serial = serialByKey((filePath) => openNow(filePath));
  return (filePath) => serial(String(filePath));
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Remove a document nothing shows any more (its last tab closed or navigated away). Callers run this after an
 * `await` (a page load), so a concurrent open of the same file may be between the store accepting it and its tab
 * existing (the opener's own awaits). The check is therefore repeated after one event-loop turn, when every such
 * open has either created its tab or failed; a document a tab shows by then is kept.
 */
function createDocumentReleaser({ store, tabs, yieldTurn = nextTurn }) {
  const shown = (docId) => tabs.list().some((t) => t.docId === docId);
  return async function release(docId) {
    if (!docId || shown(docId)) return;
    await yieldTurn();
    if (!shown(docId)) store.remove(docId);
  };
}

module.exports = { createDocumentOpener, createDocumentReleaser };
