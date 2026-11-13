# Loader internals

This page is for contributors and for anyone debugging the framework itself. The
reverse-engineering notes (hook-point discovery, firmware signatures, HBC
structure) live in `docs/INTERNALS.md`, which is kept locally and not published.

## Runtime flow

1. **Install.** `main.c` finds `SceShellUI`, attaches, and hooks the JS
   `evaluateJavaScript` entry in `libhermes`. The hook is a small detour built
   from `framework/wh_detour.h`.
2. **Rebuild the bridge.** The payload ships no Sony bytecode. It carries
   `bridge.delta` (a description of the changed hub bytecode) and rebuilds the
   bridge HBC inside ShellUI from the hub's own copy, verifying the header hash
   first. See `tools/make_delta.js` and `tools/gen_detour.py`.
3. **Install the prelude.** The reconstructed bridge is evaluated; it registers
   the payload's own `globalThis.__wh` surface and starts the loader.
4. **Load widgets.** `framework/loader.js` scans `/data/wh-widgets/<id>/`, parses
   `config.json`, evaluates `widget.js` in an error boundary, and registers each
   component with the hub's widget map and Edit Widgets lists.
5. **Stay resident.** `server.c` serves widget images and the settings API on
   loopback, and watches for ShellUI respawns so a reloaded hub gets re-hooked
   without reinstalling.

## Source layout

| file | role |
|---|---|
| `main.c` | entry point: install, verify, report |
| `install.c` / `install.h` | cave allocation, `wh_install_once`, `wh_rehook` |
| `hookpoint.c` / `.h` | locate the hook point from firmware signatures |
| `remote.c` / `.h` | find/attach SceShellUI, read/write memory, remote mmap |
| `prelude.c` / `.h` | build the prelude JS (config discovery, loader bootstrap) |
| `server.c` / `.h` | loopback HTTP: assets, settings, log endpoint, re-hook watcher |
| `util.c` / `.h` | version, paths, `wh.log`, notifications, byte/name helpers |
| `cave.h` | named return codes (`WH_RC_*`) shared by the installer |
| `wh_detour.h` | generated detour helper (`tools/gen_detour.py`) |
| `wh_sigs.h` | firmware signatures |
| `embed.S` | embeds `bridge.delta` and `loader.min.js` into the ELF |
| `loader.js` | readable widget loader; minified by `tools/build_loader.js` |

## Loader surface

`loader.js` builds `globalThis.__wh`: React and the RN-PS primitives (captured
from the vendor module the hub already requires), literal enums
(`WidgetSize`, `StockTile`, `Button`), the stock-look components (`Title`,
`Label`, `TextStyles`, `Focusable`), glyph registration, the error boundary, and
the widget scheduler. Widgets see only this handle.

Widgets are reloaded whenever the hub runtime restarts; there is no hot reload.
`config.json` settings are validated once and passed on `props.settings`.

## Asset and settings server

`server.c` listens on `127.0.0.1:8098`:

* `GET /` and `GET /<widget>/<file>` - widget images, `.png`/`.jpg`, max 1 MB,
  names validated by `wh_name_ok`.
* settings get/set endpoints used by the prelude, persisted under
  `/data/wh-widgets/<id>/.settings.json`.
* the log shim that appends widget lines to `wh.log`.

## Build chain

```
node tools/build_bridge_hbc.js <orig.hbc> out/bridge.hbc
node tools/make_delta.js       <orig.hbc> out/bridge.hbc out/bridge.delta
node tools/build_loader.js                 # out/loader.min.js (terser)
python tools/gen_detour.py framework/wh_detour.h
bash framework/build.sh                    # out/wh_bridge.elf, out/wh_kill.elf, zips
```

`<orig.hbc>` is your own decrypted hub bundle; it is not distributed with this
project. `tools/build_bridge_hbc.js` is table-driven: each hook is one entry in
`PATCHES`, and the order of that table is part of the output format.

## Verification

`tools/tests/match_test.c` runs the generated detour natively against a real hub
+ bridge + delta. See `tools/tests/README.md`. The bridge rebuild is also
byte-identical-checked by regenerating `bridge.hbc` from the same input.
