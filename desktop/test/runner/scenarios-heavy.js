'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures');
const { startSampler } = require('../rss');

const selfPid = process.pid;

async function libreoffice(ctx) {
  const docx = path.join(ctx.workDir, 'sample.docx');
  await fixtures.writeDocx(docx);
  await ctx.load('/word-to-pdf.html');
  await ctx.waitFor(`!!document.querySelector('#file-input')`, 30000);
  await ctx.sleep(1500);
  await ctx.handoff('#file-input', [docx]);
  await ctx.waitFor(`!!document.querySelector('#process-btn') && !document.querySelector('#process-btn').disabled`, 15000);
  const stop = startSampler(selfPid);
  const started = Date.now();
  let download;
  try {
    await ctx.js(`document.querySelector('#process-btn').click()`);
    download = await ctx.waitForDownload((d) => d.name === 'sample.pdf', 300000);
  } finally {
    var memory = stop();
  }
  const bytes = ctx.read(download.target);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('output is not a PDF');
  return { seconds: Math.round((Date.now() - started) / 1000), pdfBytes: bytes.length, ...memory };
}

async function drawTextPng(ctx) {
  const dataUrl = await ctx.js(`(() => {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 500;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000'; g.font = 'bold 170px sans-serif'; g.textBaseline = 'middle';
    g.fillText('BENTO OCR 2024', 60, 250); return c.toDataURL('image/png');
  })()`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function ocr(ctx) {
  await ctx.load('/index.html');
  const png = await drawTextPng(ctx);
  const pdf = path.join(ctx.workDir, 'ocr-input.pdf');
  await fixtures.writePngPdf(pdf, png, 800, 250);
  await ctx.load('/ocr-pdf.html');
  await ctx.waitFor(`!!document.querySelector('.lang-checkbox[value="eng"]')`, 30000);
  await ctx.handoff('#file-input', [pdf]);
  await ctx.waitFor(`!!document.querySelector('#file-display-area')?.textContent.includes('ocr-input.pdf')`, 20000);
  await ctx.js(`document.querySelector('.lang-checkbox[value="eng"]').click()`);
  await ctx.waitFor(`!document.querySelector('#process-btn').disabled`, 10000);
  const stop = startSampler(selfPid);
  const started = Date.now();
  let text;
  try {
    await ctx.js(`document.querySelector('#process-btn').click()`);
    text = await ctx.waitFor(`document.querySelector('#ocr-text-output')?.value`, 240000, 'OCR text output');
  } finally {
    var memory = stop();
  }
  const norm = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!norm.includes('BENTO') || !norm.includes('2024')) throw new Error(`OCR text not recovered: ${JSON.stringify(text)}`);
  return { recovered: text.trim(), seconds: Math.round((Date.now() - started) / 1000), ...memory };
}

async function bigPdf(ctx) {
  const big = path.join(ctx.workDir, 'big.pdf');
  await fixtures.writeBigPdf(big, { megabytes: 105, pages: 300 });
  const sizeMiB = Math.round(fs.statSync(big).size / 1048576);
  await ctx.load('/page-dimensions.html');
  await ctx.waitFor(`!!document.querySelector('#file-input')`, 30000);
  await ctx.sleep(1500);
  const stop = startSampler(selfPid);
  const started = Date.now();
  let summary;
  try {
    await ctx.handoff('#file-input', [big]);
    summary = await ctx.waitFor(
      `(() => { const t = document.querySelector('#dimensions-summary')?.textContent.replace(/\\s+/g, ' ').trim(); return t || ''; })()`,
      300000,
      'page dimensions summary'
    );
  } finally {
    var memory = stop();
  }
  const rows = await ctx.js(`document.querySelectorAll('#dimensions-table-body tr').length`);
  if (!/300/.test(summary) && rows < 300) throw new Error(`page count not 300: summary=${summary} rows=${rows}`);
  return { pdfMiB: sizeMiB, seconds: Math.round((Date.now() - started) / 1000), summary: summary.slice(0, 120), rows, ...memory };
}

module.exports = { libreoffice, ocr, bigPdf };
