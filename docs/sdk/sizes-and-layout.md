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

`wh.dims(size)` returns the same `{width, height}` table for any size.

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
