'use strict';
// Build out/bridge.delta: the bridge HBC expressed as runs copied from the console's own
// decrypted hub bytecode, shifted function headers, and literal bytes. The payload ships only this delta; the
// detour rebuilds the bridge inside ShellUI when the hub loads (see tools/gen_detour.py).
//
//   node tools/make_delta.js <original.hbc> <bridge.hbc> <out.delta>
//
// Blob layout (little-endian; the detour reads it in place, the installer fills [8]):
//   [0]  u64 source size        (must equal the hub buffer's size)
//   [8]  u64 destination ptr    (0 here; installer writes the reserved buffer address)
//   [16] u64 op count
//   [24] u64 built flag         (0; detour sets 1 after rebuilding)
//   [32] 20 B source hash       (HBC header bytes 12..32 of the original; must match)
//   [56] u64 destination size
//   [64] u64 mismatch counter   (detour counts hub buffers that failed the checks)
//   [96] ops: n x { u64 offset, u64 word }, destination sequential:
//        word bit63 set: literal, `word & ~bit63` bytes at `offset` in this blob;
//        word bit62 set: function headers, see below;
//        neither: copy `word` bytes from the hub buffer at `offset`.
//   then the literal bytes.
//
// Function headers. The bridge adds strings and grows a few function bodies, so every
// function's bytecode offset and info offset move, and the HBC function header table
// (16-byte small headers right after the 128-byte file header) changes in every record.
// They move by a constant within long runs, so a header op copies `count` records from
// the hub buffer at `offset` and adds `a` to the low 25 bits of each record's word 0
// (bytecode offset) and `b` to the low 25 bits of word 2 (info offset), modulo 2^25,
// leaving the high 7 bits (paramCount / frameSize) and words 1 and 3 as they are:
//   word = bit62 | count << 50 (12 bits, 1..4095) | b << 25 | a   (a, b: 25 bits)
// Records that do not fit (the hooked functions) go in as literal bytes.
const fs = require('fs');

const HBC_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const HBC_HEADER = 128, HBC_FUNC_COUNT = 40, REC = 16;
const LOW25 = 0x1ffffff, HIGH7 = 0xfe000000, MAX_RUN = 4095;
const HDR_OP = 1n << 62n, LIT_OP = 1n << 63n;

// The function header table both files share (same position and record count), or null.
function headerTable(src, dst) {
  if (src.length < HBC_HEADER || dst.length < HBC_HEADER) return null;
  if (!src.subarray(0, 8).equals(HBC_MAGIC) || !dst.subarray(0, 8).equals(HBC_MAGIC)) return null;
  const n = src.readUInt32LE(HBC_FUNC_COUNT);
  if (n !== dst.readUInt32LE(HBC_FUNC_COUNT) || HBC_HEADER + n * REC > Math.min(src.length, dst.length)) return null;
  return { start: HBC_HEADER, end: HBC_HEADER + n * REC };
}

// Apply one header record exactly like the detour does.
function shiftRecord(src, so, out, d, a, b) {
  const w0 = src.readUInt32LE(so), w2 = src.readUInt32LE(so + 8);
  out.writeUInt32LE(((w0 & HIGH7) | ((w0 + a) & LOW25)) >>> 0, d);
  out.writeUInt32LE(src.readUInt32LE(so + 4), d + 4);
  out.writeUInt32LE(((w2 & HIGH7) | ((w2 + b) & LOW25)) >>> 0, d + 8);
  out.writeUInt32LE(src.readUInt32LE(so + 12), d + 12);
}

