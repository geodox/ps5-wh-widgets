'use strict';
// Welcome Hub module index: one record per hub module, plus a cross-firmware xref.
//
//   node tools/hub_index.js <hub.hbc> [--out <dir>]
//   node tools/hub_index.js <hub.hbc> --ref <ref.hbc> [--out <dir>]
//
// Writes <dir>/modules_fw<NNNN>.json for <hub.hbc> (and for <ref.hbc> when given),
// and with --ref also <dir>/xref_<ref fw>_<fw>.json mapping every ref module to a
// module on <hub.hbc>. <dir> defaults to dumps/hub-atlas.
//
// The output is derived from decrypted Sony bytecode: it stays in dumps/ (git-
// ignored) and is never committed. This script only reads the dumps.
//
// Module factories are `function (module, exports, require)`; `require(<id>)` takes
// the hub module id. Everything here is static and heuristic: `exports` kinds,
// `role` and `area` are labels to find code by, not facts about it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HBC } = require('./hbc.js');
const { normalize, moduleTable } = require('./fid_match.js');

const baseOp = op => op.replace(/(LongIndex|Long|Short|L)$/, '');

// ---------------------------------------------------------------------------
// Closure trees

// Child closures created by each function (CreateClosure family operand F).
function childMap(h) {
  const kids = new Map();
  for (let fid = 0; fid < h.functions.length; fid++) {
    const out = [];
    let ins;
    try { ins = h.disassemble(fid); } catch (e) { ins = []; }
    for (const x of ins) {
      const def = h.opByName[x.op];
      x.args.forEach((v, a) => { if (def.fnOps.has(a)) out.push(v); });
    }
    kids.set(fid, out);
  }
  return kids;
}

function tree(kids, fid, seen = new Set()) {
  if (seen.has(fid)) return seen;
  seen.add(fid);
  for (const c of kids.get(fid) || []) tree(kids, c, seen);
  return seen;
}

