'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { buildToolRegistry, pageTitle, parseToolsPage } = require('../src/shell/tool-registry');

function fixtureDist(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-registry-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

const TOOLS_PAGE =
  '<h2 class="x">Popular Tools</h2><a href="/merge-pdf" class="c"><h3 class="t">Merge PDF</h3></a>' +
  '<h2>Edit &amp; Annotate</h2>\n<a href="/sign-pdf" class="c">\n  <h3>Sign PDF</h3></a>' +
  '<a href="/not-built"><h3>Ghost</h3></a>';

test('pageTitle strips the BentoPDF suffix and whitespace', () => {
  assert.equal(pageTitle('<title>\n  Merge PDF Files Free Online | BentoPDF\n</title>'), 'Merge PDF Files Free Online');
  assert.equal(pageTitle('<title>404 - Page Not Found | BentoPDF</title>'), '404 - Page Not Found');
  assert.equal(pageTitle('<p>no title</p>'), null);
});

test('parseToolsPage keeps section categories and decodes entities', () => {
  const cards = parseToolsPage(TOOLS_PAGE);
  assert.deepEqual(cards.get('merge-pdf'), { name: 'Merge PDF', category: 'Popular Tools' });
  assert.deepEqual(cards.get('sign-pdf'), { name: 'Sign PDF', category: 'Edit & Annotate' });
});

test('registry: pages from dist, names from tools.html, exclusions applied', () => {
  const dir = fixtureDist({
    'tools.html': TOOLS_PAGE,
    'merge-pdf.html': '<title>Merge PDF Files | BentoPDF</title>',
    'sign-pdf.html': '<title>Sign | BentoPDF</title>',
    'compress-pdf-to-1mb.html': '<title>Compress PDF to 1MB Free Online | BentoPDF</title>',
    'index.html': '<title>PDF Tools</title>',
    'about.html': '<title>About</title>',
    'kura.html': '<title>Kura</title>',
    'hyper-compress.html': '<title>HC</title>',
    'Bad Name.html': '<title>x</title>',
    'readme.txt': 'not html',
  });
  try {
    const registry = buildToolRegistry(dir);
    assert.deepEqual(registry.tools.map((t) => t.id), ['merge-pdf', 'sign-pdf', 'compress-pdf-to-1mb']);
    assert.deepEqual(registry.get('merge-pdf'), {
      id: 'merge-pdf', name: 'Merge PDF', title: 'Merge PDF Files', category: 'Popular Tools', path: '/merge-pdf.html', weight: 1,
    });
    assert.equal(registry.get('compress-pdf-to-1mb').category, null);
    assert.equal(registry.get('compress-pdf-to-1mb').name, 'Compress PDF to 1MB Free Online');
    assert.equal(registry.has('not-built'), false, 'a card without a page is not a tool');
    assert.ok(Object.isFrozen(registry.tools) && Object.isFrozen(registry.tools[0]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registry lookups refuse hostile ids', () => {
  const dir = fixtureDist({ 'merge-pdf.html': '<title>M</title>' });
  try {
    const registry = buildToolRegistry(dir);
    for (const bad of ['__proto__', 'constructor', 'toString', '../index', 'merge-pdf.html', '', null, 42, {}, ['merge-pdf']]) {
      assert.equal(registry.has(bad), false, String(bad));
      assert.equal(registry.get(bad), undefined, String(bad));
    }
    assert.equal(registry.get('merge-pdf').category, null, 'no tools.html: no categories, still listed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const realDist = path.resolve(__dirname, '..', '..', 'dist');
test('registry against the real bundle (skipped without ../dist)', { skip: !fs.existsSync(path.join(realDist, 'tools.html')) }, () => {
  const registry = buildToolRegistry(fs.realpathSync(realDist));
  assert.ok(registry.tools.length >= 100, `only ${registry.tools.length} tools`);
  assert.equal(registry.get('merge-pdf').name, 'Merge PDF');
  assert.ok(registry.tools.every((t) => !/kura|hyper/i.test(t.id) && t.id !== 'index'));
  const categorized = registry.tools.filter((t) => t.category).length;
  assert.ok(categorized >= 100, `only ${categorized} categorized`);
});
