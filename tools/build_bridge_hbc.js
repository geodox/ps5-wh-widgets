'use strict';
// Expose closure-local hub registries to globals for the loader prelude, and add
// the small hooks the loader needs (see "PATCHES" below for the full list). One
// table drives every patch, so a new hook is one entry.
//
//   node tools/build_bridge_hbc.js <in.hbc> <map.json> <out.hbc>
//
// <map.json> is the per-firmware function map from tools/fid_match.js (committed
// as tools/fidmaps/fw<NNNN>.json). Function ids, registers and offsets all move
// between firmware builds, so they come from the map; this file only fixes which
// functions are patched, in what order, and with what code.
// `ADDS` names the strings the loader reads off globalThis.
//
// The order of PATCHES matters: hbc_rebuild.js appends changed function bodies in
// this order, so reordering entries changes the output bytes.
const fs = require('fs');
const { HBC, loadOpcodes } = require('./hbc.js');
const { rebuild } = require('./hbc_rebuild.js');

// Strings appended to the HBC string table. Index into this list is the string id.
const ADDS = ['__whWidgetMap', '__wh_lock', '__whRequire', '__whSizeUp', '__whSizeDown', '__whLayoutResize', '__whFind', '__whScrollTo'];

// Every patched function, in output order, keyed by its map entry `name`. `hook`
// selects the builder:
//   lock     - prepend the __wh_lock guard (Circle/Triangle while a widget is entered)
//   global   - copy a value register into a global before Ret, or at an ip
//   sizeStep - L1/R1 resize: hand the stock step through __whSizeUp/__whSizeDown
//   prefix   - prepend a "call __whX(...) and maybe return/continue" prefix
// The map supplies `fid` and the operands (inj / at, env, res, s, slot / frame,
// envDepth, envSlot); see tools/FID_MATCH_SPEC.md for what each one means.
const PATCHES = [
  // Circle/Back key handlers of the hub tiles.
  { name: '(lock A)', hook: 'lock' },
  { name: '(lock B)', hook: 'lock' },
  // WIDGET_MAP (r1, live at Ret) and the hub's module require (param 3, stored
  // early). Everything else the loader needs (the Edit Widgets tables, the stock
  // frame, the MINI registry, ...) it reaches through __whRequire by module id.
  { name: '__whWidgetMap', hook: 'global' },
  // Resize steps (edit mode L1/R1), right after the stock value is computed:
  //   if (__whSizeUp|__whSizeDown) s = fn(target, s);   [Call3, like stock]
  //   L1: s = max(1, size-1)   R1: s = min(FULL, size+1)
  { name: '__whSizeDown', hook: 'sizeStep' },
  { name: '__whSizeUp', hook: 'sizeStep' },
  // Grid scrollTo(col) scrolls the minimum to make column `col` visible, which
  // leaves an XL tile's second column off-screen. Adjust the column through
  // __whScrollTo, then continue at stock ip 3 with the adjusted r3.
  { name: '__whScrollTo', hook: 'prefix', make: scrollToPrefix },
  // Layout resize: __whLayoutResize handles XL transitions; returning true from
  // it short-circuits the stock resize.
  { name: '__whLayoutResize', hook: 'prefix', make: layoutResizePrefix },
  // Layout find: stock size() counts one column, so an XL tile (two full
  // columns) would report 3. __whFind answers for XL tiles.
  { name: '__whFind', hook: 'prefix', make: layoutFindPrefix },
];

const MIN_CONFIDENCE = 0.9;

// Resolve PATCHES against a map: every entry must be present, confidently
// matched and carry params, or the build stops here (never patch blindly).
function resolvePatches(map) {
  const byName = new Map((map.targets || []).map(t => [t.name, t]));
  return PATCHES.map(p => {
    const t = byName.get(p.name);
    if (!t) throw new Error(`map fw${map.fw}: no entry for ${p.name}`);
    if (t.hook !== p.hook) throw new Error(`map fw${map.fw}: ${p.name} hook ${t.hook} != ${p.hook}`);
    if (!Number.isInteger(t.fid)) throw new Error(`map fw${map.fw}: ${p.name} has no fid`);
    if (!(t.confidence >= MIN_CONFIDENCE) || !t.params)
      throw new Error(`map fw${map.fw}: ${p.name} unresolved (confidence ${t.confidence}); not patching`);
    return { ...t.params, ...p, fid: t.fid };
  });
}

