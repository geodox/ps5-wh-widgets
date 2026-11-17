'use strict';
// Cross-firmware function matcher for the Welcome Hub bundle (see FID_MATCH_SPEC.md).
//
//   node tools/fid_match.js <ref_fw1320.hbc> <target.hbc> [out.json]
//
// Finds the 12 patched functions of the 13.20 reference on a target dump by
// content, never by fid, and re-derives each one's patch operands. Output is data
// only; build_bridge_hbc.js consumes it, and any doubt must fail that build.
//
// Matching: every function is reduced to a normalized instruction stream that
// keeps opcodes (width variants folded), registers, string contents and jump
// targets (as instruction indices), and drops numbers that move between builds
// (string/function ids, inline-cache slots, literal-buffer offsets). A target
// matches when exactly one function on the dump has the same stream. Numbers
// that still differ (environment slots, require() module ids, ...) are reported,
// and the ones the patch builders depend on are re-derived from the target.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { HBC } = require('./hbc.js');

// 13.20 ground truth (FID_MATCH_SPEC.md table), in PATCHES order.
const TARGETS = [
  { name: '(lock A)', fid: 5916, hook: 'lock' },
  { name: '(lock B)', fid: 19960, hook: 'lock' },
  { name: '__whWidgetMap', fid: 7374, hook: 'global', inj: [{ name: '__whWidgetMap', valReg: 1, at: null }, { name: '__whRequire', valReg: 7, at: 12 }] },
  { name: '__whEditable', fid: 128, hook: 'global', inj: [{ name: '__whEditable', valReg: 3, at: 267 }] },
  { name: '__whTitles', fid: 5162, hook: 'global', inj: [{ name: '__whTitles', valReg: 1, at: null }] },
  { name: '__whIcons', fid: 20067, hook: 'global', inj: [{ name: '__whIcons', valReg: 1, at: null }] },
  { name: '__whDescs', fid: 20068, hook: 'global', inj: [{ name: '__whDescs', valReg: 1, at: null }] },
  { name: '__whSizeDown', fid: 19931, hook: 'sizeStep', at: 46, env: 0, res: 2, s: [1, 3, 4, 3], slot: 22 },
  { name: '__whSizeUp', fid: 19932, hook: 'sizeStep', at: 71, env: 2, res: 8, s: [0, 1, 7, 1], slot: 22 },
  { name: '__whScrollTo', fid: 19985, hook: 'prefix', frame: 0, envDepth: 1, envSlot: 4 },
  { name: '__whLayoutResize', fid: 1674, hook: 'prefix', frame: 6 },
  { name: '__whFind', fid: 1665, hook: 'prefix', frame: 5 },
];

// Inline-cache slot operand (0-based) for the property-access family.
const CACHE_ARG = { GetById: 2, TryGetById: 2, PutById: 2, TryPutById: 2 };
const baseOp = op => op.replace(/(LongIndex|Long|Short|L)$/, '');

function normalize(h, fid) {
  const f = h.functions[fid];
  const memo = h._norm || (h._norm = new Map());
  if (memo.has(fid)) return memo.get(fid);
  memo.set(fid, undefined);   // in progress: a recursive reference hashes as 'F?'
  const ins = h.disassemble(fid);
  if (f.decodeErrors && f.decodeErrors.length) { memo.set(fid, null); return null; }
  const idx = new Map(ins.map((x, k) => [x.ip, k]));
  const loose = [], nums = [];
  ins.forEach((x, k) => {
    const def = h.opByName[x.op];
    const op = baseOp(x.op);
    const t = [op];
    x.args.forEach((v, a) => {
      const ty = def.args[a];
      if (def.strOps.has(a)) t.push(JSON.stringify(h.strings[v]));
      // A nested closure hashes as its own normalized body, so modules that differ
      // only in their getters (titles vs descriptions) stay distinct.
      else if (def.fnOps.has(a)) { const c = normalize(h, v); t.push(c ? 'F:' + c.key.slice(0, 16) : c === null ? 'F!' : 'F?'); }
      else if (ty === 'Reg8' || ty === 'Reg32') t.push('r' + v);
      else if (ty.startsWith('Addr')) t.push('@' + (idx.get(x.ip + v) - k));
      else if (CACHE_ARG[op] === a || /WithBuffer$/.test(op)) t.push('_');
      else { t.push('#'); nums.push({ k, ip: x.ip, op: x.op, a, v }); }
    });
    if (x.table) t.push('tbl:' + x.table.map(ip => idx.get(ip) - k).join(','));
    loose.push(t.join(' '));
  });
  const key = crypto.createHash('sha1').update(loose.join('\n')).digest('hex');
  const n = { fid, key, loose, nums, ins };
  memo.set(fid, n);
  return n;
}

