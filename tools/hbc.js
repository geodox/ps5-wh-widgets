'use strict';
// Hermes bytecode (HBC) v89 parser + disassembler.
// Opcode table is generated from hermes/BytecodeList.def (non-WASM opcodes only).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;  // tools/hermes/*.def (Hermes 0.11 / HBC v89)
const SIZES = { Reg8: 1, Reg32: 4, UInt8: 1, UInt16: 2, UInt32: 4, Addr8: 1, Addr32: 4, Imm32: 4, Double: 8 };

function loadOpcodes() {
  let def = fs.readFileSync(path.join(ROOT, 'hermes', 'BytecodeList.def'), 'utf8');
  def = def.replace(/^#ifdef HERMES_RUN_WASM[\s\S]*?^#endif/m, '');
  const ops = [];
  const re = /^DEFINE_(OPCODE|JUMP)_(\d)\((\w+)(?:,\s*([^)]*))?\)/gm;
  let m;
  while ((m = re.exec(def))) {
    if (m[1] === 'JUMP') {
      const rest = { 1: [], 2: ['Reg8'], 3: ['Reg8', 'Reg8'] }[m[2]];
      ops.push({ name: m[3], args: ['Addr8', ...rest], jump: true });
      ops.push({ name: m[3] + 'Long', args: ['Addr32', ...rest], jump: true });
    } else {
      const args = m[4] ? m[4].split(',').map(s => s.trim()) : [];
      ops.push({ name: m[3], args });
    }
  }
  const byName = {};
  ops.forEach((o, i) => { o.code = i; o.size = 1 + o.args.reduce((a, t) => a + SIZES[t], 0); o.strOps = new Set(); o.fnOps = new Set(); o.bigOps = new Set(); byName[o.name] = o; });
  for (const [kind, key] of [['STRING', 'strOps'], ['FUNCTION', 'fnOps'], ['BIGINT', 'bigOps']]) {
    const r = new RegExp(`^OPERAND_${kind}_ID\\((\\w+),\\s*(\\d+)\\)`, 'gm');
    while ((m = r.exec(def))) byName[m[1]][key].add(+m[2] - 1);
  }
  return { ops, byName };
}

function loadBuiltins() {
  const src = fs.readFileSync(path.join(ROOT, 'hermes', 'Builtins.def'), 'utf8');
  const out = [];
  const re = /^(BUILTIN_METHOD|PRIVATE_BUILTIN|JS_BUILTIN)\((\w+)(?:,\s*(\w+))?\)/gm;
  let m;
  while ((m = re.exec(src))) out.push({ kind: m[1], obj: m[2], name: m[3] || null });
  return out;
}

class HBC {
  constructor(file) {
    const b = this.buf = fs.readFileSync(file);
    const { ops, byName } = loadOpcodes();
    this.ops = ops; this.opByName = byName;
    this.builtins = loadBuiltins();
    let o = 0;
    const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
    const magic = b.readBigUInt64LE(0); o = 8;
    if (magic !== 0x1F1903C103BC1FC6n) throw new Error('bad magic');
    const h = this.header = { version: u32() };
    h.sourceHash = b.slice(o, o + 20).toString('hex'); o += 20;
    for (const k of ['fileLength', 'globalCodeIndex', 'functionCount', 'stringKindCount', 'identifierCount', 'stringCount',
      'overflowStringCount', 'stringStorageSize', 'bigIntCount', 'bigIntStorageSize', 'regExpCount', 'regExpStorageSize',
      'arrayBufferSize', 'objKeyBufferSize', 'objValueBufferSize', 'segmentID', 'cjsModuleCount', 'functionSourceCount', 'debugInfoOffset'])
      h[k] = u32();
    h.options = b[o];
    if (h.version !== 89) throw new Error('expected v89, got ' + h.version);
    let pos = 128;
    const sect = n => { pos = (pos + 3) & ~3; const s = pos; pos += n; return s; };
    const S = this.sect = {};
    S.funcHeaders = sect(h.functionCount * 16);
    S.stringKinds = sect(h.stringKindCount * 4);
    S.identHashes = sect(h.identifierCount * 4);
    S.stringTable = sect(h.stringCount * 4);
    S.overflowStrings = sect(h.overflowStringCount * 8);
    S.stringStorage = sect(h.stringStorageSize);
    S.arrayBuffer = sect(h.arrayBufferSize);
    S.objKeyBuffer = sect(h.objKeyBufferSize);
    S.objValueBuffer = sect(h.objValueBufferSize);
    S.bigIntTable = sect(h.bigIntCount * 8);
    S.bigIntStorage = sect(h.bigIntStorageSize);
    S.regExpTable = sect(h.regExpCount * 8);
    S.regExpStorage = sect(h.regExpStorageSize);
    S.cjsModules = sect(h.cjsModuleCount * 8);
    S.functionSources = sect(h.functionSourceCount * 8);
    S.end = pos;
    this._parseStrings();
    this._parseFunctions();
    this.regexps = [];
    for (let i = 0; i < h.regExpCount; i++) {
      const off = b.readUInt32LE(S.regExpTable + 8 * i), len = b.readUInt32LE(S.regExpTable + 8 * i + 4);
      this.regexps.push({ off, len });
    }
    this.functionSources = new Map();
    for (let i = 0; i < h.functionSourceCount; i++)
      this.functionSources.set(b.readUInt32LE(S.functionSources + 8 * i), b.readUInt32LE(S.functionSources + 8 * i + 4));
  }

