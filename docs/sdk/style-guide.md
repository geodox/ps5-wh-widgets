# Style guide

Match these so a custom widget feels native.

## Shape and spacing

* `borderRadius: 16` on the card
* Inner padding `16` (`wh.StockTile.WIDGET_PADDING`)
* Padding scale used by stock UI: small 8 / medium 16 / large 24
* Keep content comfortably inside the tile height

## Type

Stock widgets don't set a font family or text colour: they use the system font,
the theme colour, and a fixed set of sizes. The loader recreates the hub's own
text components so you get the same look for free:

| component | stock source | what it renders |
|---|---|---|
| `wh.Title` | hub modules 77 + 94 | title row: 40px icon + **bold size-21** text (1 line, ellipsis) + optional right-aligned `badge` |
| `wh.Label` | hub module 21 | body text: size 21, theme colour, 1 line by default, font scaling capped like stock |

```js
ce(wh.Title, { iconId: props.config.iconId, badge: '12 running' }, 'Payload Monitor')
ce(wh.Label, null, 'Once you play a game, your stats will appear here.')
ce(wh.Label, { style: { fontSize: 18, opacity: 0.6 } }, 'secondary info')   // dim, don't recolour
```

* Titles 21 bold, body 21, small/secondary 18; only [FontSizePS](sizes-and-layout.md#font-sizes-fontsizeps)
  values are allowed.
* For secondary text prefer `opacity: 0.6` over a custom grey. Keep colour for
  real status (e.g. a green "running" dot).
* `wh.TextStyles` exposes the raw `title` / `label` / `badge` styles.

Use **hex strings** for any colour. Do not pass web-only style props
(`boxShadow`, `cursor`, `fontFamily`, `textOverflow`, `whiteSpace`,
`letterSpacing`, `animation`) - RNPS may throw.

## Focus

Focus is handled for you: don't add your own `FocusLayerPS` or draw a focus
border. Use `props.focused` to change content while the tile is focused. See
[Input and focus](input-and-focus.md).

## Colours

Stock surfaces use `wh.StockTile.MAT_COLOR` (`#17191E`). Prefer the theme colour
for text and reserve custom colour for status. A typical custom card background is
`#1b1d23`.
