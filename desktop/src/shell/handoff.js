'use strict';

/**
 * Per-tool handoff adapters: which `<input type=file>` of an unmodified
 * upstream page receives the active document. Only Merge PDF is proven by a
 * test; every other tool uses the default and is NOT VERIFIED.
 */
const DEFAULT_ADAPTER = Object.freeze({ selector: 'input[type="file"]', multiple: false });
const ADAPTERS = new Map([
  ['merge-pdf', Object.freeze({ selector: '#file-input', multiple: true })],
]);

const adapterFor = (toolId) => Object.freeze({ toolId, ...(ADAPTERS.get(toolId) || DEFAULT_ADAPTER) });

const INPUT_WAIT_MS = 30000;
// Upstream pages attach their `change` listeners in module code that can run
// after the input exists; the M2 handoff scenario needed the same pause.
const SETTLE_MS = 1500;

/**
 * Script run in the tool page's main world: wait for the adapter's input,
 * settle, then call the existing preload bridge (`handoffToInput`), which
 * reads the granted token over the tool IPC exactly as a user pick would.
 * Every value is main-process data serialised with JSON.stringify.
 */
function handoffScript(entries, adapter, { waitMs = INPUT_WAIT_MS, settleMs = SETTLE_MS } = {}) {
  const files = (adapter.multiple ? entries : entries.slice(0, 1)).map(({ token, name, size }) => ({ token, name, size }));
  return `(async () => {
    const selector = ${JSON.stringify(adapter.selector)};
    const deadline = Date.now() + ${Number(waitMs)};
    while (!document.querySelector(selector)) {
      if (Date.now() > deadline) throw new Error('no file input ' + selector);
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, ${Number(settleMs)}));
    return window.bentoDesktop.handoffToInput(${JSON.stringify(files)}, selector);
  })()`;
}

module.exports = { adapterFor, handoffScript, DEFAULT_ADAPTER, SETTLE_MS };
