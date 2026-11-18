# Full-screen pages

A tile is small. When a widget needs room, such as a detail view, a long list or a
log, it can open a **full-screen page**. The page slides in over the hub like the
stock Settings screen, and **Circle** closes it.

Settings do not belong on a page: use the [settings menu](settings.md).

## Register and open

Register the page next to the widget, then open it from a handler:

```js
(function (wh) {
  var ce = wh.React.createElement;

  function MyWidget(props) {
    wh.onPressed(wh.Button.Cross, function () {
      props.openPage({ section: 'details' });   // params for the page
    });
    return ce(wh.Label, null, 'X: details');
  }

  function MyPage(props) {
    return ce(wh.View, { style: { flex: 1, padding: 96 } },
      ce(wh.Label, { style: { fontSize: wh.FontSizePS.SizeLarge } }, 'Details'),
      ce(wh.Label, null, 'Section: ' + props.params.section),
      ce(wh.View, { focusable: true, onPress: props.close, style: { marginTop: 48, padding: 16 } },
        ce(wh.Label, null, 'Close')));
  }

  wh.register(MyWidget);
  wh.registerPage(MyPage);
})(globalThis.__wh);
```

* `wh.registerPage(Page)` registers one page per widget. Call it in `widget.js`,
  like `wh.register`.
* `props.openPage(params)` opens it and returns `true`, or `false` when the page
  cannot open (`wh.log` says why). It is `undefined` when the widget has no page.
  Call it from a handler or an effect, not during render.
* `params` must be plain data (strings, numbers, arrays, objects). Opening the page
  again pushes a new copy.

## Page props

| prop | meaning |
|---|---|
| `params` | the object passed to `openPage` |
| `config` | the widget's parsed `config.json` |
| `close()` | closes the page, like Circle |
| `storage` | the widget's [storage](api.md#storage), shared with the tile |

The page fills the screen on a dark background (`wh.StockTile.MAT_COLOR`) inside
its own focus layer. Give it focusable elements (`View` with `focusable: true` and
`onPress`) so the user can move around it. `wh.Focusable` and `wh.onPressed` are
for tiles: on a page they do nothing.

## Things to know

* **Font sizes must be `wh.FontSizePS` values.** Any other `fontSize` throws
  `Unsupported fontSize: 48. Please use FontSizePS.` and the page shows nothing.
  The same rule applies to tiles.
* The page is separate from the tile: it does not see the tile's state. Pass what
  it needs in `params`, or share it through a variable in `widget.js`.
* `wh.log`: `page opened` and `page closed` for each widget.
