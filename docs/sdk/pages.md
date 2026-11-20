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

## Looking like a stock page

The hub's own full-screen screens (Settings, Followed games, Wishlist) share one
layout. Copy it to make a page feel native:

* **No title bar and no key guide.** Stock screens draw neither; Circle goes back.
  If your page needs a title, use one `Text` with `wh.FontSizePS.Size2XLarge`.
* **A centered content box 1500 px wide and 918 px high, 162 px from the top.**
* **List rows 93 px high**, full width, with a 40 px margin above the list.

```js
var styles = wh.StyleSheet.create({
  root: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  container: { width: 1500, height: 918, marginTop: 162 },
  list: { flex: 1, width: '100%', marginVertical: 40 },
  row: { flexDirection: 'row', alignItems: 'center', width: '100%', height: 93 }
});
```

Settings fills that box with a [list](#lists) of `wh.MenuListItemPS` rows. These
are the stock values, read from the hub's code; Hello Hub's page centers its
content instead.

## Lists

`wh.List` is the console's scrolling list, the one the Settings screen uses. The
list scrolls and moves the focus by itself; each row brings its own focusable
element, usually a `wh.MenuListItemPS` row.

```js
var ce = wh.React.createElement, M = wh.MenuListItemPS;
var ROWS = ['Wi-Fi', 'Sound', 'Close'];

function SettingsPage(props) {
  var s = wh.React.useState(false), quiet = s[0], setQuiet = s[1];
  var d = wh.React.useState('med'), level = d[0], setLevel = d[1];
  // A row re-renders only when its value changes (!==): put what it shows in the row.
  var rows = wh.React.useMemo(function () {
    return [{ kind: 'switch', on: quiet }, { kind: 'level', value: level }, { kind: 'close' }];
  }, [quiet, level]);
  function renderItem(row, index) {
    if (row.kind === 'switch')
      return ce(M.Switch, { label: 'Quiet mode', value: row.on, onValueChange: setQuiet });
    if (row.kind === 'level')
      return ce(M.Dropdown, {
        label: 'Level', value: row.value, onValueChange: setLevel,
        items: [['Low', 'low'], ['Medium', 'med'], ['High', 'high']].map(function (x) {
          return ce(wh.Picker.Item, { key: x[1], label: x[0], value: x[1] });
        })
      });
    return ce(M.Button, { label: 'Close', description: 'Circle also closes', onPress: props.close });
  }
  return ce(wh.View, { style: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' } },
    ce(wh.View, { style: { width: 1500, height: 918, marginTop: 162 } },
      ce(wh.List, { data: rows, renderItem: renderItem, style: { flex: 1, width: '100%' } })));
}
```

| `wh.List` prop | meaning |
|---|---|
| `data` | the rows, an array of anything |
| `renderItem(row, index)` | returns the row's element |
| `onFocusIndex(index)` | the focused row changed |
| `initialIndex` | the row focused first |
| `style`, `itemMargin`, ... | passed on to the stock list |

A ref has `setFocusIndex({itemIndex, animated})` to move the focus and
`scrollTo({firstVisibleItemIndex})` to scroll.

Rows (`wh.MenuListItemPS`), each with `label` and an optional `description`:

| row | own props |
|---|---|
| `Button` | `onPress` |
| `Switch` | `value` (true / false), `onValueChange(value)` |
| `Dropdown` | `items` (an array of `wh.Picker.Item` elements `{label, value}`), `value`, `onValueChange(value)` |
| `Selectable` | `selected`, `onPress` |
| `Slider` | `value`, `minimumValue`, `maximumValue`, `step`, `onValueChanging(value)`, `onValueChange(value)` |

* Up and down (and the left stick) move between rows; the list scrolls with the
  focus. Focus stops at the first and last rows: it does not wrap. L1 / R1 do
  nothing.
* A row re-renders only when its row value is a different value than before (`!==`).
  Keep rows as plain data and build elements in `renderItem`, as above, so a long
  list stays fast.
* Console-verified on 13.20 with 50 rows: `Button`, `Switch`, `Dropdown`, focus
  reporting, `setFocusIndex` and `scrollTo`. `Slider` is verified in the Home
  Assistant sample.

### Sliders

X on a `Slider` row starts adjusting it, left and right move it, and X sets the
value.

* The range props are `minimumValue` and `maximumValue`. `min` and `max` are
  ignored; without the range props the slider uses its own default range.
* Each press moves the slider one `step`. Keep a slider to about 100 steps: a
  range of 1 to 1000 in steps of 1 hardly moves.
* `onValueChanging(value)` fires while the slider moves, with in-between values
  (`70.65`, `70.42`, ...): round them. `onValueChange(value)` fires once, when X
  sets the value. Act on that one.
* Changing a slider row's props while the user adjusts it ends the adjustment. To
  show the value as it changes, put it outside the list (the Home Assistant page
  shows it under the title), not in the row's `description`.

## Text input

A page can hold a text field. `wh.TextInput` is the console's own: X on the
focused field opens the system keyboard, and the keyboard writes back into it.

```js
function SearchPage(props) {
  var s = wh.React.useState(''), text = s[0], setText = s[1];
  return wh.React.createElement(wh.View, { style: { flex: 1, alignItems: 'center', justifyContent: 'center' } },
    wh.React.createElement(wh.TextInput, {
      value: text,
      placeholder: 'Search',
      keyboardWindowTitle: 'Search',           // the keyboard window's title
      focusable: true,
      style: { width: 900, height: 72, paddingHorizontal: 16 },
      onChangeText: setText,                   // every change while typing
      onSubmitEditing: function (e) {          // the keyboard's Done key
        search(e.nativeEvent.text);
      }
    }));
}
```

| prop | meaning |
|---|---|
| `value`, `onChangeText(text)` | the text, kept in your state; called on every change |
| `placeholder` | shown while empty |
| `keyboardWindowTitle` | title of the keyboard window |
| `onSubmitEditing(e)`, `onEndEditing(e)` | Done pressed: `e.nativeEvent.text` is the final text |
| `onFocus`, `onBlur` | the field gained or lost focus |

Console-verified on 13.20 on a page. A field inside a tile is untested, and so are
the ref methods `beginEdit()` and `endEdit()`, which should open and close the
keyboard from code.

## Things to know

* **Font sizes must be `wh.FontSizePS` values.** Any other `fontSize` throws
  `Unsupported fontSize: 48. Please use FontSizePS.` and the page shows nothing.
  The same rule applies to tiles.
* The page is separate from the tile: it does not see the tile's state. Pass what
  it needs in `params`, or share it through a variable in `widget.js`.
* While the page is open it covers the tiles, so every tile's `props.hubVisible` is
  false and tiles that follow it stop polling. A page that polls checks
  `wh.useHubState().focused` instead (see [Hub state](api.md#hub-state)).
* `wh.log`: `page opened` and `page closed` for each widget.