  _parseStrings() {
    const b = this.buf, h = this.header, S = this.sect;
    this.stringKinds = [];
    for (let i = 0; i < h.stringKindCount; i++) {
      const w = b.readUInt32LE(S.stringKinds + 4 * i);
      this.stringKinds.push({ count: w & 0x7fffffff, kind: (w >>> 31) ? 'Identifier' : 'String' });
    }
    const strings = this.strings = new Array(h.stringCount);
    this.stringIsUTF16 = new Uint8Array(h.stringCount);
    for (let i = 0; i < h.stringCount; i++) {
      const w = b.readUInt32LE(S.stringTable + 4 * i);
      const utf16 = w & 1;
      let off = (w >>> 1) & 0x7fffff, len = w >>> 24;
      if (len === 255) { const oe = S.overflowStrings + 8 * off; off = b.readUInt32LE(oe); len = b.readUInt32LE(oe + 4); }
      const start = S.stringStorage + off;
      if (utf16) {
        let s = '';
        for (let k = 0; k < len; k++) s += String.fromCharCode(b.readUInt16LE(start + 2 * k)); // keep lone surrogates exact
        strings[i] = s;
      } else strings[i] = b.latin1Slice(start, start + len);
      this.stringIsUTF16[i] = utf16;
    }
  }

  _parseFunctions() {
    const b = this.buf, h = this.header, S = this.sect;
    const fns = this.functions = new Array(h.functionCount);
    for (let i = 0; i < h.functionCount; i++) {
      const base = S.funcHeaders + 16 * i;
      const w0 = b.readUInt32LE(base), w1 = b.readUInt32LE(base + 4), w2 = b.readUInt32LE(base + 8), w3 = b.readUInt32LE(base + 12);
      let flags = w3 >>> 24;
      let f;
      if ((flags >> 5) & 1) {
        const lo = ((w2 & 0x1ffffff) << 16) | (w0 & 0xffff);
        const L = lo >>> 0;
        f = {
          offset: b.readUInt32LE(L), paramCount: b.readUInt32LE(L + 4), size: b.readUInt32LE(L + 8),
          nameId: b.readUInt32LE(L + 12), infoOffset: b.readUInt32LE(L + 16), frameSize: b.readUInt32LE(L + 20),
          envSize: b.readUInt32LE(L + 24), largeHeaderAt: L,
        };
        flags = b[L + 30];
        f.infoBase = L + 31; // exception table follows the large header
      } else {
        f = {
          offset: w0 & 0x1ffffff, paramCount: w0 >>> 25, size: w1 & 0x7fff, nameId: w1 >>> 15,
          infoOffset: w2 & 0x1ffffff, frameSize: w2 >>> 25, envSize: w3 & 0xff,
        };
        f.infoBase = f.infoOffset;
      }
      f.id = i;
      const smallOverflowed = !!((w3 >>> 29) & 1);
      f.flags = flags;
      f.prohibitInvoke = flags & 3; f.strict = !!((flags >> 2) & 1);
      f.hasExc = !!((flags >> 3) & 1); f.hasDebug = !!((flags >> 4) & 1); f.overflowed = smallOverflowed;
      f.name = this.strings[f.nameId];
      f.handlers = [];
      if (f.hasExc) {
        const ip = (f.infoBase + 3) & ~3;
        const n = b.readUInt32LE(ip);
        for (let k = 0; k < n; k++)
          f.handlers.push({ start: b.readUInt32LE(ip + 4 + 12 * k), end: b.readUInt32LE(ip + 8 + 12 * k), target: b.readUInt32LE(ip + 12 + 12 * k) });
      }
      fns[i] = f;
    }
  }

