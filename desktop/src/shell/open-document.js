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

module.exports = { createDocumentOpener };
