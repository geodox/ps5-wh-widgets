# Cross-firmware function-match spec (for REA)

## Goal

`tools/build_bridge_hbc.js` patches 8 functions in the Welcome Hub's Hermes
bytecode bundle (HBC v89). The patch table `PATCHES` is keyed by **function id
(`fid` = module-index order)**, which is only valid for the firmware the fids were
read from (**FW 13.20**). On any other firmware the modules load in a different
order, so every `fid` — and several per-function operands — shift.

For each additional hub dump, produce the numbers that let `build_bridge_hbc.js`
patch the **same 8 functions** on that firmware. Identify each function by its
**content/structure**, never by fid. Then re-derive the per-function operands.

Do **not** write any on-console or runtime patcher. Output is data only: a JSON
map consumed by the offline build. A wrong guess must fail the offline build, not
reach a console.

## Inputs

- `dumps/hub_fw1320_*.hbc` — reference. The `fid`s below are **ground truth** here;
  use it to learn each function's fingerprint.
- `dumps/hub_fw1360_*.hbc` and any later `dumps/hub_fw<NNNN>_*.hbc` — targets.

Both are HBC v89. Parser/disassembler available at `tools/hbc.js`
(`new HBC(path)`, `.functions`, `.disassemble(fid)`, `.fmtInsn(f, ins)`,
`.strings`). REA may use its own disassembler instead.

## Output

One file per target dump: `dumps/fid_map_fw<NNNN>.json`

```json
{
  "fw": 1360,
  "source_sha1": "<sha1 of the dump>",
  "targets": [
    {
      "name": "__whWidgetMap",      // stable key; matches the table below
      "fid_1320": 7374,             // ground-truth fid on 13.20
      "fid": 1234,                  // re-derived fid on THIS dump
      "confidence": 0.98,           // 0..1
      "evidence": "module exports WIDGET_MAP; r1 live at Ret; param3=require",
      "params": { ... }             // re-derived operands, schema per hook below
    }
  ]
}
```

`params` schema depends on the hook kind (below). Emit every field shown for that
kind. If a function cannot be matched with confidence >= 0.9, still emit the entry
with your best candidate, `confidence` below 0.9, and `params: null`; the build
will reject it rather than patch blindly.

## The 8 targets (13.20 ground truth)

`hook` is the builder in `build_bridge_hbc.js`. Registers/offsets are 13.20 values,
shown so you know what each re-derived number must mean.

| name | fid_1320 | hook | role / fingerprint |
|---|---|---|---|
| (lock A) | 5916 | `lock` | hub tile key handler with `onCircleKeyDown`/`onBackKeyDown`; frameSize >= 2; no exception handlers |
| (lock B) | 19960 | `lock` | second key handler, same shape |
| `__whWidgetMap` + `__whRequire` | 7374 | `global` | module that builds WIDGET_MAP; exports table in r1 live at the final `Ret`; the hub `require` arrives as param 3 (r7) |
| `__whSizeDown` | 19931 | `sizeStep` | L1 resize step: computes `max(1, size-1)` |
| `__whSizeUp` | 19932 | `sizeStep` | R1 resize step: computes `min(FULL, size+1)` |
| `__whScrollTo` | 19985 | `prefix` | grid `scrollTo(col)`; **first instruction is `LoadParam r3, 1`** |
| `__whLayoutResize` | 1674 | `prefix` | layout library `resize(layout, position, size)`; sibling module also exports `size()`/`pack()`/`wrap()` |
| `__whFind` | 1665 | `prefix` | layout library `find(layout, id)`; same module as `__whLayoutResize` |

## Per-hook `params` to re-derive

Constants come from the stock function body, so they move per firmware. Derive each
from the matched function on the target dump.

### `lock`
```json
{ "frameSize_ok": true }      // assert frameSize >= 2 and no exception handlers
```
No numeric operands; the builder only prepends a guard. Just confirm the match.

### `global`
Per injected value:
```json
{ "inj": [ { "name": "__whWidgetMap", "valReg": 1, "at": null },
           { "name": "__whRequire",   "valReg": 7, "at": 12 } ] }
```
- `valReg`: register holding the value to export.
- `at`: instruction-boundary **ip** to inject before. `null` = inject before the
  final `Ret`; then the instruction before `Ret` must be `PutById ..., <valReg>, ...`
  (the `exports.WIDGET_MAP` store).
- For a non-null `at` (like `__whRequire` at ip 12), give the ip **on the target
  dump** where that register first holds the wanted value (the require param load).
- The function must be `Ret`-terminated, have **no jumps/switches**, and
  frameSize > 14 (scratch r13/r14 are used).

### `sizeStep`
```json
{ "at": 46, "env": 0, "res": 2, "s": [1, 3, 4, 3] }
```
- `at`: ip right **after** the stock clamped size is computed (injection point).
- `res`: register holding that stock-computed size (the result we may override).
- `env`: environment slot index the stock code loaded the stepper from
  (used as `LoadFromEnvironment <tg>, <env>, 22`).