// Delta that rebuilds `dst` from `src`; verified by applying it exactly like the
// detour does (throws if the rebuild is not byte-identical).
function makeDelta(src, dst) {
  const K = 16, idx = new Map();
  for (let i = 0; i + K <= src.length; i += 4) {
    const k = src.toString('latin1', i, i + K);
    if (!idx.has(k)) idx.set(k, i);
  }
  // ops: { kind: 'copy', off, len } | { kind: 'lit', start, len } (start in dst) |
  //      { kind: 'hdr', off, count, a, b }
  const ops = [];
  const literal = (i, len) => {
    const last = ops[ops.length - 1];
    if (last && last.kind === 'lit' && last.start + last.len === i) last.len += len;
    else ops.push({ kind: 'lit', start: i, len });
  };
  // Greedy copy/literal encoding of dst[from, to); copies never cross `to`.
  function greedy(from, to) {
    const ext = (s, d) => { let n = 0; while (s + n < src.length && d + n < to && src[s + n] === dst[d + n]) n++; return n; };
    let i = from, guess = -1;
    while (i < to) {
      let best = 0, bs = -1;
      if (guess >= 0 && guess < src.length) { const n = ext(guess, i); if (n >= 8) { best = n; bs = guess; } }
      if (best < 64 && i + K <= to) {
        for (let b = 0; b < 4 && best < 64; b++) {
          if (i - b < from) continue;
          const s0 = idx.get(dst.toString('latin1', i - b, i - b + K));
          if (s0 === undefined) continue;
          const s = s0 + b, n = ext(s, i);
          if (n > best) { best = n; bs = s; }
        }
      }
      if (best >= 24) { ops.push({ kind: 'copy', off: bs, len: best }); i += best; guess = bs + best; }
      else { literal(i, 1); i++; if (guess >= 0) guess++; }
    }
  }
  const table = headerTable(src, dst);
  if (!table) greedy(0, dst.length);
  else {
    greedy(0, table.start);
    for (let o = table.start; o < table.end; o += REC) {
      const s0 = src.readUInt32LE(o), d0 = dst.readUInt32LE(o), s2 = src.readUInt32LE(o + 8), d2 = dst.readUInt32LE(o + 8);
      const fits = ((s0 & HIGH7) >>> 0) === ((d0 & HIGH7) >>> 0) && ((s2 & HIGH7) >>> 0) === ((d2 & HIGH7) >>> 0)
        && src.readUInt32LE(o + 4) === dst.readUInt32LE(o + 4) && src.readUInt32LE(o + 12) === dst.readUInt32LE(o + 12);
      if (!fits) { literal(o, REC); continue; }
      const a = ((d0 & LOW25) - (s0 & LOW25)) & LOW25, b = ((d2 & LOW25) - (s2 & LOW25)) & LOW25;
      const last = ops[ops.length - 1];
      if (last && last.kind === 'hdr' && last.a === a && last.b === b && last.count < MAX_RUN && last.off + last.count * REC === o) last.count++;
      else ops.push({ kind: 'hdr', off: o, count: 1, a, b });
    }
    greedy(table.end, dst.length);
  }

  const HDR = 96, litBase = HDR + ops.length * 16;
  const litLen = ops.filter(o => o.kind === 'lit').reduce((a, o) => a + o.len, 0);
  const blob = Buffer.alloc(litBase + litLen);
  blob.writeBigUInt64LE(BigInt(src.length), 0);
  blob.writeBigUInt64LE(BigInt(ops.length), 16);
  src.copy(blob, 32, 12, 32);
  blob.writeBigUInt64LE(BigInt(dst.length), 56);
  let lp = litBase;
  ops.forEach((o, k) => {
    const p = HDR + k * 16;
    if (o.kind === 'copy') { blob.writeBigUInt64LE(BigInt(o.off), p); blob.writeBigUInt64LE(BigInt(o.len), p + 8); }
    else if (o.kind === 'hdr') {
      blob.writeBigUInt64LE(BigInt(o.off), p);
      blob.writeBigUInt64LE(HDR_OP | (BigInt(o.count) << 50n) | (BigInt(o.b) << 25n) | BigInt(o.a), p + 8);
    } else {
      blob.writeBigUInt64LE(BigInt(lp), p); blob.writeBigUInt64LE(BigInt(o.len) | LIT_OP, p + 8);
      dst.copy(blob, lp, o.start, o.start + o.len); lp += o.len;
    }
  });

  // verify: apply exactly like the detour does
  const out = Buffer.alloc(Number(blob.readBigUInt64LE(56)));
  let d = 0;
  for (let k = 0; k < Number(blob.readBigUInt64LE(16)); k++) {
    const off = Number(blob.readBigUInt64LE(HDR + k * 16));
    const w = blob.readBigUInt64LE(HDR + k * 16 + 8);
    if (w & LIT_OP) { const len = Number(w & ~LIT_OP); blob.copy(out, d, off, off + len); d += len; }
    else if (w & HDR_OP) {
      const a = Number(w & 0x1ffffffn), b = Number((w >> 25n) & 0x1ffffffn), count = Number((w >> 50n) & 0xfffn);
      for (let r = 0; r < count; r++) { shiftRecord(src, off + r * REC, out, d, a, b); d += REC; }
    } else { const len = Number(w); src.copy(out, d, off, off + len); d += len; }
  }
  if (d !== dst.length || !out.equals(dst)) throw new Error('make_delta: verification FAILED');
  return { blob, ops: ops.length, litLen, hdrOps: ops.filter(o => o.kind === 'hdr').length };
}

module.exports = { makeDelta };

if (require.main === module) {
  const [SRC, DST, OUT] = process.argv.slice(2);
  if (!OUT) { console.error('usage: make_delta.js <original.hbc> <bridge.hbc> <out.delta>'); process.exit(2); }
  const dst = fs.readFileSync(DST);
  const { blob, ops, litLen, hdrOps } = makeDelta(fs.readFileSync(SRC), dst);
  fs.writeFileSync(OUT, blob);
  console.log(`wrote ${OUT}: ${blob.length} bytes (${ops} ops, ${hdrOps} header runs, ${litLen} literal bytes) -> rebuilds ${dst.length} bytes, verified`);
}
