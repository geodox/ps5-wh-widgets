# Troubleshooting

Everything that can stop a widget loading is written to
**`/data/wh-widgets/wh.log`** (rotates to `wh.log.1` at 256 KB). Read the end of
it with:

```
python scripts/whctl.py --host <console-ip> log
```

| tag | written by | examples |
|---|---|---|
| `[installer]` | the payload | each install step; `skip <folder>: config.json missing`; `glyph file x.png not found`; `install failed (rc=13): evaluateJavaScript prologue mismatch (unsupported firmware?)` |
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

## New code needs a new hub runtime

The hub's JS runtime survives refocusing (it only re-renders). After deploying or
installing, sign out and back in, or install with `--race`:

```
python scripts/whctl.py --host <console-ip> install out/wh_bridge.elf --race
```

`--race` SIGKILLs ShellUI and installs the moment the respawned process maps
libhermes. The jailbreak survives.

## Widget does not appear

1. Check `[installer]` for `skip <folder>` or an install failure.
2. Check `[widget:<id>]` for `not loaded` - usually `wh.register` was never called,
   or the file threw while evaluating.
3. Check the folder name matches `config.json`'s `id` and is not a
   [reserved stock id](config.md#reserved-stock-ids).
4. Reload the hub (sign out/in or `install --race`).

## Render errors

A bad render only breaks that one tile. `[widget:<id>] render error (tile hidden)`
includes the message and stack; fix the component and reload the hub.

## Wrong tile size

Set `size` in `config.json` for the starting size, and use `props.width` /
`props.height` for the live box. L1/R1 in edit mode only steps
DEFAULT -> LARGE -> FULL; XL comes from the layout (see
[sizes and layout](sizes-and-layout.md#xl-via-the-layout)).
