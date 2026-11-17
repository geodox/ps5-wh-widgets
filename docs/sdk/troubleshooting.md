# Troubleshooting

Everything that can stop a widget loading is written to
**`/data/wh-widgets/wh.log`** (rotates to `wh.log.1` at 256 KB). Read the end of
it with:

```
python scripts/whctl.py --host <console-ip> log
```

| tag | written by | examples |
|---|---|---|
| `[installer]` | the payload | each install step; `start fw=13600007 delta=...`; `no hub delta for FW 13.40 in this build (supported: 13.20, 13.60); not installing`; `skip <folder>: config.json missing`; `glyph file x.png not found`; `install failed (rc=13): evaluateJavaScript prologue mismatch (unsupported firmware?)` |
| `[hub]` | the loader inside the hub | `loader ready in the hub runtime`, `hub registered 2 widget(s) [...]`, `edit list title set ...`, glyph images that failed and fell back |
| `[widget:<id>]` | the loader / your widget | `loaded (size 1, glyph glyph.png)`, `not loaded: widget.js ran but never called wh.register(Component)`, `render error (tile hidden): <message> \| <stack>` |
| `[assets]` | the asset server | refused requests with the reason (`file not found`, `not a .png/.jpg image`), server handoffs |

## Log from your widget

```js
var log = wh.logger('my-widget');      // lines tagged [widget:my-widget]
log('fetched ' + items.length + ' items');
```

Lines are queued and sent by the loader shortly after; at most 120 lines/minute
are kept.

## Syntax errors

Syntax errors can't be logged: one syntax error stops the whole widget prelude
from compiling. `whctl deploy` checks every widget first - valid `config.json`
with an `id`, `widget.js` syntax (`node --check`), glyph file present - and skips
broken ones with the exact error. Use `--force` to upload anyway.

## New widget code needs a new hub runtime

The payload watches `config.json` / `widget.js` and swaps the new widget set into
the running shell about six seconds after a change settles. The hub only evaluates
that prelude in a new JS runtime:

1. **Sign out and back in.** That restarts the hub app, and the new runtime runs the
   installed prelude.
2. Leaving the hub and coming back does **not** work - that runtime is kept.

`wh.log` shows the handoff: `widget sources stable for 5s ... refreshing prelude in
place`, `INSTALLED slot2->... (reload, bridge reused)`, then on the next runtime
`loader ready in the hub runtime (vendor ok, icons wrapped)`.

Changes to `framework/loader.js` itself (or a new payload build) take the same
route: install without `--race`, then sign out and back in.

```
python scripts/whctl.py --host <console-ip> install out/wh_bridge.elf
```

`--race` SIGKILLs ShellUI and installs the moment the respawned process maps
libhermes - keep it as a recovery hatch for a wedged shell, not the normal path.

## Firmware not supported

The payload carries one hub patch per supported firmware. On any other firmware
it shows `WHBridge failed: FW x.yy not supported yet` with the supported list,
writes the same to `wh.log`, and installs nothing. To help add your firmware, see
[Help support your firmware](../../README.md#help-support-your-firmware).

If the firmware is supported but no `[hub]` lines ever appear after signing out
and back in, your hub is not the exact build the patch was made from, so the hub
was left stock. Report it with your `[installer] start fw=...` line.

## Widget does not appear

1. Check `[installer]` for `skip <folder>`, an unsupported firmware, or an install
   failure.
2. Check `[widget:<id>]` for `not loaded` - usually `wh.register` was never called,
   or the file threw while evaluating.
3. Check the folder name matches `config.json`'s `id` and is not a
   [reserved stock id](config.md#reserved-stock-ids).
4. Sign out and back in so a new hub runtime loads the refreshed prelude.

## Render errors

A bad render only breaks that one tile. `[widget:<id>] render error (tile hidden)`
includes the message and stack; fix the component and reload the hub.

## Wrong tile size

Set `size` in `config.json` for the starting size, and use `props.width` /
`props.height` for the live box. L1/R1 in edit mode only steps
DEFAULT -> LARGE -> FULL; XL comes from the layout (see
[sizes and layout](sizes-and-layout.md#xl-via-the-layout)).
