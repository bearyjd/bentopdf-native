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
 *
 * Which tool is heavy is read from the built bundle, not from a hand-kept list:
 * `weightOfPage(html)` classifies a tool page by the engine chunks it preloads
 * (the registry calls it for every dist/<id>.html at startup). A page that
 * references an engine weighs that engine's slots even if it only loads it on
 * demand (conservative), and a tool id that is not in the registry weighs the
 * heaviest weight (conservative: an id nobody classified must not get a free ride).
 */
const LIVE_VIEW_BUDGET = 6;
const DEFAULT_WEIGHT = 1;
const OCR_WEIGHT = 2;
const LIBREOFFICE_WEIGHT = 4;
const UNKNOWN_TOOL_WEIGHT = LIBREOFFICE_WEIGHT;

// Markers in a tool page's HTML (its modulepreload links / script URLs) of the heavy engines.
const LIBREOFFICE_MARKER = /libreoffice-loader|libreoffice-wasm|soffice/i;
const OCR_MARKER = /tesseract-runtime/i;

/** Slots a tool page of this HTML occupies (the heaviest engine it references). */
function weightOfPage(html) {
  if (typeof html !== 'string') return DEFAULT_WEIGHT;
  if (LIBREOFFICE_MARKER.test(html)) return LIBREOFFICE_WEIGHT;
  if (OCR_MARKER.test(html)) return OCR_WEIGHT;
  return DEFAULT_WEIGHT;
}

/**
 * Slots one live view occupies. `toolId` null is the landing page; `weights` is the registry's
 * Map(id -> slots). A string id missing from it is unknown and weighs UNKNOWN_TOOL_WEIGHT.
 */
function weightOfTool(toolId, weights = new Map()) {
  if (toolId === null || toolId === undefined) return DEFAULT_WEIGHT;
  return typeof toolId === 'string' && weights.has(toolId) ? weights.get(toolId) : UNKNOWN_TOOL_WEIGHT;
}

module.exports = { LIVE_VIEW_BUDGET, DEFAULT_WEIGHT, OCR_WEIGHT, LIBREOFFICE_WEIGHT, UNKNOWN_TOOL_WEIGHT, weightOfPage, weightOfTool };
