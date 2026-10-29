'use strict';

/**
 * Live-view budget: every tool a tab can show has a weight in "slots", and the
 * live (not discarded) tabs together may weigh at most LIVE_VIEW_BUDGET. This
 * is an estimate from docs/m2-findings.md (one process tree, peak RSS), NOT a
 * measurement of the running machine:
 *
 *   LibreOffice conversion  ~1.7 GiB  -> 4 slots
 *   OCR (1 page)            ~0.9 GiB  -> 2 slots
 *   everything else         lighter   -> 1 slot (page dimensions of a 105 MiB
 *                                        PDF were ~1.2 GiB, so "light" is a
 *                                        guess, not a promise)
 *
 * One slot is therefore roughly 0.4 GiB, and a budget of 6 is ~2.5 GiB of live
 * renderers. All numbers live here so they can be tuned in one place.
 */
const LIVE_VIEW_BUDGET = 6;
const DEFAULT_WEIGHT = 1;
const OCR_WEIGHT = 2;
const LIBREOFFICE_WEIGHT = 4;

// Tools that load the LibreOffice WASM engine (dist/*.html that reference libreoffice-wasm).
const LIBREOFFICE_TOOLS = Object.freeze([
  'word-to-pdf', 'excel-to-pdf', 'powerpoint-to-pdf', 'odt-to-pdf', 'ods-to-pdf', 'odp-to-pdf',
  'odg-to-pdf', 'rtf-to-pdf', 'wps-to-pdf', 'wpd-to-pdf', 'pub-to-pdf', 'pages-to-pdf',
  'vsd-to-pdf', 'pdf-to-word',
]);
const OCR_TOOLS = Object.freeze(['ocr-pdf']);

const WEIGHTS = new Map([
  ...LIBREOFFICE_TOOLS.map((id) => [id, LIBREOFFICE_WEIGHT]),
  ...OCR_TOOLS.map((id) => [id, OCR_WEIGHT]),
]);

/** Slots one live view of `toolId` (null = landing page) occupies. */
const weightOfTool = (toolId) => (typeof toolId === 'string' && WEIGHTS.has(toolId) ? WEIGHTS.get(toolId) : DEFAULT_WEIGHT);

module.exports = { LIVE_VIEW_BUDGET, DEFAULT_WEIGHT, OCR_WEIGHT, LIBREOFFICE_WEIGHT, LIBREOFFICE_TOOLS, OCR_TOOLS, weightOfTool };
