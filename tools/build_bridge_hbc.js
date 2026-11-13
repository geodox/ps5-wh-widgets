'use strict';
// Expose closure-local hub registries to globals for the loader prelude, and add
// the small hooks the loader needs (see "PATCHES" below for the full list). One
// table drives every patch, so a new hook is one entry.
//
//   node tools/build_bridge_hbc.js <in.hbc> <out.hbc>
//
// Source: the REA-reconstructed FW 13.20 hub bundle. Function ids are module-index
// order in that bundle; `ADDS` names the strings the loader reads off globalThis.
//
// The order of PATCHES matters: hbc_rebuild.js appends changed function bodies in
// this order, so reordering entries changes the output bytes.
const fs = require('fs');
const { HBC, loadOpcodes } = require('./hbc.js');
const { rebuild } = require('./hbc_rebuild.js');

const IN = process.argv[2] || 'hbc_20f404b30.hbc';
const OUT = process.argv[3] || 'out/bridge.hbc';

// Strings appended to the HBC string table. Index into this list is the string id.
const ADDS = ['__whWidgetMap', '__whEditable', '__whTitles', '__whIcons', '__whDescs', '__wh_lock', '__whRequire', '__whSizeUp', '__whSizeDown', '__whLayoutResize', '__whFind', '__whScrollTo'];

// Every patched function, in output order. `hook` selects the builder:
//   lock     - prepend the __wh_lock guard (Circle/Triangle while a widget is entered)
//   global   - copy a value register into a global before Ret, or at an ip
//   sizeStep - L1/R1 resize: hand the stock step through __whSizeUp/__whSizeDown
//   prefix   - prepend a "call __whX(...) and maybe return/continue" prefix
const PATCHES = [
  { fid: 5916, hook: 'lock' },
  { fid: 19960, hook: 'lock' },
  // F7374 (mod 579): WIDGET_MAP (r1, live at Ret) and the hub's module require
  // (param 3 = r7, at ip 12; lets the loader reach modules 106/77/...).
  { fid: 7374, hook: 'global', inj: [
    { valReg: 0x01, name: '__whWidgetMap', at: null },
    { valReg: 0x07, name: '__whRequire', at: 12 },
  ] },
  // F128 (mod 17): EDITABLE's r3 is reassigned by copyDataProperties after
  // exports.EDITABLE=r3, so inject right after that store (ip 267), not before Ret.
  { fid: 128, hook: 'global', inj: [{ valReg: 0x03, name: '__whEditable', at: 267 }] },
  // Edit-Widgets side list metadata (all `exports.default = r1; Ret`).
  { fid: 5162, hook: 'global', inj: [{ valReg: 0x01, name: '__whTitles', at: null }] },
  { fid: 20067, hook: 'global', inj: [{ valReg: 0x01, name: '__whIcons', at: null }] },
  { fid: 20068, hook: 'global', inj: [{ valReg: 0x01, name: '__whDescs', at: null }] },
  // Resize steps (edit mode L1/R1), right after the stock value is computed:
  //   if (__whSizeUp|__whSizeDown) s = fn(target, s);   [Call3, like stock]
  //   F19931 L1: s = max(1, size-1)   F19932 R1: s = min(FULL, size+1)
  { fid: 19931, hook: 'sizeStep', up: 0, name: '__whSizeDown', at: 46, env: 0, res: 2, s: [1, 3, 4, 3] },
  { fid: 19932, hook: 'sizeStep', up: 1, name: '__whSizeUp', at: 71, env: 2, res: 8, s: [0, 1, 7, 1] },
  // Grid scrollTo (F19985): scrollTo(col) scrolls the minimum to make column `col`
  // visible, which leaves an XL tile's second column off-screen. Adjust the column
  // through __whScrollTo, then continue at stock ip 3 with the adjusted r3.
  { fid: 19985, hook: 'prefix', name: '__whScrollTo', frame: 0, make: scrollToPrefix },
  // Layout resize (F1674): __whLayoutResize handles XL transitions; returning
  // true from it short-circuits the stock resize.
  { fid: 1674, hook: 'prefix', name: '__whLayoutResize', frame: 6, make: layoutResizePrefix },
  // Layout find (F1665): stock size() counts one column, so an XL tile (two full
  // columns) would report 3. __whFind answers for XL tiles.
  { fid: 1665, hook: 'prefix', name: '__whFind', frame: 5, make: layoutFindPrefix },
];

const h = new HBC(IN);
const base = h.header.stringCount;
const funcPatches = [];

const sidOf = name => base + ADDS.indexOf(name);
const str = (reg, name) => {
  const s = sidOf(name);
  return [0x71, reg, s & 0xff, (s >> 8) & 0xff];
};
const bodyOf = fid => {
  const f = h.functions[fid];
  return Buffer.from(h.buf.slice(f.offset, f.offset + f.size));
};

