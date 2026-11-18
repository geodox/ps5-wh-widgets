# Sizes and layout

## Widget sizes (`WidgetSize`)

Tile dimensions come from the size class. Column width is driven by the widest
widget in that column.

| name | value | width | height | notes |
|---|---|---|---|---|
| `MINI` | 0 | auto (max 504) | 56 | pill; shrinks to content |
| `MINI_EXPANDED` | 0.1 | 504 | 56 | |
| `MINI_EXPANDED_HEIGHT` | 0.2 | auto (max 504) | 120 | |
| `DEFAULT` | 1 | 504 | 152 | standard tile |
| `LARGE` | 2 | 504 | 328 | |
| `FULL` | 3 | 504 | 504 | square |
| `XL` | 6 | 1032 | 504 | double-wide (2 columns) |

## MINI widgets

A widget whose `config.json` `size` is a MINI value (`0`, `0.1` or `0.2`) is not a
grid tile. It goes in the hub's MINI row, the row of temporary widgets such as
PS Plus or Transfers. **Welcome Hub Settings > Temporary Widgets Position**
places that row above or below the tiles. The hub owns the row, so a MINI widget
cannot be moved, resized or removed in Edit Widgets, and it does not appear in
the Edit Widgets list. Custom MINI widgets follow the stock ones in the row.

* `MINI` (`0`) is a 56px pill that **shrinks to its content**, 100-504px wide.
  `props.width` is `null`: give your root no `width` and no `flex: 1` children,
  or it cannot shrink.
* The stock MINI look is `height: 56, borderRadius: 28, padding: 8,
  paddingRight: 16`, a 40px icon with `marginRight: 8`, and one line of
  `FontSizePS.Size2XSmall` (21) text. `hello-mini` is the reference.
* `size` `0.1` or `0.2` starts as `MINI` and grows to that size while focused.

### Showing and hiding a MINI widget

Stock MINI widgets show only when they have something to say: Transfers appears
while a download runs. A custom MINI widget decides the same way with
`props.setVisible(visible)`. `props.visible` is the current state. Both are
`undefined` for grid widgets.

* A hidden MINI widget takes no space in the row and cannot be focused. Its
  component **stays mounted**, so its timers and fetches keep running and it can
  call `setVisible(true)` when there is something to show.
* It starts shown. Add `"visible": false` to `config.json` to start hidden, so
  the pill does not flash before the first check.
* Call `setVisible` from an effect, a timer or a handler, not during render.

```js
function Updates(props) {
  var count = wh.React.useState(0), n = count[0], setN = count[1];
  wh.React.useEffect(function () {
    var timer = setInterval(function () {
      fetch('http://127.0.0.1:9090/updates').then(function (r) { return r.json(); })
        .then(function (list) { setN(list.length); }, function () { setN(0); });
    }, 30000);
    return function () { clearInterval(timer); };
  }, []);
  wh.React.useEffect(function () { props.setVisible(n > 0); }, [n]);
  return wh.React.createElement(wh.Label, null, n + ' updates');
}
```

## Stock metrics (`wh.StockTile`)

From the hub:

* `WIDGET_WIDTH = 504`
* `WIDGET_HEIGHT = 152`
* `WIDGET_WIDTH_SPACING = 528` (504 + 24 gutter)
* `WIDGET_SPACING = 24`
* `WIDGET_PADDING = 16`
* `WIDGET_BORDER_RADIUS = 16`
* `MINI_WIDGET_HEIGHT = 56`

All of these are on `wh.StockTile` (plus `XL_WIDTH: 1032` and
`MAT_COLOR: '#17191E'`).

Grid transform per cell: `X = column * 528`, `Y = row * 176`, rendered at
`scale 0.75`.

**Practical rule:** set your root `View` to `width: 504` (single column) or
`width: 1032` (double).

`wh.dims(size)` returns the same `{width, height}` table for any size. For `MINI`
and `MINI_EXPANDED_HEIGHT`, `width` is `null` and `minWidth` / `maxWidth` give
the bounds.

## Font sizes (`FontSizePS`)

Use `wh.FontSizePS.<Name>`. It is the hub's own enum; the loader fills in the
same values only if the hub doesn't provide it.

RNPS validates `fontSize` against a whitelist and **throws** on any other value.
Only these sizes are allowed:

| name | px | typical use |
|---|---|---|
| `Size3XLarge` | 72 | hero numerals |
| `Size2XLarge` | 54 | |
| `SizeXLarge` | 45 | |
| `SizeLarge` | 36 | widget title (large tiles) |
| `SizeNormal` | 30 | title |
| `SizeSmall` | 27 | |
| `SizeXSmall` | 24 | title (compact), primary text |
| `Size2XSmall` | 21 | |
| `Size3XSmall` | 18 | body / row text |
| `Size4XSmall` | 15 | secondary / captions (minimum) |

`15` is the smallest usable size. Do not use other sizes - they are unsupported
and will break. Width, height, padding, margin, borderRadius and borderWidth are
not restricted this way.

## Resizing

Users resize tiles in edit mode with L1/R1. The loader sizes your tile from the
grid's live size and passes it to your component. L1/R1 step through
**DEFAULT -> LARGE -> FULL** only (the stock editor's range). Reaching XL from the
editor is not supported - an earlier attempt to extend L1/R1 to XL crashed the
hub and was reverted.

## XL via the layout

XL works when the layout says so (useful to start a widget double-wide): in
`widget:customTemplates` each inner array is one screen column of 3 rows. Repeat
your id in all 3 rows of **two adjacent columns** and the hub renders one
double-wide tile (`size: 6`, 1032x504):

```json
{"custom":[["battery","trophy:summary","storage"],
           ["my-widget","my-widget","my-widget"],
           ["my-widget","my-widget","my-widget"]]}
```

Write the layout only while signed out (`python scripts/whctl.py --host <ip>
place <user> '<json>'`), then sign in.

Fill `width` x `height` and adapt your content to it - the tile clips anything
outside.
