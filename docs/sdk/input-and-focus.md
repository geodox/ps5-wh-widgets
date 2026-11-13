# Input and focus

## Focus is handled for you

The loader wraps every widget in `FocusLayerPS` with a focusable container named
after your widget's `id`. Your tile joins the hub's navigation and gets the same
native focus highlight that stock widgets use. Don't add your own `FocusLayerPS`
or draw a focus border.

To change something while the tile is focused, read `props.focused`:

```js
function MyWidget(props) {
  return React.createElement(
    Text,
    { style: { color: props.focused ? '#ffffff' : '#9ca3af', fontSize: 24 } },
    'Hello Hub'
  );
}
```

The loader also reports focus to the hub's grid (so it scrolls your tile into
view) and forwards edit-mode presses (Move/Remove), exactly like the stock widget
frame.

## Buttons

`wh.Button` names the controller buttons. The values are the console's own key
names (the `keyType` of a key event); the system has no button enum of its own to
expose.

| `wh.Button.` | value | can a widget handle it? |
|---|---|---|
| `Cross` | `'Enter'` | yes |
| `Square` | `'Square'` | yes |
| `Options` | `'Options'` | yes (stock widgets open their options menu with it, e.g. Battery's View selector) |
| `L1` / `R1` | `'L'` / `'R'` | yes (inside an entered tile they move the `wh.Focusable` selection) |
| `L2` / `R2` / `L3` / `R3` | `'L2'` / `'R2'` / `'L3'` / `'R3'` | yes, but these are hub shortcuts (R3 opens Edit Widgets); handling one takes it over while your tile is focused. L3 may be unavailable when Showcase Mode is on |
| `Triangle` | `'Triangle'` | only inside an entered tile (otherwise it opens Edit Widgets) |
| `Circle`, `Up`/`Down`/`Left`/`Right` | `'Back'`, arrows | no: Circle goes back (or leaves an entered tile), arrows move between tiles (or between items inside an entered tile) |

### `wh.onPressed`

Handle a button for the whole tile with `wh.onPressed(button, handler)`. Call it
from your component on every render, like any hook, once per button:

```js
wh.onPressed(wh.Button.Cross,  function (e) { setMode(function (m) { return !m; }); });
wh.onPressed(wh.Button.Square, function (e) { refresh(); });
```

* A handler runs only while your tile has focus and the hub is not in edit mode.
  In edit mode the hub keeps every button (Move/Remove, L1/R1 resize).
* Return `false` from a handler to let the hub handle that button as usual.
  Returning anything else (or nothing) means you handled it.
* The tile only intercepts a button when your widget registers a handler for it
  (or needs it: X always, Options when it has settings, arrows/L1/R1/Circle/
  Triangle while entered). Every other button reaches the hub exactly as on a
  stock widget, so shortcuts like R3 (Edit Widgets) and Triangle (Utilities) keep
  working.
* The first time a handler fires, `wh.log` records `button <key> handled`. If a
  handler throws, the error is logged and the button still counts as handled.

## Selectable items inside a tile (`wh.Focusable`)

A tile with `wh.Focusable` items works like the stock "locked" controls:

1. Focus the tile and press **X** to enter it. The first item is selected.
2. Inside, the **arrows** (and L1/R1) move between items by their position on
   screen, and **X** presses the selected item. Focus can't leave the tile while
   you're inside.
3. Press **Circle** to leave. The tile also leaves if it loses focus or the hub
   goes into edit mode.

```js
ce(wh.Focusable, {
  onPress: function () { toggle(); },                   // X while this item is selected
  buttons: { Square: function () { details(); } },      // other buttons, keyed by wh.Button value
  style: styles.chip,
  focusedStyle: styles.chipSelected                     // added while selected
}, function (selected) {                                 // children may be a function of `selected`
  return ce(wh.Label, null, selected ? 'Selected' : 'Item');
})
```

* Your component gets `props.active` (true while entered), e.g. to show a hint
  such as "Circle: done".
* While entered, a button goes to the selected item first, then to your
  `wh.onPressed` handlers. **Triangle** can be handled only while entered
  (outside, it opens Edit Widgets).
* A tile without `wh.Focusable` items is never entered; X goes to
  `wh.onPressed(wh.Button.Cross, ...)`.
* `hello-wh` is the reference: X enters, arrows pick a chip, X toggles it, Square
  (`wh.onPressed`) resets both, Circle leaves.

## Key guide

A focused widget shows a stock key-guide hint bar at the bottom of the screen
(Settings on Options, Select/Edit on X, and Prev/Next/Done while inside a
`wh.Focusable` tile).