// ---- prefix builders (global guard first, then hook-specific code) ----
function lockPrefix() {
  // if (__wh_lock) return true;   (17 B; r0/r1 are written by each target first)
  const sid = sidOf('__wh_lock');
  return Buffer.from([
    0x30, 0x00,
    ...str(0x01, '__wh_lock'),
    0x47, 0x00, 0x00, 0x01,
    0x90, 0x07, 0x00,
    0x76, 0x00,
    0x5a, 0x00,
  ]);
}
function scrollToPrefix() {
  const sid = sidOf('__whScrollTo');
  return Buffer.from([
    0x30, 0x00,                                   //  0 GetGlobalObject r0
    ...str(0x01, '__whScrollTo'),                 //  2 LoadConstString r1
    0x47, 0x02, 0x00, 0x01,                       //  6 GetByVal r2, r0, r1
    0x90, 0x17, 0x02,                             // 10 JmpFalse +23 (-> 33 stock ip0), r2
    0x6a, 0x03, 0x01,                             // 13 LoadParam r3, 1
    0x29, 0x04, 0x01,                             // 16 GetEnvironment r4, 1
    0x2e, 0x04, 0x04, 0x04,                       // 19 LoadFromEnvironment r4, r4, 4
    0x74, 0x00,                                   // 23 LoadConstUndefined r0
    0x52, 0x03, 0x02, 0x00, 0x03, 0x04,           // 25 Call3 r3, r2, r0, r3, r4
    0x8c, 0x05,                                   // 31 Jmp +5 (-> 36 = stock ip3)
  ]);
}
function layoutResizePrefix() {
  const sid = sidOf('__whLayoutResize');
  return Buffer.from([
    0x30, 0x00,                                   //  0 GetGlobalObject r0
    ...str(0x01, '__whLayoutResize'),             //  2 LoadConstString r1
    0x47, 0x02, 0x00, 0x01,                       //  6 GetByVal r2, r0, r1
    0x90, 0x1c, 0x02,                             // 10 JmpFalse +28 (-> 38), r2
    0x6a, 0x03, 0x01,                             // 13 LoadParam r3, 1  (layout)
    0x6a, 0x04, 0x02,                             // 16 LoadParam r4, 2  (position)
    0x6a, 0x05, 0x03,                             // 19 LoadParam r5, 3  (size)
    0x74, 0x00,                                   // 22 LoadConstUndefined r0
    0x53, 0x01, 0x02, 0x00, 0x03, 0x04, 0x05,     // 24 Call4 r1, r2, r0, r3, r4, r5
    0x90, 0x07, 0x01,                             // 31 JmpFalse +7 (-> 38), r1
    0x74, 0x00,                                   // 34 LoadConstUndefined r0
    0x5a, 0x00,                                   // 36 Ret r0
  ]);
}
function layoutFindPrefix() {
  const sid = sidOf('__whFind');
  return Buffer.from([
    0x30, 0x00,                                   //  0 GetGlobalObject r0
    ...str(0x01, '__whFind'),                     //  2 LoadConstString r1
    0x47, 0x02, 0x00, 0x01,                       //  6 GetByVal r2, r0, r1
    0x90, 0x16, 0x02,                             // 10 JmpFalse +22 (-> 32), r2
    0x6a, 0x03, 0x01,                             // 13 LoadParam r3, 1  (layout)
    0x6a, 0x04, 0x02,                             // 16 LoadParam r4, 2  (id)
    0x74, 0x00,                                   // 19 LoadConstUndefined r0
    0x52, 0x01, 0x02, 0x00, 0x03, 0x04,           // 21 Call3 r1, r2, r0, r3, r4
    0x90, 0x05, 0x01,                             // 27 JmpFalse +5 (-> 32), r1
    0x5a, 0x01,                                   // 30 Ret r1
  ]);
}

// ---- builders ----
// Mid-function insert with jump fix-up: every jump whose span crosses the insert
// point grows by the insert length (operand = first arg; Addr8 or Addr32).
const OPS = loadOpcodes().byName;
function insertWithJumps(fid, at, inj) {
  const f = h.functions[fid];
  const ins = h.disassemble(fid);
  if (f.hasExc) throw new Error('F' + fid + ' has exception handlers');
  if (!ins.some(i => i.ip === at)) throw new Error('F' + fid + ' offset ' + at + ' not an instruction boundary');
  const body = bodyOf(fid);
  for (const i of ins) {
    const def = OPS[i.op];
    if (!def || !def.jump) continue;
    const kind = def.args[0];
    const off = kind === 'Addr8' ? body.readInt8(i.ip + 1) : body.readInt32LE(i.ip + 1);
    const tgt = i.ip + off;
    let n = off;
    if (i.ip < at && tgt >= at) n = off + inj.length;
    else if (i.ip >= at && tgt < at) n = off - inj.length;
    if (n === off) continue;
    if (kind === 'Addr8') { if (n < -128 || n > 127) throw new Error('F' + fid + ' jump at ' + i.ip + ' no longer fits Addr8'); body.writeInt8(n, i.ip + 1); }
    else body.writeInt32LE(n, i.ip + 1);
  }
  return Buffer.concat([body.slice(0, at), inj, body.slice(at)]);
}

