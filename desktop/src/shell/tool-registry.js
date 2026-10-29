'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { weightOfPage } = require('./live-budget');

/**
 * Tool list derived from the built bundle at startup (no upstream patch, no
 * hand-maintained copy). Limits, by construction:
 * - A "tool" is any top-level `dist/<id>.html` that is not on EXCLUDED_PAGES.
 *   Hub and SEO landing pages (pdf-converter, compress-pdf-to-1mb, ...) are
 *   therefore listed too, under no category.
 * - Name and category come from the cards of `dist/tools.html`
 *   (`<h2>` section, `<a href="/id"><h3>Name</h3>`). That markup is upstream's
 *   rendered HTML, not an API: if it changes, every tool falls back to its
 *   `<title>` (suffix stripped) and `category: null`. Nothing fails.
 * - "Popular Tools" is one of upstream's sections, so a tool shown there has
 *   that as its category (upstream lists each tool once).
 */

const EXCLUDED_PAGES = Object.freeze([
  '404', 'about', 'contact', 'faq', 'licensing', 'privacy', 'terms', 'index', 'tools',
]);
// Separately licensed, must never be offered (they are also removed from dist by the build).
const EXCLUDED_PATTERN = /kura|hyper-?compress/i;
const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

const decodeEntities = (text) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

function readSmall(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_HTML_BYTES) return '';
  return fs.readFileSync(file, 'utf8');
}

/** `<title>` of a page without the " | BentoPDF" style suffix; null if none. */
function pageTitle(html) {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = decodeEntities(match[1]).split(/\s+[|-]\s+BentoPDF\b/)[0].trim();
  return title || null;
}

/** Map(id -> {name, category}) from the cards of tools.html, in page order. */
function parseToolsPage(html) {
  const cards = new Map();
  const token = /<h2[^>]*>([^<]*)<\/h2>|<a href="\/([a-z0-9-]+)"[^>]*>\s*<h3[^>]*>([^<]*)<\/h3>/gi;
  let category = null;
  for (let m = token.exec(html); m !== null; m = token.exec(html)) {
    if (m[1] !== undefined) category = decodeEntities(m[1]) || null;
    else if (!cards.has(m[2])) cards.set(m[2], Object.freeze({ name: decodeEntities(m[3]), category }));
  }
  return cards;
}

/**
 * @param {string} distDir realpath of the bundle
 * @returns {{tools: ReadonlyArray<{id: string, name: string, title: string|null, category: string|null, path: string, weight: number}>,
 *            get(id: unknown): object|undefined, has(id: unknown): boolean}}
 */
function buildToolRegistry(distDir) {
  const toolsPage = path.join(distDir, 'tools.html');
  const cards = fs.existsSync(toolsPage) ? parseToolsPage(readSmall(toolsPage)) : new Map();
  const ids = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => entry.name.slice(0, -'.html'.length))
    .filter((id) => TOOL_ID.test(id) && !EXCLUDED_PAGES.includes(id) && !EXCLUDED_PATTERN.test(id));

  const order = [...cards.keys()];
  const rank = (id) => (cards.has(id) ? order.indexOf(id) : order.length);
  const tools = ids
    .map((id) => {
      const html = readSmall(path.join(distDir, `${id}.html`));
      const title = pageTitle(html);
      const card = cards.get(id);
      return Object.freeze({
        id,
        name: (card && card.name) || title || id,
        title,
        category: card ? card.category : null,
        path: `/${id}.html`,
        weight: weightOfPage(html),
      });
    })
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));

  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return Object.freeze({
    tools: Object.freeze(tools),
    weights: new Map(tools.map((tool) => [tool.id, tool.weight])), // live-view slots per tool id (live-budget.js)
    get: (id) => (typeof id === 'string' ? byId.get(id) : undefined),
    has: (id) => typeof id === 'string' && byId.has(id),
  });
}

module.exports = { buildToolRegistry, parseToolsPage, pageTitle, EXCLUDED_PAGES, TOOL_ID };