- `s = [g, k, fn, tg]`: four scratch registers the inject may use —
  `g` global-object temp, `k` const-string temp, `fn` function/closure temp,
  `tg` call-target/arg temp. Pick free registers; `frameSize` must exceed `max(s)`.

### `prefix`
```json
{ "frame": 6, "prologue_ok": true }
```
- `frame`: minimum frameSize the prefix asm needs (13.20: scrollTo 0, resize 6,
  find 5). The prefix hard-codes the param layout: param1->r3, param2->r4,
  param3->r5. Confirm the target takes its params in that order.
- For `__whScrollTo`, also assert the first instruction is `LoadParam r3, 1`.

## Extra operands the builder still hard-codes

`tools/fid_match.js` (the implementation of this spec) also emits these. They are
13.20 values baked into `build_bridge_hbc.js`; the builder must take them from the
map before a firmware where they differ is supported.

- `sizeStep.slot`: environment slot of the stepper target (13.20: `22`). Note that
  `env` is the **register** holding the environment, not a slot index.
- `prefix.envDepth` / `prefix.envSlot` (`__whScrollTo` only): the scroll ref the
  prefix passes as `GetEnvironment r4, <envDepth>; LoadFromEnvironment r4, r4, <envSlot>`
  (13.20: `1` / `4`).

## Hub module ids used by the loader

`framework/loader.js` calls `__whRequire(<id>)` with hub module ids, which also move
per firmware. The map's `modules` array gives each one's id on the target:

| name | id_1320 | role |
|---|---|---|
| `stockFrame` | 106 | stock widget frame (`default` export) |
| `stockHeader` | 77 | stock widget header (`default` export) |
| `miniWidgets` | 199 | MINI ("transient") widget registry: `WIDGET_MAP`, `WIDGET_CONFIGS`, `WIDGET_PRIORITY` |
| `widgetTelemetry` | 145 | widget telemetry: `widgetConfiguration`, `widgetEncodedLayout` (the loader keeps custom ids out) |
| `widgetIds` | 17 | widget-id enum: `EDITABLE` (ids the Edit Widgets list offers) and `default` (EDITABLE plus the non-editable ids) |
| `editTitles` | 383 | Edit Widgets list titles: `default`, keyed by widget id |
| `editIcons` | 1938 | Edit Widgets list icons (`IconPS` ids): `default`, keyed by widget id |
| `editDescs` | 1939 | Edit Widgets list descriptions: `default`, keyed by widget id |
| `mainNavigator` | 1068 | main stack navigator: `default.router` (the loader adds the `WhPage` route) |
| `hubSdk` | 32 | Hub SDK index: `HubAppContext` (`isHubFocused`, `isStandaloneMode`; the loader's `props.hubFocused`) |
| `dateFormats` | 319 | date and time format settings: `getFormats()`, `registerDateTimeFormatChangeHandler(fn)` (`wh.getLocale` / `wh.useLocale`) |
| `hubSettingsFollowedGames` | 2126 | Welcome Hub Settings "Followed games" row (`default`); the loader appends its Telemetry and Widget Data rows |
| `editMenu` | 1937 | Edit Widgets list component (`default`); the loader wraps it into the Stock and Custom lists |
| `jsxRuntime` | 3 | react/jsx-runtime (`jsx`, read at call time); the loader corrects the Edit Widgets rows' `enabled` flag |

Ids come from the global code's module table (`CreateClosure r, F; PutOwnByIndex arr, r, <id>`);
the factory function is matched like any target. An entry may list `need` strings
(`miniWidgets` does): the matched factory's closure tree must contain every one,
otherwise the module is left unresolved (`MISSING ANCHORS` in the evidence), so an
aligned match can never hand the loader a different module.

`build_deltas.js` passes each firmware's resolved modules to the loader as a JS
object literal keyed by name (`globalThis.__wh_hubmods`).

## Validation gate (run before any dump's delta is trusted)

For each produced `fid_map_fw<NNNN>.json`:

1. Apply the map to `build_bridge_hbc.js` (fid + params per target) against that
   firmware's hub dump → `out/bridge_fw<NNNN>.hbc`. It must build with **no assert
   failures** (the builder's prologue/shape checks are the first correctness gate).
2. `node tools/make_delta.js <dump> out/bridge_fw<NNNN>.hbc out/bridge_fw<NNNN>.delta`.
3. Rebuild from the delta offline and assert the result is **byte-identical** to
   `out/bridge_fw<NNNN>.hbc`. Only a byte-exact rebuild ships.
4. On-console test of that firmware's payload before release.

A match that builds but whose patched function was the wrong one will usually
surface as a hub that loads but shows no widgets (the issue-#2 symptom), so also
sanity-check the matched functions' string references against the fingerprints
above.
```