function index(h) {
  const byKey = new Map();
  for (let fid = 0; fid < h.functions.length; fid++) {
    const n = normalize(h, fid);
    if (!n) continue;
    if (!byKey.has(n.key)) byKey.set(n.key, []);
    byKey.get(n.key).push(fid);
  }
  return byKey;
}

// Fallback for a changed function (e.g. a widget table that gained an entry).
// Shortlist by overlap of string / nested-closure lines among functions of similar
// size, then align instruction streams. Accepted only when the best alignment is
// close (sim >= MIN_SIM), clearly ahead of the runner-up (MARGIN), and every
// instruction a patch is anchored on survives the alignment.
const MIN_SIM = 0.9, MARGIN = 0.05, SHORTLIST = 8;
function shortlist(ref, h, rn) {
  const bag = n => new Set(n.loose.filter(l => l.includes('"') || l.includes('F:')));
  const want = bag(rn);
  const rs = ref.functions[rn.fid].size;
  const out = [];
  for (let fid = 0; fid < h.functions.length; fid++) {
    if (Math.abs(h.functions[fid].size - rs) > rs * 0.5 + 32) continue;
    const n = normalize(h, fid);
    if (!n) continue;
    const got = bag(n);
    let inter = 0;
    for (const x of want) if (got.has(x)) inter++;
    out.push({ fid, j: inter / (want.size + got.size - inter || 1) });
  }
  return out.sort((a, b) => b.j - a.j).slice(0, SHORTLIST);
}

// LCS alignment of two normalized streams: ref index -> target index.
function align(a, b) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const map = new Map(), added = [], removed = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { map.set(i, j); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  return { map, sim: 2 * L[0][0] / (n + m || 1), added, removed };
}

// Registers an instruction reads / writes, for the scratch-register check.
function regUse(h, x) {
  const def = h.opByName[x.op];
  const regs = x.args.map((v, a) => (def.args[a] === 'Reg8' || def.args[a] === 'Reg32') ? v : null);
  const op = baseOp(x.op);
  // Ops whose first register operand is not a destination.
  const noDst = /^(Put|TryPut|Store|Ret|Throw|J|Switch|Debugger|Unreachable|DelBy|AsyncBreakCheck|Profile|CompleteGenerator|SaveGenerator|StartGenerator|ResumeGenerator)/.test(op);
  if (def.jump || noDst) return { reads: regs.filter(r => r !== null), writes: [] };
  return { reads: regs.slice(1).filter(r => r !== null), writes: regs[0] === null ? [] : [regs[0]] };
}

// True when `reg` is written before any read on every path starting at instruction k.
function deadAt(h, ins, k, reg) {
  const byIp = new Map(ins.map((x, i) => [x.ip, i]));
  const seen = new Set();
  const stack = [k];
  while (stack.length) {
    let i = stack.pop();
    for (; i < ins.length; i++) {
      if (seen.has(i)) break;
      seen.add(i);
      const x = ins[i];
      const u = regUse(h, x);
      // Calls read the outgoing argument registers above the frame implicitly; the
      // scratch regs used here are all low, so only explicit operands matter.
      if (u.reads.includes(reg)) return false;
      if (u.writes.includes(reg)) break;
      if (x.op === 'Ret' || x.op === 'Throw') break;
      const tg = x.target !== undefined ? [x.target] : x.table ? [x.defaultTarget, ...x.table] : [];
      for (const t of tg) stack.push(byIp.get(t));
      if (/^Jmp(Long)?$/.test(x.op) || x.table) break;
    }
  }
  return true;
}

// Index of the last instruction before k that writes reg (-1 if none).
function lastWriter(h, ins, k, reg) {
  for (let i = k - 1; i >= 0; i--) if (regUse(h, ins[i]).writes.includes(reg)) return i;
  return -1;
}