// ---- prefix builders (global guard first, then hook-specific code) ----
// Each takes `ctx` (string ids for the target bundle) and the resolved patch.
function lockPrefix(ctx) {
  // if (__wh_lock) return true;   (17 B; r0/r1 are written by each target first)
  return Buffer.from([
    0x30, 0x00,
    ...ctx.str(0x01, '__wh_lock'),
    0x47, 0x00, 0x00, 0x01,
    0x90, 0x07, 0x00,
    0x76, 0x00,
    0x5a, 0x00,
  ]);
}
function scrollToPrefix(ctx, p) {
  return Buffer.from([
    0x30, 0x00,                                   //  0 GetGlobalObject r0
    ...ctx.str(0x01, '__whScrollTo'),             //  2 LoadConstString r1
    0x47, 0x02, 0x00, 0x01,                       //  6 GetByVal r2, r0, r1
    0x90, 0x17, 0x02,                             // 10 JmpFalse +23 (-> 33 stock ip0), r2
    0x6a, 0x03, 0x01,                             // 13 LoadParam r3, 1
    0x29, 0x04, p.envDepth,                       // 16 GetEnvironment r4, <envDepth>
    0x2e, 0x04, 0x04, p.envSlot,                  // 19 LoadFromEnvironment r4, r4, <envSlot>
    0x74, 0x00,                                   // 23 LoadConstUndefined r0
    0x52, 0x03, 0x02, 0x00, 0x03, 0x04,           // 25 Call3 r3, r2, r0, r3, r4
    0x8c, 0x05,                                   // 31 Jmp +5 (-> 36 = stock ip3)
  ]);
}
function layoutResizePrefix(ctx) {
  return Buffer.from([
    0x30, 0x00,                                   //  0 GetGlobalObject r0
    ...ctx.str(0x01, '__whLayoutResize'),         //  2 LoadConstString r1
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
function layoutFindPrefix(ctx) {
  return Buffer.from([
    0x30, 0x00,                                   //  0 GetGlobalObject r0
    ...ctx.str(0x01, '__whFind'),                 //  2 LoadConstString r1
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

const OPS = loadOpcodes().byName;

// Build the bridge HBC for the hub at `hubPath` using `map`. Returns the bytes.
function buildBridge(hubPath, map, log = console.log) {
  const patches = resolvePatches(map);
  const h = new HBC(hubPath);
  const base = h.header.stringCount;
  const sidOf = name => base + ADDS.indexOf(name);
  const ctx = {
    str: (reg, name) => { const s = sidOf(name); return [0x71, reg, s & 0xff, (s >> 8) & 0xff]; },
  };
  const bodyOf = fid => {
    const f = h.functions[fid];
    return Buffer.from(h.buf.slice(f.offset, f.offset + f.size));
  };

  // Mid-function insert with jump fix-up: every jump whose span crosses the insert
  // point grows by the insert length (operand = first arg; Addr8 or Addr32).
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
      if (it.at == null) {   // value reg must hold the stored export at Ret
        const prev = ins[ins.length - 2];
        if (!(prev.op.startsWith('PutById') && prev.args[1] === it.valReg)) throw new Error('F' + p.fid + ' r' + it.valReg + ' is not the stored default');
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
      0x2e, tg, p.env, p.slot,
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
    return Buffer.concat([p.make(ctx, p), bodyOf(p.fid)]);
  }

  const funcPatches = [];
  for (const p of patches) {
    let newBody;
    if (p.hook === 'lock') {
      const f = h.functions[p.fid];
      h.disassemble(p.fid);
      if (f.hasExc) throw new Error('F' + p.fid + ' has exception handlers');
      if (f.frameSize < 2) throw new Error('F' + p.fid + ' frame too small');
      newBody = Buffer.concat([lockPrefix(ctx), bodyOf(p.fid)]);
      log(`F${p.fid}: lock prefix body ${newBody.length - 17}->${newBody.length}`);
    } else if (p.hook === 'global') {
      newBody = globalBody(p);
    } else if (p.hook === 'sizeStep') {
      newBody = sizeStepBody(p);
      log(`F${p.fid}: size step at ${p.at} (+${newBody.length - bodyOf(p.fid).length}B) SID=${sidOf(p.name)}`);
    } else if (p.hook === 'prefix') {
      // scrollTo must start with LoadParam r3,1 (the column argument).
      if (p.name === '__whScrollTo') {
        const b0 = bodyOf(p.fid).slice(0, 3);
        if (b0[0] !== 0x6a || b0[1] !== 0x03 || b0[2] !== 0x01) throw new Error('F' + p.fid + ' does not start with LoadParam r3,1');
      }
      newBody = prefixBody(p);
      log(`F${p.fid}: ${p.name} hook SID=${sidOf(p.name)} body ${newBody.length - p.make(ctx, p).length}->${newBody.length}`);
    }
    funcPatches.push({ fid: p.fid, newBody });
  }

  return rebuild(hubPath, { adds: ADDS.map(t => ({ text: t, utf16: false, identifier: false })), funcPatches }).out;
}

module.exports = { buildBridge, PATCHES };

if (require.main === module) {
  const [IN, MAP, OUT] = process.argv.slice(2);
  if (!OUT) { console.error('usage: build_bridge_hbc.js <in.hbc> <map.json> <out.hbc>'); process.exit(2); }
  const out = buildBridge(IN, JSON.parse(fs.readFileSync(MAP, 'utf8')));
  fs.writeFileSync(OUT, out);
  console.log(`wrote ${OUT} len=${out.length}`);
}