function globalBody(p) {
  const f = h.functions[p.fid];
  const ins = h.disassemble(p.fid);
  const body = bodyOf(p.fid);
  const last = ins[ins.length - 1];
  if (last.op !== 'Ret') throw new Error('F' + p.fid + ' not Ret-terminated');
  if (ins.some(i => /^J/.test(i.op) || i.op.startsWith('Switch'))) throw new Error('F' + p.fid + ' has jumps');
  if (f.frameSize <= 14) throw new Error('F' + p.fid + ' frame too small for scratch r13/r14');
  const items = p.inj.map(it => {
    if (it.at == null) {   // value reg must hold exports.default at Ret
      const prev = ins[ins.length - 2];
      if (p.fid !== 7374 && !(prev.op.startsWith('PutById') && prev.args[1] === it.valReg)) throw new Error('F' + p.fid + ' r' + it.valReg + ' is not the stored default');
    }
    const sid = sidOf(it.name);
    const lo = sid & 0xff, hi = (sid >> 8) & 0xff;
    const inj = Buffer.from([0x30, 0x0d, 0x71, 0x0e, lo, hi, 0x48, 0x0d, 0x0e, it.valReg]);
    const cut = (it.at == null) ? (body.length - last.size) : it.at;
    if (it.at != null && !ins.some(i => i.ip === it.at)) throw new Error('F' + p.fid + ' offset ' + it.at + ' not an instruction boundary');
    return { cut, inj };
  });
  let nb = body;
  for (const x of items.sort((a, b) => b.cut - a.cut)) nb = Buffer.concat([nb.slice(0, x.cut), x.inj, nb.slice(x.cut)]);
  return nb;
}

function sizeStepBody(p) {
  const f = h.functions[p.fid];
  if (f.frameSize <= Math.max(...p.s)) throw new Error('F' + p.fid + ' frame too small');
  const sid = sidOf(p.name);
  const [g, k, fn, tg] = p.s;
  const tail = Buffer.from([
    0x2e, tg, p.env, 22,
    0x74, g,
    0x52, p.res, fn, g, tg, p.res,
  ]);
  const head = Buffer.from([
    0x30, g,
    0x71, k, sid & 0xff, (sid >> 8) & 0xff,
    0x47, fn, g, k,
    0x90, 3 + tail.length, fn,
  ]);
  return insertWithJumps(p.fid, p.at, Buffer.concat([head, tail]));
}

function prefixBody(p) {
  const f = h.functions[p.fid];
  h.disassemble(p.fid);
  if (f.hasExc) throw new Error('F' + p.fid + ' has exception handlers');
  if (p.frame && f.frameSize < p.frame) throw new Error('F' + p.fid + ' frame too small');
  return Buffer.concat([p.make(), bodyOf(p.fid)]);
}

for (const p of PATCHES) {
  let newBody;
  if (p.hook === 'lock') {
    const f = h.functions[p.fid];
    h.disassemble(p.fid);
    if (f.hasExc) throw new Error('F' + p.fid + ' has exception handlers');
    if (f.frameSize < 2) throw new Error('F' + p.fid + ' frame too small');
    newBody = Buffer.concat([lockPrefix(), bodyOf(p.fid)]);
    console.log(`F${p.fid}: lock prefix body ${newBody.length - 17}->${newBody.length}`);
  } else if (p.hook === 'global') {
    newBody = globalBody(p);
  } else if (p.hook === 'sizeStep') {
    newBody = sizeStepBody(p);
    console.log(`F${p.fid}: size step at ${p.at} (+${newBody.length - bodyOf(p.fid).length}B) SID=${sidOf(p.name)}`);
  } else if (p.hook === 'prefix') {
    // F19985 must start with LoadParam r3,1 (the column argument).
    if (p.name === '__whScrollTo') {
      const b0 = bodyOf(p.fid).slice(0, 3);
      if (b0[0] !== 0x6a || b0[1] !== 0x03 || b0[2] !== 0x01) throw new Error('F' + p.fid + ' does not start with LoadParam r3,1');
    }
    newBody = prefixBody(p);
    console.log(`F${p.fid}: ${p.name} hook SID=${sidOf(p.name)} body ${newBody.length - p.make().length}->${newBody.length}`);
  }
  funcPatches.push({ fid: p.fid, newBody });
}

const r = rebuild(IN, { adds: ADDS.map(t => ({ text: t, utf16: false, identifier: false })), funcPatches });
fs.writeFileSync(OUT, r.out);
console.log(`wrote ${OUT} len=${r.out.length}`);