// kMap: ref instruction index -> target instruction index (identity for an exact match).
function deriveParams(t, h, fid, ref, rn, tn, kMap) {
  const f = h.functions[fid];
  const ins = tn.ins;
  const fail = msg => { throw new Error(`${t.name} F${fid}: ${msg}`); };
  const kOf = refIp => {       // map a 13.20 ip to the same instruction on the target
    const k = rn.ins.findIndex(x => x.ip === refIp);
    if (k < 0) fail(`ref ip ${refIp} not an instruction`);
    const tk = kMap(k);
    if (tk === undefined) fail(`anchor at ref ip ${refIp} has no aligned instruction`);
    return { k, tk };
  };
  const ipOf = refIp => ins[kOf(refIp).tk].ip;
  if (t.hook === 'lock') {
    if (f.frameSize < 2) fail('frameSize < 2');
    if (f.hasExc) fail('has exception handlers');
    // The 17-byte guard clobbers r0/r1; the stock body must write them before reading.
    for (const r of [0, 1]) if (!deadAt(h, ins, 0, r)) fail(`r${r} live at entry`);
    return { frameSize_ok: true };
  }
  if (t.hook === 'global') {
    const last = ins[ins.length - 1];
    if (last.op !== 'Ret') fail('not Ret-terminated');
    if (ins.some(x => /^J/.test(x.op) || x.op.startsWith('Switch'))) fail('has jumps');
    if (f.frameSize <= 14) fail('frameSize <= 14');
    const inj = t.inj.map(it => {
      if (it.at == null) {
        const prev = ins[ins.length - 2];
        if (!(prev.op.startsWith('PutById') && prev.args[1] === it.valReg)) fail(`r${it.valReg} is not the stored default`);
        return { ...it };
      }
      // The injection point and the instruction before it must both align, and
      // valReg must still get its value from the same (aligned) instruction.
      const { k, tk } = kOf(it.at);
      if (kMap(k - 1) !== tk - 1) fail(`instruction before ref ip ${it.at} is not aligned`);
      const rw = lastWriter(ref, rn.ins, k, it.valReg), tw = lastWriter(h, ins, tk, it.valReg);
      if (rw < 0 || kMap(rw) !== tw) fail(`r${it.valReg} last written by a different instruction before ip ${ins[tk].ip}`);
      return { ...it, at: ins[tk].ip };
    });
    return { inj };
  }
  if (t.hook === 'sizeStep') {
    const at = ipOf(t.at);
    const k = ins.findIndex(x => x.ip === at);
    // The stock clamp is the Call3 right before `at`, writing `res`.
    const call = ins[k - 1];
    if (baseOp(call.op) !== 'Call3' || call.args[0] !== t.res) fail(`ip before ${at} is not Call3 r${t.res}`);
    // The stepper target: LoadFromEnvironment <x>, <env>, <slot> right after `at`.
    const nxt = ins[k];
    if (baseOp(nxt.op) !== 'LoadFromEnvironment' || nxt.args[1] !== t.env) fail(`ip ${at} is not LoadFromEnvironment from r${t.env}`);
    const slot = nxt.args[2];
    const [g, k2, fn, tg] = t.s;
    if (f.frameSize <= Math.max(...t.s)) fail('frame too small for scratch');
    for (const r of new Set([g, k2, fn, tg])) {
      if (r === t.res || r === t.env) fail(`scratch r${r} collides with res/env`);
      if (!deadAt(h, ins, k, r)) fail(`scratch r${r} live at ${at}`);
    }
    return { at, env: t.env, res: t.res, s: t.s, slot };
  }
  if (t.hook === 'prefix') {
    if (f.hasExc) fail('has exception handlers');
    if (t.frame && f.frameSize < t.frame) fail(`frameSize ${f.frameSize} < ${t.frame}`);
    // Prefix asm passes param1->r3, param2->r4, param3->r5 itself; it needs the
    // stock function to take (at least) those params.
    const need = { __whScrollTo: 1, __whLayoutResize: 3, __whFind: 2 }[t.name];
    if (f.paramCount - 1 < need) fail(`paramCount ${f.paramCount} < ${need + 1}`);
    const p = { frame: t.frame, prologue_ok: true };
    if (t.name === '__whScrollTo') {
      const i0 = ins[0];
      if (!(i0.op === 'LoadParam' && i0.args[0] === 3 && i0.args[1] === 1)) fail('first insn is not LoadParam r3, 1');
      // The prefix also passes the scroll ref the stock body reads first:
      // GetEnvironment <e>, <depth>; LoadFromEnvironment <x>, <e>, <slot>.
      const ge = ins[1], lf = ins[2];
      if (ge.op !== 'GetEnvironment' || baseOp(lf.op) !== 'LoadFromEnvironment' || lf.args[1] !== ge.args[0]) fail('scroll ref load not at ip 3');
      p.envDepth = ge.args[1];
      p.envSlot = lf.args[2];
    }
    return p;
  }
  fail('unknown hook');
}