// String operands plus strings in object/array literal buffers.
function fnStrings(h, fid) {
  const s = new Set();
  for (const x of h.disassemble(fid)) {
    const def = h.opByName[x.op];
    x.args.forEach((v, a) => { if (def.strOps.has(a)) s.add(h.strings[v]); });
    const b = baseOp(x.op);
    try {
      if (b === 'NewObjectWithBuffer') {
        for (const l of h.readLiterals('key', x.args[3], x.args[2])) if (l.t === 'str') s.add(l.v);
        for (const l of h.readLiterals('value', x.args[4], x.args[2])) if (l.t === 'str') s.add(l.v);
      } else if (b === 'NewArrayWithBuffer') {
        for (const l of h.readLiterals('array', x.args[3], x.args[2])) if (l.t === 'str') s.add(l.v);
      }
    } catch (e) { /* malformed buffer reference: skip */ }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Abstract interpretation of a module's closure tree (straight-line, no joins):
// enough to see exports, their kinds, getters, and require(<const>) calls.

const LOAD_NUM = new Set(['LoadConstUInt8', 'LoadConstInt', 'LoadConstZero', 'LoadConstDouble']);
const CALLS = /^(Call|Call1|Call2|Call3|Call4|CallLong|Construct|ConstructLong)$/;
const KIND_OF_CALL = {
  memo: 'component', forwardRef: 'component', createContext: 'context', create: 'value',
  atom: 'atom', atomWithDefault: 'atom', atomFamily: 'atom', selectAtom: 'atom', requireNativeComponent: 'native-component',
  createStackNavigator: 'navigator', createNavigator: 'navigator', withNavigation: 'component',
};

function analyzeModule(h, factory) {
  const requires = new Set();
  const uses = new Map();         // required module id -> Set of property paths read on it
  const lazy = new Set();         // ids loaded through import() (__webpack_require__.t)
  const exportsMap = new Map();   // name -> {kind, ...}
  let moduleExports = null;       // value state assigned to module.exports
  const visited = new Set();

  // states: {k:'module'|'exports'|'require'|'num'|'str'|'const'|'fn'|'prop'|'mod'|'call'|'obj'|'arr'|'env', ...}
  function run(fid, chain) {
    if (visited.has(fid)) return;
    visited.add(fid);
    const R = new Map();
    const get = r => R.get(r) || { k: '?' };
    const later = [];
    const isFactory = fid === factory;
    let ins;
    try { ins = h.disassemble(fid); } catch (e) { return; }
    for (const x of ins) {
      const op = baseOp(x.op), a = x.args;
      const s = i => h.strings[a[i]];
      switch (true) {
        case op === 'LoadParam':
          R.set(a[0], isFactory ? ({ 1: { k: 'module' }, 2: { k: 'exports' }, 3: { k: 'require' } }[a[1]] || { k: '?' }) : { k: '?' });
          break;
        case LOAD_NUM.has(op): R.set(a[0], { k: 'num', v: op === 'LoadConstZero' ? 0 : a[1] }); break;
        case op === 'LoadConstString': R.set(a[0], { k: 'str', v: s(1) }); break;
        case /^LoadConst(Undefined|Null|True|False|Empty)/.test(op): R.set(a[0], { k: 'const', v: op.slice(9).toLowerCase() }); break;
        case op === 'Mov': R.set(a[0], get(a[1])); break;
        case /^Create(Generator|Async)?Closure$/.test(op) || op === 'CreateGenerator': {
          later.push({ fid: a[2], env: get(a[1]) });   // read the env operand before dst overwrites it
          R.set(a[0], { k: 'fn', fid: a[2] });
          break;
        }
        case op === 'CreateEnvironment': R.set(a[0], { k: 'env', chain: [new Map(), ...chain] }); break;
        case op === 'GetEnvironment': R.set(a[0], { k: 'env', chain: chain.slice(a[1]) }); break;
        case op === 'StoreToEnvironment' || op === 'StoreNPToEnvironment': {
          const e = get(a[0]);
          if (e.k === 'env' && e.chain[0]) e.chain[0].set(a[1], get(a[2]));
          break;
        }
        case op === 'LoadFromEnvironment': {
          const e = get(a[1]);
          R.set(a[0], e.k === 'env' && e.chain[0] && e.chain[0].has(a[2]) ? e.chain[0].get(a[2]) : { k: '?' });
          break;
        }
        case op === 'GetById' || op === 'TryGetById' || op === 'GetByIdShort': {
          const of = get(a[1]), name = s(3);
          let st = { k: 'prop', name, of };
          // Lazy import(): __webpack_require__.t(id, mode), usually via .bind(null, id, mode).
          if (of.k === 'require' && name === 't') st = { k: 'req_t' };
          else if (of.k === 'req_t' && name === 'bind') st = { k: 'req_t_bind' };
          else if (of.k === 'mod' || of.k === 'dll') st = { k: 'prop', name, of, mod: of.id, path: name };
          else if (of.k === 'prop' && of.mod !== undefined && of.path.split('.').length < 2) st = { k: 'prop', name, of, mod: of.mod, path: of.path + '.' + name };
          if (st.mod !== undefined) {
            if (!uses.has(st.mod)) uses.set(st.mod, new Set());
            uses.get(st.mod).add(st.path);
          }
          R.set(a[0], st);
          break;
        }
        case op === 'NewObject' || op === 'NewObjectWithParent' || op === 'NewObjectWithBuffer': R.set(a[0], { k: 'obj', keys: new Map() }); break;
        case op === 'NewArray' || op === 'NewArrayWithBuffer': R.set(a[0], { k: 'arr' }); break;
        case op === 'PutNewOwnById' || op === 'PutNewOwnByIdShort' || op === 'PutNewOwnNEById': {
          const o = get(a[0]);
          if (o.k === 'obj') o.keys.set(s(2), get(a[1]));
          break;
        }
        case op === 'PutOwnGetterSetterByVal': {
          const o = get(a[0]), n = get(a[1]);
          if (o.k === 'obj' && n.k === 'str') o.keys.set(n.v, { k: 'getter', fn: get(a[2]) });
          break;
        }
        case op === 'PutById' || op === 'TryPutById': {
          const o = get(a[0]), v = get(a[1]), name = s(3);
          if (o.k === 'exports') exportsMap.set(name, v);
          else if (o.k === 'module' && name === 'exports') moduleExports = v;
          break;
        }
        case CALLS.test(op): {
          // Call<N> dst, callee, this, args... ; Call dst, callee, argc ; Construct likewise
          const callee = get(a[1]);
          const args = /\d$/.test(op) ? a.slice(3).map(get) : [];
          let res = { k: 'call', fn: callee.k === 'prop' ? callee.name : null };
          if (callee.k === 'require' && args[0] && args[0].k === 'num') { requires.add(args[0].v); res = { k: 'mod', id: args[0].v }; }
          else if (callee.k === 'req_t' && args[0] && args[0].k === 'num') { requires.add(args[0].v); lazy.add(args[0].v); }
          else if (callee.k === 'req_t_bind' && args[1] && args[1].k === 'num') { requires.add(args[1].v); lazy.add(args[1].v); }
          else if (callee.k === 'mod' && args[0] && args[0].k === 'mod') res = { k: 'mod', id: args[0].id };   // interop helper
          else if (callee.k === 'mod' && args[0] && args[0].k === 'str') res = { k: 'dll', id: callee.id, key: args[0].v };   // DllReference: require(base_dll)('<hash>')
          else if (callee.k === 'prop' && callee.name === 'defineProperty' && args.length >= 3) {
            // Object.defineProperty(exports, 'name', {get} | {value})
            const [obj, n, d] = args;
            if (obj.k === 'exports' && n.k === 'str' && n.v !== '__esModule' && d.k === 'obj') {
              exportsMap.set(n.v, d.keys.has('get') ? { k: 'getter', fn: d.keys.get('get') } : (d.keys.get('value') || { k: '?' }));
            }
          }
          R.set(a[0], res);
          break;
        }
        default: {
          // Any other instruction that writes its first register operand: unknown value.
          const def = h.opByName[x.op];
          if (def.args[0] === 'Reg8' || def.args[0] === 'Reg32') {
            if (!/^(Put|Store|Ret|Throw|J|Switch|Debugger|Unreachable|DelBy|AsyncBreakCheck|Profile|CompleteGenerator|SaveGenerator|StartGenerator|ResumeGenerator)/.test(op))
              R.set(a[0], { k: '?' });
          }
        }
      }
    }
    for (const c of later) run(c.fid, c.env.k === 'env' ? c.env.chain : []);
  }
  run(factory, []);

  // Turn value states into export records.
  const describe = (name, v) => {
    const e = { name, kind: 'value' };
    if (!v) return e;
    switch (v.k) {
      case 'fn': {
        const fn = h.functions[v.fid];
        e.kind = /^[A-Z]/.test(name) || /^[A-Z]/.test(fn.name || '') ? 'function (component?)' : 'function';
        e.fid = v.fid;
        break;
      }
      case 'getter': {
        e.kind = 'getter';
        if (v.fn && v.fn.k === 'fn') {
          e.fid = v.fn.fid;
          const from = getterSource(h, v.fn.fid);
          if (from !== null) e.from = from;
        }
        break;
      }
      case 'call': e.kind = KIND_OF_CALL[v.fn] || (v.fn ? `value (${v.fn}())` : 'value'); break;
      case 'mod': e.kind = 'module'; e.from = v.id; break;
      case 'dll': e.kind = 'dll module'; e.from = v.id; e.dll = v.key; break;
      case 'obj': e.kind = 'object'; break;
      case 'arr': e.kind = 'array'; break;
      case 'num': e.kind = 'constant'; e.value = v.v; break;
      case 'str': e.kind = 'constant'; e.value = v.v; break;
      case 'const': e.kind = 'constant'; e.value = v.v; break;
      case 'prop': e.kind = 'value (property)'; e.prop = v.name; break;
    }
    return e;
  };
  const exps = [];
  for (const [n, v] of exportsMap) {
    if (v.k === 'const' && v.v === 'undefined' && exps.some(x => x.name === n)) continue;
    exps.push(describe(n, v));
  }
  // `exports.x = void 0` placeholders followed by a real assignment: keep the last.
  const byName = new Map(); for (const e of exps) byName.set(e.name, e);
  let list = [...byName.values()];
  let shape = 'exports';
  if (moduleExports) {
    if (moduleExports.k === 'obj') { shape = 'module.exports = {...}'; list = [...moduleExports.keys].map(([n, v]) => describe(n, v)); }
    else { shape = 'module.exports = value'; list = [describe('module.exports', moduleExports)]; }
  }
  const usesObj = {};
  for (const id of [...uses.keys()].sort((x, y) => x - y)) usesObj[id] = [...uses.get(id)].sort();
  const out = { requires: [...requires].sort((x, y) => x - y), uses: usesObj, exports: list, shape };
  if (lazy.size) out.lazy_requires = [...lazy].sort((x, y) => x - y);
  return out;
}

// A getter `get X() { return require(N)... }`: the module id it reads, if any.
function getterSource(h, fid) {
  let ins;
  try { ins = h.disassemble(fid); } catch (e) { return null; }
  if (ins.length > 12) return null;
  let num = null;
  for (const x of ins) {
    const op = baseOp(x.op);
    if (LOAD_NUM.has(op)) num = op === 'LoadConstZero' ? 0 : x.args[1];
    if (/^Call\d$/.test(op) && num !== null) return num;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Distinctive strings, roles and areas

function interesting(s) {
  if (typeof s !== 'string' || s.length < 3 || s.length > 120) return 0;
  if (/^msgid_/.test(s)) return 5;
  if (/^Vsh|NativeModule|^RCT|^Sce/.test(s)) return 5;
  if (/^[a-z][a-z0-9+.-]*:[^\s]/i.test(s) && !/^(get|set) /.test(s)) return 4;   // URIs / scheme:path
  if (/^NPXS\d+|^CUSA|^PPSA/.test(s)) return 4;
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(s)) return 3;              // ENUM_LIKE
  if (/^[A-Z][a-zA-Z0-9]+$/.test(s)) return 2;                // DisplayName-like
  if (/\s/.test(s) && s.length > 12) return 2;                // messages
  if (/^[a-z][a-zA-Z0-9]+$/.test(s)) return 1;
  return 1;
}

// Areas. Seeds are content anchors (strings, export names, how importers use a
// module), never ids, so they carry to other firmware builds. Every other module
// takes the area of the seeds that reach it through require() edges without passing
// another seed: one area -> that area, several -> 'shared'. First matching seed wins.
//   r = record, s = closure-tree strings, x = export names, c = context
const has = (s, ...l) => l.every(t => s.has(t));
const any = (s, re) => { for (const t of s) if (typeof t === 'string' && re.test(t)) return true; return false; };
const SEEDS = [
  ['modsys', 'webpack DllReference shim (base_dll)', (r) => r.exports.length === 1 && !!r.exports[0].dll],
  ['modsys', 'base_dll handle', (r, s) => s.has('base_dll') && r.size < 64],
  ['modsys', 'Babel runtime helper', (r, s, x, c) => c.helper.has(r.id)],
  ['modsys', 'Babel runtime helpers (bundle)', (r, s) => s.has('Super expression must either be null or a function, not ')],
  ['vendor', 'zen-observable', (r, s) => s.has('Observable cannot be called as a function')],
  ['vendor', 'colour parser', (r, s) => any(s, /^\^#\(\[0-9a-fA-F\]\{1\}\)/)],
  ['vendor', 'RNPS platform package (@rnps-ppr)', (r, s) => any(s, /@rnps-ppr\//)],
  ['boot', 'entry module', (r, s, x, c) => r.id === c.entry],
  ['boot', 'boot: JS exception / rejection handlers', (r, s) => s.has('setJSExceptionHandler') || s.has('SCE_RNPS_EXPLORE_HUB_ERROR_JS_EXCEPTION')],
  ['boot', 'boot: app component (route switch)', (r, s) => has(s, 'renderHub', 'renderComponent')],
  ['root', 'hub app frame (backgrounds, screensaver, news video)', (r, s) => has(s, 'appBootMode', 'onScreenSaverActive')],
  ['root', 'hub root screen (root / editor / transient)', (r, s) => has(s, 'transientPending', 'rootPending')],
  ['nav', 'main navigator (route table)', (r, s, x) => x.includes('initialRouteName') && has(s, 'Root', 'Details')],
  ['settings', 'Welcome Hub Settings route table', (r, s) => s.has('msgid_welcome_hub_settings') && r.exports.some(e => e.name === 'screenSaver')],
  ['nav', 'react-navigation (vendored)', (r, s, x) => any(s, /^Navigation\/[A-Z_]+$/) || s.has('StackRouterRoot') || s.has('getScreen') || x.some(n => /^(StackNavigatorPS|createNavigator|createNavigationContainer|NavigationActions|withNavigation)$/.test(n))],
  ['nav', 'route / navigator definition', (r, s, x) => x.includes('ROUTE_NAME') || r.exports.some(e => /StackNavigatorPS\(\)/.test(e.kind))],
  ['mini', 'MINI registry (WIDGET_MAP / WIDGET_CONFIGS / WIDGET_PRIORITY)', (r, s, x) => x.includes('WIDGET_PRIORITY')],
  ['mini', 'MINI row component', (r, s) => has(s, 'priorityList', 'expandedSize')],
  ['mini', 'useTransientWidgetMap', (r, s, x) => x.includes('useTransientWidgetMap')],
  ['grid', 'grid editor (focus, move, resize, undo)', (r, s) => has(s, 'onResizeWidget', 'scrollToWidget')],
  ['grid', 'grid horizontal scroller', (r, s) => has(s, 'setScrollStartOffset', 'scrollToColumn')],
  ['grid', 'grid layout algebra', (r, s, x) => ['packLeft', 'findNearest', 'fitAdd', 'resize'].every(n => x.includes(n))],
  ['grid', 'grid WIDGET_MAP (id -> component)', (r, s, x) => x.includes('WIDGET_MAP') && x.includes('OPTED_OUT_CONFIG')],
  ['grid', 'widget ids (EDITABLE)', (r, s, x) => x.includes('EDITABLE')],
  ['grid', 'widget id -> stock component table', (r, s, x) => s.has('DISABLED_WIDGETS') && x.includes('disabled')],
  ['grid', 'preset layout table (ENCODED, default; per-country DISABLED_WIDGETS)', (r, s, x) => x.includes('ENCODED')],
  ['grid', 'Edit Widgets list table (titles / icons / descriptions)', (r, s, x, c) => r.requires.length === 1 && c.isWidgetIds(r.requires[0]) && (r.uses[r.requires[0]] || []).length >= 10 && x.length === 1],
  ['grid', 'WidgetSize enum', (r, s, x, c) => { const u = c.usedAs(r.id); return u.has('default.MINI') && u.has('default.FULL') && r.requires.length === 0; }],
  ['grid', 'grid focus settings', (r, s, x) => x.includes('focusCustomSettings') && s.has(':wrapper')],
  ['grid', 'widget presets', (r, s, x) => x.includes('widgetPreset') || x.includes('clearCustomPresets')],
  ['grid', 'widget preset enum', (r, s, x, c) => { const u = c.usedAs(r.id); return u.has('default.SUGGESTED') && u.has('default.SOLO'); }],
  ['widgets', 'stock widget frame', (r, s) => has(s, 'widget shortcut', 'select widget')],
  ['hubsdk', 'Hub SDK index', (r, s, x) => x.includes('isFromHubSDK') && x.includes('HubProvider')],
  ['hubsdk', 'Hub SDK module', (r, s, x, c) => c.reexportedBy(r.id, 'hubsdk')],
  ['shell', 'shell app facade (LinkingPS, ExitHandler, ...)', (r, s, x) => x.includes('LinkingPS') && x.includes('ExitHandler')],
  ['shell', 'shell facade module', (r, s, x, c) => c.reexportedBy(r.id, 'shell')],
  ['shell', 'native module wrapper', (r, s) => any(s, /^VshN[MU][A-Za-z0-9]+$/)],
  ['i18n', 'Localizable (number / currency / msgid formatting)', (r, s) => any(s, /^Localizable: /)],
  ['i18n', 'i18n getters', (r, s) => r.exports.length >= 3 && r.exports.every(e => e.kind === 'getter') && [...s].filter(t => /^msgid_/.test(t)).length >= r.exports.length / 2],
  ['i18n', 'msgid table', (r, s) => { const m = [...s].filter(t => /^msgid_/.test(t)).length; return m >= 20 && m >= 0.6 * s.size; }],
  ['telemetry', 'telemetry', (r, s, x) => x.some(n => /Telemetry|^send[A-Z]\w*Event$|^surfaceTelemetry$/.test(n)) || has(s, 'BeaconTimer') || s.has('widgetEncodedLayout')],
  ['network', 'network client', (r, s, x) => s.has('network:fetch') || x.includes('setRequestStrategy')],
  ['theme', 'backgrounds / colours', (r, s, x) => x.some(n => /^(setDefaultBackgroundUri|setBackgroundImage|createAnimatedBackground|DEFAULT_BACKGROUND_BASEMAT|COLOR|clearBackgroundImage)$/.test(n))],
  ['data', 'data store / cache / DB accessor', (r, s, x) => x.some(n => /^(WidgetData|CacheHelper|DatabaseModule|AppBrowseItemAccessor|ConceptBrowseItemAccessor)$/.test(n))],
  // Product code (tier 3): content seeds so each feature owns its own subtree.
  ['product', 'product: store / offers / pricing', (r, s, x) => any(s, /^(PROMOTIONAL_OFFER_DETAILS|GROUPED_REWARD_MISSING_SKU|cumulativeDiscountPercentage|CatalogEntitlement)$/) || x.some(n => /^(getBestPrice|compareByBestEvaluatedOffer|basePriceTextOrBasePriceAsCurrency|prefetchAddToCart)/.test(n))],
  ['product', 'product: PS Plus', (r, s) => [...s].filter(t => /^msgid_.*ps_plus|PS_PLUS_UPSELL|GTA_PLUS/.test(t)).length >= 3],
  ['product', 'product: entitlements / catalog', (r, s, x) => x.some(n => /^(getEntitlementStatus|getMetadatasForTitle|getMetadatasForAppBrowseItems)$/.test(n)) || any(s, /^(APPLICATION_TYPE_MAP|FEATURE_TYPE_MAP)$/)],
  ['product', 'product: social (friends, profiles)', (r, s, x) => x.some(n => /^(fetchFriends|fetchFriendsSummary|fetchFriendSummary|fetchBlockingUsers)$/.test(n))],
  ['product', 'product: media / video playback', (r, s, x) => any(s, /^(CAN_PLAY_THROUGH|PASSIVE_PLAYBACK_ERROR|REQUEST_PLAYBACK_ERROR)$/) || x.includes('PlayheadContext')],
  ['product', 'product: captures / media gallery', (r, s, x) => x.some(n => /^(fetchFavorites|fetchGroupCount)$/.test(n))],
  ['network', 'network client / API endpoints', (r, s) => any(s, /^https:\/\/\{?[a-z]/) && r.size > 1000],
];

// Seeds whose requires are screens: route tables do not own what they route to.
const ROUTE_TABLE = /^(main navigator|route \/ navigator definition)/;

function assignAreas(recs, strsOf, entry) {
  const byId = new Map(recs.map(r => [r.id, r]));
  const importers = new Map();
  for (const r of recs) for (const d of r.requires) { if (!importers.has(d)) importers.set(d, []); importers.get(d).push(r.id); }
  for (const r of recs) r.importers = (importers.get(r.id) || []).length;
  const usedAsCache = new Map();
  const usedAs = id => {
    if (!usedAsCache.has(id)) { const u = new Set(); for (const i of importers.get(id) || []) for (const p of (byId.get(i).uses[id] || [])) u.add(p); usedAsCache.set(id, u); }
    return usedAsCache.get(id);
  };
  // Babel helpers: `module.exports = function`, no requires except other helpers,
  // no distinctive strings, used widely. Two passes for helpers that use helpers.
  const helper = new Set();
  for (let pass = 0; pass < 2; pass++) for (const r of recs) {
    const e = r.exports;
    if (e.length === 1 && e[0].name === 'module.exports' && /function/.test(e[0].kind) && r.size < 1500 && r.importers >= 3
      && r.requires.every(d => d === 0 || helper.has(d)) && !r.strings.some(t => interesting(t) >= 3)) helper.add(r.id);
  }
  const seed = new Map();
  const ctx = {
    entry, helper, usedAs,
    isWidgetIds: id => byId.has(id) && byId.get(id).exports.some(e => e.name === 'EDITABLE'),
    // Module that a seed of `area` re-exports through getters (an SDK index).
    reexportedBy: (id, area) => (importers.get(id) || []).some(i => seed.has(i) && seed.get(i).area === area && byId.get(i).exports.some(e => e.kind === 'getter' && e.from === id)),
  };
  for (let pass = 0; pass < 2; pass++) for (const r of recs) {
    if (seed.has(r.id)) continue;
    const s = strsOf.get(r.id), x = r.exports.map(e => e.name);
    for (const [area, label, test] of SEEDS) {
      let ok = false;
      try { ok = test(r, s, x, ctx); } catch (e) { ok = false; }
      if (ok) { seed.set(r.id, { area, label }); break; }
    }
  }
  // Stock widgets: the modules the grid component table and the MINI registry
  // require (each a widget root), unless already seeded.
  for (const r of recs) {
    const sd = seed.get(r.id);
    if (!sd || !/stock component table|MINI registry/.test(sd.label)) continue;
    for (const d of r.requires) if (!seed.has(d) && byId.has(d) && !ctx.isWidgetIds(d) && byId.get(d).exports.some(e => e.name === 'default' || e.name === 'config'))
      seed.set(d, { area: 'widgets', label: /MINI/.test(sd.label) ? 'stock MINI widget' : 'stock grid widget' });
  }
  // Screens: what route tables route to (a component module few others import).
  for (const r of recs) {
    const sd = seed.get(r.id);
    if (!sd || !ROUTE_TABLE.test(sd.label)) continue;
    for (const d of r.requires) {
      const m = byId.get(d);
      if (!m || seed.has(d) || m.importers > 3 || !m.exports.some(e => e.name === 'default' || e.name === 'module.exports')) continue;
      seed.set(d, { area: 'screens', label: 'screen (route target)' });
    }
  }
  // Ownership: the areas whose seeds reach each module without crossing another seed.
  // Route tables and react-navigation do not own the modules below them.
  // depth.get(module) = Map(area -> fewest require hops from a seed of that area).
  const depth = new Map();
  for (const [id, sd] of seed) {
    if (ROUTE_TABLE.test(sd.label)) continue;
    let frontier = [...byId.get(id).requires];
    const seen = new Set();
    for (let dist = 1; frontier.length; dist++) {
      const next = [];
      for (const d of frontier) {
        if (seen.has(d) || !byId.has(d) || seed.has(d)) continue;
        seen.add(d);
        if (!depth.has(d)) depth.set(d, new Map());
        const m = depth.get(d);
        if (!m.has(sd.area) || m.get(sd.area) > dist) m.set(sd.area, dist);
        next.push(...byId.get(d).requires);
      }
      frontier = next;
    }
  }
  // A module belongs to the area of its nearest seed; a tie between areas is
  // 'shared'. area_by lists every area that reaches it.
  for (const r of recs) {
    if (seed.has(r.id)) { r.area = seed.get(r.id).area; r.area_by = 'seed: ' + seed.get(r.id).label; continue; }
    const m = depth.get(r.id);
    const real = m ? [...m].filter(([a]) => a !== 'modsys') : [];
    if (!real.length) { r.area = m ? 'modsys' : 'other'; r.area_by = m ? 'reached from modsys only' : 'not reached from any seed'; continue; }
    const min = Math.min(...real.map(([, d]) => d));
    const near = real.filter(([, d]) => d === min).map(([a]) => a).sort();
    const all = real.map(([a, d]) => `${a}:${d}`).sort().join(', ');
    if (near.length === 1) { r.area = near[0]; r.area_by = real.length === 1 ? `owned by ${near[0]}` : `nearest ${near[0]} (reached by ${all})`; }
    else { r.area = 'shared'; r.area_by = `shared by ${near.join(', ')} (reached by ${all})`; }
  }
}

function roleOf(rec, strs) {
  const ex = rec.exports;
  const comp = ex.filter(e => /component/.test(e.kind));
  const getters = ex.filter(e => e.kind === 'getter');
  if (ex.length && getters.length === ex.length) {
    const from = new Set(getters.map(g => g.from).filter(v => v !== undefined));
    const msg = [...strs].filter(t => /^msgid_/.test(t)).length;
    if (msg >= Math.max(3, getters.length / 2)) return 'i18n getters';
    return `re-export index (${getters.length} getters from ${from.size} modules)`;
  }
  const disp = [...strs].find(t => /^[A-Z][A-Za-z0-9]+$/.test(t) && ex.some(e => e.name === 'default') && strs.has('displayName'));
  if (comp.length) return `component${comp.length > 1 ? 's' : ''}: ${comp.map(e => e.name).slice(0, 4).join(', ')}${disp ? ` (displayName ${disp}?)` : ''}`;
  if (ex.length === 1 && ex[0].name === 'module.exports') return `module.exports = ${ex[0].kind}`;
  if (ex.length) return `exports: ${ex.map(e => e.name).slice(0, 5).join(', ')}${ex.length > 5 ? ', ...' : ''}`;
  return null;
}

// ---------------------------------------------------------------------------
// Index one dump

function fwOf(file) {
  const m = /_fw(\d{3,4})_/.exec(path.basename(file));
  return m ? m[1] : 'xxxx';
}

function indexDump(file) {
  const h = new HBC(file);
  const kids = childMap(h);
  const mods = moduleTable(h);
  // webpack runtime (global code F1): __webpack_require__.s = <entry id>.
  let entry = null;
  { const ins = h.disassemble(1); for (let i = 1; i < ins.length; i++) if (baseOp(ins[i].op) === 'PutById' && h.strings[ins[i].args[3]] === 's' && LOAD_NUM.has(baseOp(ins[i - 1].op))) entry = ins[i - 1].args[1]; }
  const recs = [];
  const fnStr = new Map();
  const strsOf = new Map();
  for (const [id, fid] of [...mods].sort((a, b) => a[0] - b[0])) {
    const t = tree(kids, fid);
    const s = new Set();
    let size = 0;
    for (const f of t) {
      size += h.functions[f].size;
      if (!fnStr.has(f)) fnStr.set(f, fnStrings(h, f));
      for (const x of fnStr.get(f)) s.add(x);
    }
    strsOf.set(id, s);
    const a = analyzeModule(h, fid);
    recs.push({ id, factory: fid, functions: t.size, size, ...a });
  }
  // Document frequency for distinctiveness.
  const df = new Map();
  for (const s of strsOf.values()) for (const x of s) df.set(x, (df.get(x) || 0) + 1);
  for (const r of recs) {
    const s = strsOf.get(r.id);
    r.strings = [...s].filter(x => interesting(x) && df.get(x) <= 3)
      .sort((p, q) => interesting(q) - interesting(p) || df.get(p) - df.get(q) || q.length - p.length)
      .slice(0, 40);
    r.role = roleOf(r, s);
  }
  assignAreas(recs, strsOf, entry);
  for (const r of recs) if (/^seed: /.test(r.area_by) && !r.role) r.role = r.area_by.slice(6);
  const wh = h.strings.filter(s => typeof s === 'string' && s.startsWith('__wh'));
  const doc = {
    fw: fwOf(file),
    file: path.basename(file),
    sha1: crypto.createHash('sha1').update(h.buf).digest('hex'),
    source_hash: h.header.sourceHash,
    functions: h.functions.length,
    module_count: recs.length,
    entry_module: entry,
    dll_shims: recs.filter(r => r.exports.length === 1 && r.exports[0].dll).map(r => ({ id: r.id, dll: r.exports[0].dll, via: r.exports[0].from })),
    patched: wh.length ? `contains ${wh.join(', ')}: a wh bridge, not a stock hub` : null,
    areas: Object.fromEntries([...new Set(recs.map(r => r.area))].sort().map(a => [a, recs.filter(r => r.area === a).length])),
    modules: recs,
  };
  return { h, doc, mods, strsOf };
}

// ---------------------------------------------------------------------------
// Cross-firmware xref: ref module -> target module

function xref(A, B) {
  const ha = A.h, hb = B.h;
  const keyA = new Map(), keyB = new Map();
  const k = (h, fid) => { const n = normalize(h, fid); return n ? n.key : null; };
  for (const r of A.doc.modules) keyA.set(r.id, k(ha, r.factory));
  const bByKey = new Map();
  for (const r of B.doc.modules) { const kk = k(hb, r.factory); keyB.set(r.id, kk); if (!bByKey.has(kk)) bByKey.set(kk, []); bByKey.get(kk).push(r.id); }
  const map = new Map();       // a id -> {id, method, confidence}
  const used = new Set();
  // 1. unique exact normalized tree (the factory hash covers every nested closure).
  for (const r of A.doc.modules) {
    const c = bByKey.get(keyA.get(r.id)) || [];
    if (c.length === 1) { map.set(r.id, { id: c[0], method: 'exact', confidence: 0.99 }); used.add(c[0]); }
  }
  const reqB = new Map(B.doc.modules.map(r => [r.id, r.requires]));
  const reqA = new Map(A.doc.modules.map(r => [r.id, r.requires]));
  // 2. identical candidates: disambiguate by requires mapped through known matches.
  for (let pass = 0; pass < 4; pass++) {
    for (const r of A.doc.modules) {
      if (map.has(r.id)) continue;
      const c = (bByKey.get(keyA.get(r.id)) || []).filter(id => !used.has(id));
      if (!c.length) continue;
      const want = reqA.get(r.id).map(d => map.has(d) ? map.get(d).id : null);
      if (want.some(v => v === null)) continue;
      const hit = c.filter(id => JSON.stringify(reqB.get(id)) === JSON.stringify([...want].sort((x, y) => x - y)));
      if (hit.length === 1) { map.set(r.id, { id: hit[0], method: 'exact+requires', confidence: 0.97 }); used.add(hit[0]); }
    }
  }
  // Local id offset from the nearest matched neighbours (bundler ids are ordered).
  const aIds = A.doc.modules.map(r => r.id);
  const offsetNear = id => {
    let lo = null, hi = null;
    for (let d = 1; d < 200 && (lo === null || hi === null); d++) {
      if (lo === null && map.has(id - d) && map.get(id - d).method.startsWith('exact')) lo = map.get(id - d).id - (id - d);
      if (hi === null && map.has(id + d) && map.get(id + d).method.startsWith('exact')) hi = map.get(id + d).id - (id + d);
    }
    return lo !== null && lo === hi ? lo : (lo ?? hi);
  };
  // 3. identical candidates left: pick the one at the neighbours' offset.
  for (const r of A.doc.modules) {
    if (map.has(r.id)) continue;
    const c = (bByKey.get(keyA.get(r.id)) || []).filter(id => !used.has(id));
    if (!c.length) continue;
    const off = offsetNear(r.id);
    if (off !== null && c.includes(r.id + off)) { map.set(r.id, { id: r.id + off, method: 'exact+neighbours', confidence: 0.95 }); used.add(r.id + off); }
  }
  // 4. changed modules: string-bag similarity among unmatched targets near the
  //    expected id, accepted with a clear margin.
  const jac = (p, q) => { let i = 0; for (const x of p) if (q.has(x)) i++; return i / (p.size + q.size - i || 1); };
  const freeB = B.doc.modules.filter(r => !used.has(r.id));
  for (const r of A.doc.modules) {
    if (map.has(r.id)) continue;
    const sa = A.strsOf.get(r.id);
    const off = offsetNear(r.id) ?? 0;
    const cands = freeB.filter(b => !used.has(b.id) && Math.abs(b.id - (r.id + off)) <= 60)
      .map(b => ({ id: b.id, j: jac(sa, B.strsOf.get(b.id)), sz: Math.min(r.size, b.size) / Math.max(r.size, b.size, 1) }))
      .map(c => ({ ...c, score: 0.8 * c.j + 0.2 * c.sz - (c.id === r.id + off ? 0 : 0.02) }))
      .sort((p, q) => q.score - p.score);
    const [best, next] = cands;
    if (best && best.score >= 0.6 && (!next || best.score - next.score >= 0.1)) {
      map.set(r.id, { id: best.id, method: `strings (jaccard ${best.j.toFixed(2)}, size ${best.sz.toFixed(2)})`, confidence: +Math.min(0.9, best.score).toFixed(2) });
      used.add(best.id);
    }
  }
  // 5. still unmatched: LCS alignment of the normalized factory streams (a changed
  //    nested closure shows up as one changed line), near the expected id.
  const lcsSim = (p, q) => {
    if (p.length * q.length > 4e6) return 0;
    let prev = new Uint32Array(q.length + 1), cur = new Uint32Array(q.length + 1);
    for (let i = 1; i <= p.length; i++) {
      for (let j = 1; j <= q.length; j++) cur[j] = p[i - 1] === q[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      [prev, cur] = [cur, prev];
    }
    return 2 * prev[q.length] / (p.length + q.length || 1);
  };
  for (const r of A.doc.modules) {
    if (map.has(r.id)) continue;
    const na = normalize(ha, r.factory);
    if (!na) continue;
    const off = offsetNear(r.id) ?? 0;
    const cands = B.doc.modules.filter(b => !used.has(b.id) && Math.abs(b.id - (r.id + off)) <= 60)
      .map(b => { const nb = normalize(hb, b.factory); return { id: b.id, sim: nb ? lcsSim(na.loose, nb.loose) : 0 }; })
      .sort((p, q) => q.sim - p.sim);
    const [best, next] = cands;
    if (best && best.sim >= 0.8 && (!next || best.sim - next.sim >= 0.05)) {
      map.set(r.id, { id: best.id, method: `aligned (factory sim ${best.sim.toFixed(2)})`, confidence: +Math.min(0.9, best.sim).toFixed(2) });
      used.add(best.id);
    }
  }
  // 6. modules the target build moved far away: string bags over all unmatched
  //    targets, strict threshold and margin.
  for (const r of A.doc.modules) {
    if (map.has(r.id)) continue;
    const sa = A.strsOf.get(r.id);
    if (sa.size < 4) continue;
    const cands = B.doc.modules.filter(b => !used.has(b.id)).map(b => ({ id: b.id, j: jac(sa, B.strsOf.get(b.id)) })).sort((p, q) => q.j - p.j);
    const [best, next] = cands;
    if (best && best.j >= 0.8 && (!next || best.j - next.j >= 0.2)) {
      map.set(r.id, { id: best.id, method: `strings-global (jaccard ${best.j.toFixed(2)}, id moved ${best.id - r.id})`, confidence: +Math.min(0.85, best.j).toFixed(2) });
      used.add(best.id);
    }
  }
  const areaOf = new Map(A.doc.modules.map(r => [r.id, r.area]));
  const per = {};
  for (const r of A.doc.modules) {
    const a = r.area;
    per[a] = per[a] || { total: 0, matched: 0, exact: 0 };
    per[a].total++;
    if (map.has(r.id)) { per[a].matched++; if (map.get(r.id).method === 'exact') per[a].exact++; }
  }
  for (const a in per) per[a].rate = +(per[a].matched / per[a].total).toFixed(3);
  const unmatchedA = A.doc.modules.filter(r => !map.has(r.id)).map(r => ({ id: r.id, area: r.area, role: r.role, size: r.size }));
  const unmatchedB = B.doc.modules.filter(r => !used.has(r.id)).map(r => ({ id: r.id, area: r.area, role: r.role, size: r.size }));
  const counts = {};
  for (const v of map.values()) { const m = v.method.split(' ')[0]; counts[m] = (counts[m] || 0) + 1; }
  return {
    ref: { fw: A.doc.fw, file: A.doc.file, sha1: A.doc.sha1 },
    target: { fw: B.doc.fw, file: B.doc.file, sha1: B.doc.sha1 },
    summary: { ref_modules: A.doc.modules.length, target_modules: B.doc.modules.length, matched: map.size, by_method: counts,
      rate: +(map.size / A.doc.modules.length).toFixed(4) },
    per_area: per,
    unmatched_ref: unmatchedA,
    unmatched_target: unmatchedB,
    map: Object.fromEntries([...map].map(([a, v]) => [a, { ...v, area: areaOf.get(a) }])),
  };
}

// ---------------------------------------------------------------------------
// New-firmware diff report: what is new, removed, changed (tree hash differs) or
// moved (same tree, new id), with tier-1 modules and fid_match targets flagged.

const TIER1_AREAS = new Set(['grid', 'mini', 'settings', 'hubsdk', 'shell', 'root', 'nav']);

function diffReport(A, B, x) {
  const { TARGETS, MODULES } = require('./fid_match.js');
  // Which ref module owns each patch target function.
  const kids = childMap(A.h);
  const owner = new Map();
  for (const r of A.doc.modules) for (const f of tree(kids, r.factory)) if (!owner.has(f)) owner.set(f, r.id);
  const flags = new Map();
  const flag = (id, why) => { if (!flags.has(id)) flags.set(id, []); flags.get(id).push(why); };
  for (const t of TARGETS) if (owner.has(t.fid)) flag(owner.get(t.fid), `fid_match target ${t.name} (F${t.fid})`);
  for (const m of MODULES) flag(m.id_1320, `fid_match module ${m.name}`);
  for (const r of A.doc.modules) if (TIER1_AREAS.has(r.area)) flag(r.id, `tier-1 area ${r.area}`);
  const byA = new Map(A.doc.modules.map(r => [r.id, r]));
  const row = (r, extra) => `| ${r.id} | ${r.area} | ${(r.role || '').replace(/\|/g, '/').slice(0, 60)} | ${extra} | ${(flags.get(r.id) || []).join('; ')} |`;
  const changed = [], moved = [];
  for (const [a, m] of Object.entries(x.map)) {
    const r = byA.get(+a);
    if (m.method !== 'exact' && m.method !== 'exact+requires' && m.method !== 'exact+neighbours') changed.push(row(r, `→ ${m.id} (${m.method}, conf ${m.confidence})`));
    else if (+a !== m.id) moved.push([r, m]);
  }
  const removed = x.unmatched_ref.map(u => row(byA.get(u.id), 'no match'));
  const added = x.unmatched_target.map(u => `| ${u.id} | ${u.area} | ${(u.role || '').replace(/\|/g, '/').slice(0, 60)} | size ${u.size} | |`);
  const head = '| Module | Area | Role | Change | Flags |\n|---|---|---|---|---|';
  const lines = [
    `# Diff ${A.doc.fw} (${A.doc.file}) → ${B.doc.fw} (${B.doc.file})`, '',
    `Generated by \`tools/hub_index.js --diff\`. ${x.summary.matched}/${x.summary.ref_modules} matched (${(100 * x.summary.rate).toFixed(1)}%), ${JSON.stringify(x.summary.by_method)}.`, '',
    '## Attention: changed or removed modules with flags', '',
    'Review these first. Flags mark tier-1 areas, `fid_match` MODULES, and modules that own a `fid_match` patch target.', '', head,
    ...[...changed, ...removed].filter(l => !/\|  \|$/.test(l)), '',
    `## Changed (tree hash differs): ${changed.length}`, '', head, ...changed, '',
    `## Removed (no match on the new build): ${removed.length}`, '', head, ...removed, '',
    `## New on the new build: ${added.length}`, '', '| Module | Area | Role | Size | |\n|---|---|---|---|---|', ...added, '',
    `## Moved (same tree, new id): ${moved.length}`, '',
    `${moved.filter(([r]) => flags.has(r.id)).map(([r, m]) => `${r.id}→${m.id}`).join(', ') || '(none flagged)'} (flagged only; full map in the xref JSON)`, '',
  ];
  return lines.join('\n') + '\n';
}

function main() {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const outDir = path.resolve(opt('--out') || path.join(__dirname, '..', 'dumps', 'hub-atlas'));
  const refFile = opt('--ref');
  const di = argv.indexOf('--diff');
  const diff = di >= 0;
  if (diff) argv.splice(di, 1);
  const [file] = argv;
  if (!file || (diff && !refFile)) { console.error('usage: node tools/hub_index.js <hub.hbc> [--ref <ref.hbc> [--diff]] [--out <dir>]'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, obj) => { const p = path.join(outDir, name); fs.writeFileSync(p, JSON.stringify(obj, null, 1) + '\n'); console.log('wrote ' + p); };
  // A patched dump (our bridge) or a second dump of one firmware gets its own name,
  // so it never overwrites the stock index of that firmware.
  const tagOf = d => d.patched ? `${d.fw}_${d.sha1.slice(0, 6)}_patched` : d.fw;
  const B = indexDump(file);
  if (B.doc.patched) console.log('note: ' + B.doc.patched);
  if (refFile) {
    const A = indexDump(refFile);
    const tag = tagOf(B.doc) === tagOf(A.doc) ? `${B.doc.fw}_${B.doc.sha1.slice(0, 6)}` : tagOf(B.doc);
    write(`modules_fw${tag}.json`, B.doc);
    write(`modules_fw${tagOf(A.doc)}.json`, A.doc);
    const x = xref(A, B);
    write(`xref_${tagOf(A.doc)}_${tag}.json`, x);
    console.log(`xref ${A.doc.fw} -> ${B.doc.fw}: ${x.summary.matched}/${x.summary.ref_modules} (${(100 * x.summary.rate).toFixed(1)}%) ${JSON.stringify(x.summary.by_method)}`);
    if (diff) {
      const p = path.join(outDir, `diff_${tagOf(A.doc)}_${tag}.md`);
      fs.writeFileSync(p, diffReport(A, B, x));
      console.log('wrote ' + p);
    }
  } else write(`modules_fw${tagOf(B.doc)}.json`, B.doc);
}

if (require.main === module) main();
module.exports = { indexDump, xref, analyzeModule };