  // Decode instructions; jump tables (from SwitchImm) are treated as data.
  disassemble(fi) {
    const f = this.functions[fi], b = this.buf, ops = this.ops;
    if (f.insns) return f.insns;
    const insns = [], end = f.offset + f.size;
    let p = f.offset, dataStart = end;
    const errors = [];
    while (p < dataStart) {
      const code = b[p], op = ops[code];
      if (!op) { errors.push(`bad opcode ${code} at ${p - f.offset}`); break; }
      if (p + op.size > end) { errors.push(`truncated ${op.name} at ${p - f.offset}`); break; }
      let q = p + 1; const a = [];
      for (const t of op.args) {
        let v;
        switch (t) {
          case 'Reg8': case 'UInt8': v = b[q]; break;
          case 'Addr8': v = b.readInt8(q); break;
          case 'UInt16': v = b.readUInt16LE(q); break;
          case 'Reg32': case 'UInt32': v = b.readUInt32LE(q); break;
          case 'Addr32': case 'Imm32': v = b.readInt32LE(q); break;
          case 'Double': v = b.readDoubleLE(q); break;
        }
        a.push(v); q += SIZES[t];
      }
      const ins = { ip: p - f.offset, op: op.name, code, args: a, size: op.size };
      if (op.jump) ins.target = ins.ip + a[0];
      if (op.name === 'SwitchImm') {
        const tbl = (p + a[1] + 3) & ~3;
        const n = a[4] - a[3] + 1;
        ins.defaultTarget = ins.ip + a[2];
        ins.table = [];
        for (let k = 0; k < n; k++) ins.table.push(ins.ip + b.readInt32LE(tbl + 4 * k));
        if (tbl < dataStart) dataStart = tbl;
      }
      insns.push(ins);
      p = q;
    }
    if (p !== dataStart) errors.push(`decode ended at ${p - f.offset}, expected ${dataStart - f.offset}`);
    const starts = new Set(insns.map(i => i.ip));
    for (const i of insns) {
      const tg = i.target !== undefined ? [i.target] : i.table ? [i.defaultTarget, ...i.table] : [];
      for (const t of tg) if (!starts.has(t)) errors.push(`${i.op}@${i.ip} -> ${t} not an instruction`);
    }
    for (const hd of f.handlers) for (const t of [hd.start, hd.target]) if (!starts.has(t)) errors.push(`handler ${t} not an instruction`);
    f.insns = insns; f.decodeErrors = errors;
    return insns;
  }

  // Serialized literal buffer -> array of {t, v}
  readLiterals(which, offset, count) {
    const b = this.buf;
    let p = { array: this.sect.arrayBuffer, key: this.sect.objKeyBuffer, value: this.sect.objValueBuffer }[which] + offset;
    const out = [];
    while (out.length < count) {
      const tag = b[p++];
      let n;
      if (tag & 0x80) n = ((tag & 0x0f) << 8) | b[p++]; else n = tag & 0x0f;
      const t = (tag >> 4) & 7;
      for (let k = 0; k < n && out.length < count; k++) {
        switch (t) {
          case 0: out.push({ t: 'null' }); break;
          case 1: out.push({ t: 'bool', v: true }); break;
          case 2: out.push({ t: 'bool', v: false }); break;
          case 3: out.push({ t: 'num', v: b.readDoubleLE(p) }); p += 8; break;
          case 4: out.push({ t: 'str', v: this.strings[b.readUInt32LE(p)] }); p += 4; break;
          case 5: out.push({ t: 'str', v: this.strings[b.readUInt16LE(p)] }); p += 2; break;
          case 6: out.push({ t: 'str', v: this.strings[b[p]] }); p += 1; break;
          case 7: out.push({ t: 'num', v: b.readInt32LE(p) }); p += 4; break;
        }
      }
    }
    return out;
  }

  builtinName(i) {
    const x = this.builtins[i];
    return x ? (x.name ? `${x.obj}.${x.name}` : x.obj) : `builtin#${i}`;
  }

  fmtInsn(f, ins) {
    const op = this.opByName[ins.op];
    const parts = ins.args.map((v, k) => {
      const t = op.args[k];
      if (op.strOps.has(k)) return `"${JSON.stringify(this.strings[v]).slice(1, -1)}"`;
      if (op.fnOps.has(k)) return `F${v}`;
      if (t === 'Reg8' || t === 'Reg32') return `r${v}`;
      if (t.startsWith('Addr')) return `L${ins.ip + v}`;
      return String(v);
    });
    let s = `${String(ins.ip).padStart(6)}: ${ins.op} ${parts.join(', ')}`;
    if (ins.op.startsWith('CallBuiltin') || ins.op === 'GetBuiltinClosure') s += `  ; ${this.builtinName(ins.args[1])}`;
    if (ins.table) s += `  ; table=[${ins.table.map(t => 'L' + t).join(',')}] default=L${ins.defaultTarget}`;
    return s;
  }
}

module.exports = { HBC, loadOpcodes, loadBuiltins };

// CLI:  node tools/hbc.js <file.hbc> dis <fid> [fid...]   disassemble functions
//       node tools/hbc.js <file.hbc> info                 header summary
if (require.main === module) {
  const [file, cmd, ...rest] = process.argv.slice(2);
  if (!file || !cmd) { console.log('usage: node hbc.js <file.hbc> dis <fid...> | info'); process.exit(1); }
  const h = new HBC(file);
  if (cmd === 'info') {
    console.log(`functions=${h.functions.length} strings=${h.header.stringCount}`);
  } else if (cmd === 'dis') {
    for (const a of rest) {
      const fid = parseInt(String(a).replace(/^F/i, ''), 10);
      const f = h.functions[fid];
      const ins = h.disassemble(fid);
      console.log(`== F${fid}  offset=${f.offset} size=${f.size} params=${f.paramCount} frame=${f.frameSize}`);
      for (const i of ins) console.log(h.fmtInsn(f, i));
      if (f.decodeErrors && f.decodeErrors.length) console.log('  ! ' + f.decodeErrors.join('; '));
    }
  }
}