// Human-readable fingerprint check against the spec's role descriptions.
function evidence(t, h, fid, tn) {
  const strs = tn.loose.flatMap(l => (l.match(/"(?:[^"\\]|\\.)*"/g) || []).map(s => JSON.parse(s)));
  const has = s => strs.includes(s);
  const say = [];
  if (t.hook === 'lock') say.push('editing/repeat key handler, ends `LoadConstTrue; Ret`');
  if (t.name === '__whWidgetMap') say.push(`WIDGET_MAP export ${has('WIDGET_MAP')}`, `require=param3 ${tn.ins.some(x => x.op === 'LoadParam' && x.args[0] === 7 && x.args[1] === 3)}`);
  if (t.name === '__whEditable') say.push(`EDITABLE ${has('EDITABLE')}`, `ACCESSIBILITY ${has('ACCESSIBILITY')}`, `FRIENDS_ONLINE ${has('FRIENDS_ONLINE')}`);
  if (t.name === '__whTitles' || t.name === '__whDescs') {
    // Values are getters returning I18nPS.t(<msgid>); report the msgids they use.
    const ids = tn.ins.filter(x => baseOp(x.op) === 'CreateClosure')
      .flatMap(x => normalize(h, x.args[2]).loose.filter(l => /"msgid_/.test(l)).map(l => JSON.parse(l.match(/"(?:[^"\\]|\\.)*"/)[0])));
    say.push(`${ids.length} I18n getters, e.g. ${ids.slice(0, 3).join(', ')}`);
  }
  if (t.name === '__whIcons') say.push(`icon ids ${['accessibility', 'battery_full', 'ps_store'].filter(has).join(',')}`);
  if (t.hook === 'sizeStep') say.push(t.name === '__whSizeDown' ? `Math.max ${has('max')}` : `Math.min ${has('min')} FULL ${has('FULL')}`);
  if (t.name === '__whScrollTo') say.push(`scroll ref .current/.start/.end ${['current', 'start', 'end'].every(has)}`);
  if (t.name === '__whLayoutResize') say.push(`Array.fill ${has('fill')}`);
  if (t.name === '__whFind') say.push(`returns {id,position,size} ${['id', 'position', 'size'].every(has)}`);
  return say.join('; ');
}

// Hub module id -> factory fid, from the global code's module table
// (`CreateClosure r, F; PutOwnByIndex arr, r, <id>`).
function moduleTable(h) {
  const ins = h.disassemble(h.header.globalCodeIndex);
  const lastClosure = new Map(), byId = new Map();
  for (const x of ins) {
    const op = baseOp(x.op);
    if (op === 'CreateClosure') lastClosure.set(x.args[0], x.args[2]);
    else if (op === 'PutOwnByIndex' && lastClosure.has(x.args[1])) byId.set(x.args[2], lastClosure.get(x.args[1]));
  }
  return byId;
}

// Hub modules the loader require()s by id (framework/loader.js); ids move per fw.
const MODULES = [
  { name: 'stockFrame', id_1320: 106 },
  { name: 'stockHeader', id_1320: 77 },
];

// Locate ref function rfid on the target: exact normalized match, else alignment.
function matchFid(ref, h, byKey, rfid) {
  const rn = normalize(ref, rfid);
  const cands = byKey.get(rn.key) || [];
  if (cands.length === 1) {
    const tn = normalize(h, cands[0]);
    const moved = rn.nums.map((n, i) => ({ n, v: tn.nums[i].v })).filter(d => d.n.v !== d.v)
      .map(d => `${d.n.op}@${tn.ins[d.n.k].ip} arg${d.n.a} ${d.n.v}->${d.v}`);
    return { ok: true, fid: cands[0], confidence: 0.99, rn, tn, kMap: k => k,
      evidence: `unique normalized match (${rn.loose.length} insns)` + (moved.length ? `; numbers moved: ${moved.join(', ')}` : '; all numbers identical') };
  }
  if (cands.length > 1) return { ok: false, fid: cands[0], confidence: 0.3, rn, evidence: `ambiguous: ${cands.length} identical candidates F${cands.join(',F')}` };
  const ranked = shortlist(ref, h, rn).map(c => ({ ...c, al: align(rn.loose, normalize(h, c.fid).loose) }))
    .sort((a, b) => b.al.sim - a.al.sim);
  const [best, next] = ranked;
  if (!best) return { ok: false, fid: null, confidence: 0, rn, evidence: 'no candidate' };
  const show = l => l.length > 70 ? l.slice(0, 67) + '...' : l;
  const r = { ok: true, fid: best.fid, confidence: Math.min(0.97, +best.al.sim.toFixed(3)), rn, tn: normalize(h, best.fid), kMap: k => best.al.map.get(k),
    evidence: `aligned match sim=${best.al.sim.toFixed(3)} (runner-up F${next ? next.fid : '-'} ${next ? next.al.sim.toFixed(3) : '-'}); `
      + `+${best.al.added.length}/-${best.al.removed.length} insns [${[...best.al.added.map(l => '+ ' + show(l)), ...best.al.removed.map(l => '- ' + show(l))].join(' | ')}]` };
  const why = best.al.sim < MIN_SIM ? `sim < ${MIN_SIM}` : next && best.al.sim - next.al.sim < MARGIN ? `margin < ${MARGIN}` : null;
  if (why) { r.ok = false; r.confidence = Math.min(r.confidence, 0.85); r.evidence += '; REJECTED: ' + why; }
  return r;
}

function main() {
  const [refPath, tgtPath, outArg] = process.argv.slice(2);
  if (!refPath || !tgtPath) { console.error('usage: node tools/fid_match.js <ref_fw1320.hbc> <target.hbc> [out.json]'); process.exit(1); }
  const ref = new HBC(refPath), h = new HBC(tgtPath);
  const m = /hub_fw(\d+)_/.exec(path.basename(tgtPath));
  const fw = m ? +m[1] : null;
  const out = path.resolve(outArg || path.join(path.dirname(tgtPath), `fid_map_fw${fw}.json`));
  // A dump taken while a bridge was resident is our own output, not the stock hub:
  // matching against it would "confirm" 13.20 fids on any firmware.
  for (const [what, x] of [['reference', ref], ['target', h]]) {
    const wh = x.strings.filter(s => typeof s === 'string' && s.startsWith('__wh'));
    if (wh.length) { console.error(`${what} dump is already patched (has ${wh.join(', ')}); re-dump the stock hub with no wh payload loaded`); process.exit(3); }
  }
  const byKey = index(h);
  const targets = [];
  let ok = true;
  for (const t of TARGETS) {
    const r = matchFid(ref, h, byKey, t.fid);
    const e = { name: t.name, fid_1320: t.fid, hook: t.hook, fid: r.fid, confidence: r.confidence, evidence: r.evidence, params: null };
    if (r.ok) {
      e.evidence += '; ' + evidence(t, h, r.fid, r.tn);
      try { e.params = deriveParams(t, h, r.fid, ref, r.rn, r.tn, r.kMap); } catch (err) { e.confidence = 0.5; e.evidence += '; PARAM CHECK FAILED: ' + err.message; ok = false; }
    } else ok = false;
    targets.push(e);
    console.log(`${t.name.padEnd(18)} F${t.fid} -> F${e.fid}  conf=${e.confidence}  ${e.params ? JSON.stringify(e.params) : 'params=null'}`);
  }
  const refMods = moduleTable(ref), tgtMods = moduleTable(h);
  const tgtIdOf = new Map([...tgtMods].map(([id, fid]) => [fid, id]));
  const modules = MODULES.map(md => {
    const rfid = refMods.get(md.id_1320);
    const r = matchFid(ref, h, byKey, rfid);
    const id = r.ok && tgtIdOf.has(r.fid) ? tgtIdOf.get(r.fid) : null;
    if (id === null) ok = false;
    const e = { name: md.name, id_1320: md.id_1320, fid_1320: rfid, id, fid: r.fid, confidence: id === null ? Math.min(r.confidence, 0.5) : r.confidence, evidence: r.evidence };
    console.log(`${('module ' + md.name).padEnd(18)} ${md.id_1320} (F${rfid}) -> ${id} (F${r.fid})  conf=${e.confidence}`);
    return e;
  });
  const doc = { fw, source_sha1: crypto.createHash('sha1').update(h.buf).digest('hex'), ref_sha1: crypto.createHash('sha1').update(ref.buf).digest('hex'), targets, modules };
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${out}${ok ? '' : '  (UNRESOLVED ENTRIES: build must reject)'}`);
  process.exit(ok ? 0 : 2);
}

if (require.main === module) main();
module.exports = { normalize, moduleTable, TARGETS, MODULES };
