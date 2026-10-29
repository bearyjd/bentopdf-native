'use strict';

// Packs PNG files into one Windows .ico (PNG-compressed entries, valid since Vista).
// Usage: node make-ico.js <out.ico> <size:file.png> [<size:file.png> ...]
// Each PNG must really be size x size (checked against its IHDR); sizes are 1..256.
const fs = require('node:fs');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildIco(entries) {
  if (entries.length === 0) throw new Error('make-ico: no images given');
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, png }, i) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error(`make-ico: bad size ${size}`);
    if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`make-ico: ${size}px entry is not a PNG`);
    if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) throw new Error(`make-ico: PNG for ${size}px is ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    const at = i * 16;
    directory.writeUInt8(size === 256 ? 0 : size, at);
    directory.writeUInt8(size === 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4); // planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

if (require.main === module) {
  const [out, ...specs] = process.argv.slice(2);
  if (!out || specs.length === 0) {
    process.stderr.write('usage: make-ico.js <out.ico> <size:file.png> ...\n');
    process.exit(2);
  }
  const entries = specs.map((spec) => {
    const [size, file] = spec.split(':');
    return { size: Number(size), png: fs.readFileSync(file) };
  });
  fs.writeFileSync(out, buildIco(entries));
  process.stdout.write(`wrote ${out}\n`);
}

module.exports = { buildIco };
