'use strict';
// Build out/bridge.delta: the bridge HBC expressed as runs copied from the console's own
// decrypted hub bytecode plus literal bytes. The payload ships only this delta; the
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
//   [96] ops: n x { u64 offset, u64 length | bit63 } bit63 set = literal (offset into
//        this blob), clear = copy from the hub buffer at offset. Destination is sequential.
//   then the literal bytes.
const fs = require('fs');
const [SRC, DST, OUT] = process.argv.slice(2);
if (!OUT) { console.error('usage: make_delta.js <original.hbc> <bridge.hbc> <out.delta>'); process.exit(2); }
const src = fs.readFileSync(SRC), dst = fs.readFileSync(DST);

const K = 16, idx = new Map();
for (let i = 0; i + K <= src.length; i += 4) {
  const k = src.toString('latin1', i, i + K);
  if (!idx.has(k)) idx.set(k, i);
}
function ext(s, d) { let n = 0; while (s + n < src.length && d + n < dst.length && src[s + n] === dst[d + n]) n++; return n; }

const ops = [];          // { copy: true, off, len } | { copy: false, start, len } (start in dst)
let i = 0, guess = -1;
while (i < dst.length) {
  let best = 0, bs = -1;
  if (guess >= 0 && guess < src.length) { const n = ext(guess, i); if (n >= 8) { best = n; bs = guess; } }
  if (best < 64 && i + K <= dst.length) {
    for (let b = 0; b < 4 && best < 64; b++) {
      if (i - b < 0) continue;
      const s0 = idx.get(dst.toString('latin1', i - b, i - b + K));
      if (s0 === undefined) continue;
      const s = s0 + b, n = ext(s, i);
      if (n > best) { best = n; bs = s; }
    }
  }
  if (best >= 24) { ops.push({ copy: true, off: bs, len: best }); i += best; guess = bs + best; }
  else {
    const last = ops[ops.length - 1];
    if (last && !last.copy) last.len++; else ops.push({ copy: false, start: i, len: 1 });
    i++; if (guess >= 0) guess++;
  }
}

const HDR = 96, litBase = HDR + ops.length * 16;
const litLen = ops.filter(o => !o.copy).reduce((a, o) => a + o.len, 0);
const blob = Buffer.alloc(litBase + litLen);
blob.writeBigUInt64LE(BigInt(src.length), 0);
blob.writeBigUInt64LE(BigInt(ops.length), 16);
src.copy(blob, 32, 12, 32);
blob.writeBigUInt64LE(BigInt(dst.length), 56);
let lp = litBase;
ops.forEach((o, k) => {
  const p = HDR + k * 16;
  if (o.copy) { blob.writeBigUInt64LE(BigInt(o.off), p); blob.writeBigUInt64LE(BigInt(o.len), p + 8); }
  else {
    blob.writeBigUInt64LE(BigInt(lp), p); blob.writeBigUInt64LE(BigInt(o.len) | (1n << 63n), p + 8);
    dst.copy(blob, lp, o.start, o.start + o.len); lp += o.len;
  }
});

// verify: apply exactly like the detour does
const out = Buffer.alloc(Number(blob.readBigUInt64LE(56)));
let d = 0;
for (let k = 0; k < Number(blob.readBigUInt64LE(16)); k++) {
  const off = Number(blob.readBigUInt64LE(HDR + k * 16));
  const lf = blob.readBigUInt64LE(HDR + k * 16 + 8);
  const lit = (lf >> 63n) === 1n, len = Number(lf & ((1n << 63n) - 1n));
  (lit ? blob : src).copy(out, d, off, off + len); d += len;
}
if (d !== dst.length || !out.equals(dst)) { console.error('make_delta: verification FAILED'); process.exit(1); }
fs.writeFileSync(OUT, blob);
console.log(`wrote ${OUT}: ${blob.length} bytes (${ops.length} ops, ${litLen} literal bytes) -> rebuilds ${dst.length} bytes, verified`);
