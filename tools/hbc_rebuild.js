'use strict';
// HBC v89 in-place offset rebuilder.
// Parses the original device bytecode, appends new strings (and later bytecode),
// recomputes every absolute offset (function offset/infoOffset, large-header
// pointers, debugInfoOffset, fileLength) and the footer SHA1, keeping every
// existing function body byte-identical. Equal-length in-place patches too.
//
//   node hbc_rebuild.js <in.hbc> <out.hbc> [--selftest]
//        [--add STR]... [--patch OFF=HEXBYTES]...
// --selftest: reserialize with no edits and assert byte-identical to input.
const fs = require('fs');
const crypto = require('crypto');
const { HBC } = require('./hbc.js');

const align4 = x => (x + 3) & ~3;
const HDR = { fileLength:32, functionCount:40, stringKindCount:44, identifierCount:48,
  stringCount:52, overflowStringCount:56, stringStorageSize:60, debugInfoOffset:104 };

function rebuild(inPath, { adds = [], patches = [], funcPatches = [] } = {}) {
  const h = new HBC(inPath);
  const b = h.buf, H = h.header, S = h.sect;
  const oldSEnd = S.end, fileLen = H.fileLength;
  const src = Buffer.from(b);                        // mutable full copy
  for (const p of patches) p.bytes.copy(src, p.off); // equal-length edits
  const tail = Buffer.from(src.slice(oldSEnd, fileLen - 20));
  const sl = (start, size) => Buffer.from(src.slice(start, start + size));

  // --- grow string sections ---
  let stringKindsBuf = sl(S.stringKinds, H.stringKindCount * 4);
  let stringTableBuf = sl(S.stringTable, H.stringCount * 4);
  let stringStorageBuf = sl(S.stringStorage, H.stringStorageSize);
  let newStringCount = H.stringCount, newStorageSize = H.stringStorageSize, newKindRuns = 0;
  const tableAdd = [], storeAdd = [];
  for (const add of adds) {
    const text = add.text, utf16 = add.utf16 ? 1 : 0, len = text.length;
    const off = newStorageSize;
    if (off >= (1 << 23)) throw new Error('storage offset exceeds 23-bit small entry');
    if (len >= 255) throw new Error('string length >=255 needs overflow entry (not impl)');
    const w = (utf16 | (off << 1) | (len << 24)) >>> 0;
    const e = Buffer.alloc(4); e.writeUInt32LE(w, 0); tableAdd.push(e);
    let sb;
    if (utf16) { sb = Buffer.alloc(len * 2); for (let i = 0; i < len; i++) sb.writeUInt16LE(text.charCodeAt(i), i * 2); }
    else sb = Buffer.from(text, 'latin1');
    storeAdd.push(sb);
    newStorageSize += sb.length; newStringCount += 1;
  }
  if (adds.length) {
    if (adds.some(a => a.identifier)) throw new Error('identifier adds not impl (need identHash)');
    const run = Buffer.alloc(4); run.writeUInt32LE((adds.length & 0x7fffffff) >>> 0, 0); // kind 0 = String
    stringKindsBuf = Buffer.concat([stringKindsBuf, run]); newKindRuns = 1;
    stringTableBuf = Buffer.concat([stringTableBuf, ...tableAdd]);
    stringStorageBuf = Buffer.concat([stringStorageBuf, ...storeAdd]);
  }

  // --- lay out MIDDLE sections with 4-byte alignment ---
  const sections = [
    ['funcHeaders', sl(S.funcHeaders, H.functionCount * 16)],
    ['stringKinds', stringKindsBuf],
    ['identHashes', sl(S.identHashes, H.identifierCount * 4)],
    ['stringTable', stringTableBuf],
    ['overflowStrings', sl(S.overflowStrings, H.overflowStringCount * 8)],
    ['stringStorage', stringStorageBuf],
    ['arrayBuffer', sl(S.arrayBuffer, H.arrayBufferSize)],
    ['objKeyBuffer', sl(S.objKeyBuffer, H.objKeyBufferSize)],
    ['objValueBuffer', sl(S.objValueBuffer, H.objValueBufferSize)],
    ['bigIntTable', sl(S.bigIntTable, H.bigIntCount * 8)],
    ['bigIntStorage', sl(S.bigIntStorage, H.bigIntStorageSize)],
    ['regExpTable', sl(S.regExpTable, H.regExpCount * 8)],
    ['regExpStorage', sl(S.regExpStorage, H.regExpStorageSize)],
    ['cjsModules', sl(S.cjsModules, H.cjsModuleCount * 8)],
    ['functionSources', sl(S.functionSources, H.functionSourceCount * 8)],
  ];
  let pos = 128; const at = {};
  for (const [n, buf] of sections) { pos = align4(pos); at[n] = pos; pos += buf.length; }
  const newSEnd = align4(pos), shift = newSEnd - oldSEnd;
  if (shift % 4) throw new Error('shift not multiple of 4: ' + shift);

  // --- patched function bodies appended at end-of-file (no other body moves) ---
  const funcNewOff = {};
  { let cur = newSEnd + tail.length;
    for (const fp of funcPatches) { cur = align4(cur); funcNewOff[fp.fid] = { offset: cur, size: fp.newBody.length }; cur += fp.newBody.length; } }

  // --- patch function headers (offset/infoOffset or large-header pointer) += shift ---
  const fh = sections[0][1];
  for (const f of h.functions) {
    const o = 16 * f.id;
    let w0 = fh.readUInt32LE(o), w1 = fh.readUInt32LE(o + 4), w2 = fh.readUInt32LE(o + 8);
    const fp = funcNewOff[f.id];
    if (fp) {
      if (f.overflowed) throw new Error('patching an overflowed function not impl (fid ' + f.id + ')');
      w0 = ((w0 & ~0x1ffffff) | (fp.offset & 0x1ffffff)) >>> 0;   // body -> appended location
      w1 = ((w1 & ~0x7fff) | (fp.size & 0x7fff)) >>> 0;           // new size (15-bit)
      w2 = ((w2 & ~0x1ffffff) | ((f.infoOffset + shift) & 0x1ffffff)) >>> 0;
    } else if (f.overflowed) {
      const nL = f.largeHeaderAt + shift;
      w0 = ((w0 & 0xffff0000) | (nL & 0xffff)) >>> 0;
      w2 = ((w2 & 0xfe000000) | ((nL >>> 16) & 0x1ffffff)) >>> 0;
    } else {
      w0 = ((w0 & ~0x1ffffff) | ((f.offset + shift) & 0x1ffffff)) >>> 0;
      w2 = ((w2 & ~0x1ffffff) | ((f.infoOffset + shift) & 0x1ffffff)) >>> 0;
    }
    fh.writeUInt32LE(w0, o); fh.writeUInt32LE(w1, o + 4); fh.writeUInt32LE(w2, o + 8);
  }
  // large headers live in the tail; their offset(+0)/infoOffset(+16) are absolute
  for (const f of h.functions) if (f.overflowed) {
    const t = f.largeHeaderAt - oldSEnd;
    tail.writeUInt32LE((tail.readUInt32LE(t) + shift) >>> 0, t);
    tail.writeUInt32LE((tail.readUInt32LE(t + 16) + shift) >>> 0, t + 16);
  }

  // --- appended patched-body region (after tail, before footer) ---
  let appendRegion = Buffer.alloc(0);
  if (funcPatches.length) {
    const parts = []; let cur = newSEnd + tail.length;
    for (const fp of funcPatches) { const pad = align4(cur) - cur; if (pad) parts.push(Buffer.alloc(pad)); cur = align4(cur) + fp.newBody.length; parts.push(fp.newBody); }
    appendRegion = Buffer.concat(parts);
  }

  // --- assemble ---
  const middle = Buffer.alloc(newSEnd - 128);
  for (const [n, buf] of sections) buf.copy(middle, at[n] - 128);
  const header = sl(0, 128);
  header.writeUInt32LE((H.stringKindCount + newKindRuns) >>> 0, HDR.stringKindCount);
  header.writeUInt32LE(newStringCount >>> 0, HDR.stringCount);
  header.writeUInt32LE(newStorageSize >>> 0, HDR.stringStorageSize);
  header.writeUInt32LE((H.debugInfoOffset + shift) >>> 0, HDR.debugInfoOffset);
  const newFileLen = 128 + middle.length + tail.length + appendRegion.length + 20;
  header.writeUInt32LE(newFileLen >>> 0, HDR.fileLength);
  const footer = Buffer.alloc(20);
  let out = Buffer.concat([header, middle, tail, appendRegion, footer]);
  const digest = crypto.createHash('sha1').update(out.slice(0, out.length - 20)).digest();
  digest.copy(out, out.length - 20);
  return { out, shift, newSEnd, oldSEnd, newStringCount, newFileLen };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const inPath = argv[0], outPath = argv[1];
  const adds = [], patches = []; let selftest = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--selftest') selftest = true;
    else if (argv[i] === '--add') adds.push({ text: argv[++i], utf16: false, identifier: false });
    else if (argv[i] === '--patch') { const [off, hex] = argv[++i].split('='); patches.push({ off: parseInt(off, 0), bytes: Buffer.from(hex, 'hex') }); }
  }
  const r = rebuild(inPath, { adds, patches });
  fs.writeFileSync(outPath, r.out);
  console.log(`wrote ${outPath} len=${r.out.length} shift=${r.shift} newStringCount=${r.newStringCount}`);
  if (selftest) {
    const orig = fs.readFileSync(inPath);
    if (orig.length === r.out.length && orig.equals(r.out)) console.log('SELFTEST: byte-identical OK');
    else {
      let d = -1; for (let i = 0; i < Math.min(orig.length, r.out.length); i++) if (orig[i] !== r.out[i]) { d = i; break; }
      console.log(`SELFTEST FAIL: lenOrig=${orig.length} lenNew=${r.out.length} firstDiff=0x${(d<0?'none':d.toString(16))}`);
    }
  }
}
module.exports = { rebuild };
