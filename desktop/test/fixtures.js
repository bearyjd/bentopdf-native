'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UPSTREAM_MODULES = path.resolve(__dirname, '..', '..', 'upstream', 'node_modules');

function upstreamRequire(name) {
  try {
    return require(require.resolve(name, { paths: [UPSTREAM_MODULES] }));
  } catch {
    throw new Error(
      `${name} not found in ${UPSTREAM_MODULES}; run scripts/build-local.sh once to fetch upstream`
    );
  }
}

async function writeSmallPdf(file) {
  const { PDFDocument, StandardFonts } = upstreamRequire('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const n of [1, 2]) {
    doc.addPage([300, 200]).drawText(`Fixture page ${n}`, { x: 30, y: 100, size: 18, font });
  }
  fs.writeFileSync(file, await doc.save());
}

/** PDF of one page holding the PNG, for OCR. */
async function writePngPdf(file, png, width, height) {
  const { PDFDocument } = upstreamRequire('pdf-lib');
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  fs.writeFileSync(file, await doc.save());
}

/**
 * PDF of `pages` blank pages plus incompressible orphan streams totalling
 * exactly `megabytes` MiB of payload (the file is that plus a small structural
 * overhead; callers assert the real size).
 */
async function writeBigPdf(file, { megabytes = 105, pages = 300 } = {}) {
  const { PDFDocument } = upstreamRequire('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([612, 792]);
  const chunk = 8 * 1024 * 1024;
  for (let left = megabytes * 1024 * 1024; left > 0; left -= chunk) {
    doc.context.register(doc.context.stream(crypto.randomBytes(Math.min(chunk, left))));
  }
  fs.writeFileSync(file, await doc.save({ useObjectStreams: false }));
}

/** Text of every page of a PDF, via the pdf.js that BentoPDF itself ships (node side). */
async function extractPdfText(file) {
  const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs', { paths: [UPSTREAM_MODULES] });
  const pdfjs = await import(require('node:url').pathToFileURL(pdfjsPath).href);
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(' '));
  }
  await doc.destroy();
  return pages.join('\n');
}

async function writeDocx(file) {
  const JSZip = upstreamRequire('jszip');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t>' + DOCX_TEXT + '</w:t></w:r></w:p></w:body></w:document>'
  );
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

const DOCX_TEXT = 'BentoPDF desktop LibreOffice fixture';

module.exports = { writeSmallPdf, writePngPdf, writeBigPdf, writeDocx, extractPdfText, DOCX_TEXT };
