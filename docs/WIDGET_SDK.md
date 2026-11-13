# Welcome Hub Custom Widget SDK

Build custom widgets for the PS5 Welcome Hub.

A widget is plain JavaScript that renders a React Native component.

The hub is **React Native, not the web**. There is no DOM, no `div`, no CSS, no `window`/`document`. You get `View`, `Text`, `Image`, React hooks, and host globals (`fetch`, `setTimeout`, `setInterval`).

## 1. Writing `widget.js`

Your file must:

1. Grab React + RN primitives from the SDK handle (they are not importable modules).
2. Build a component.
3. Register it.

No JSX — use `React.createElement`. Minimal example:

```js
// widget.js
(function (wh) {
  var React = wh.React;
  var View = wh.View;
  var Text = wh.Text;

  function MyWidget(props) {
    return React.createElement(
      View,
      {
        style: {
          flex: 1,
          width: 504,
          padding: 16,
          borderRadius: 16,
          backgroundColor: '#1b1d23',
        },
      },
      React.createElement(
        Text,
        { style: { color: '#ffffff', fontSize: 24 } },
        'Hello Hub'
      )
    );
  }

  wh.register(MyWidget);
})(globalThis.__wh);
```

> **Harness note:** `globalThis.__wh` is the SDK handle. It carries `React`, `View`, `Text`, `Image`, `FocusLayerPS`, `StyleSheet`, `FontSizePS`, `IconPS`, `I18nPS`, `Animated`, `ActivityIndicator`, `KeyGuidePS`, `ScrollView`, `LayoutAnimation`, `findNodeHandle`, the literal enums `WidgetSize` and `Metrics` (always present, firmware-independent), `Button`, the stock-look components `Title`, `Label`, `TextStyles`, `Focusable`, `onPressed(button, fn)`, `dims(size)`, `registerGlyph(name, spec)`, `register()`, and the parsed `config`. (Any PS-only primitive may be `undefined` on older firmware — guard before use.) Until the handle is finalized, the reference loader finds the primitives by shape on `globalThis.base_dll` and assigns the component to `globalThis.widgetEncodedLayout`. A `widget.js` written against `wh.*` is adapted automatically.

The framework wraps every widget in an error boundary. A bad render stays isolated to that widget — you only need to ship valid React Native JS.

### Hooks, data, polling

Hooks come from the vendor React handle (`React.useState`, `React.useEffect`, `React.useRef`). `fetch`, `setInterval`, and `setTimeout` are host globals.

Always clean up timers on unmount and guard against setting state after unmount:

```js
function Inner() {
  var state = React.useState(null);
  var data = state[0];
  var setData = state[1];
  var mounted = React.useRef(true);

  React.useEffect(function () {
    mounted.current = true;

    function load() {
      fetch('http://127.0.0.1:8084/processes_list', {
        headers: { Accept: 'application/json' },
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (mounted.current) setData(d.processes || []);
        })
        .catch(function () {});
    }

    load();
    var id = setInterval(load, 3000);

    return function () {
      mounted.current = false;
      clearInterval(id);
    };
  }, []);

  // render from `data`...
}
```

## 2. Font sizes (`FontSizePS`)

Use `wh.FontSizePS.<Name>`. It is the hub's own enum; the loader fills in the same values only if the hub doesn't provide it.

RNPS validates `fontSize` against a whitelist and **throws** on any other value. Only these sizes are allowed:

|Name|px|Typical use|
|-|-|-|
|Size3XLarge|72|Hero numerals|
|Size2XLarge|54||
|SizeXLarge|45||
|SizeLarge|36|Widget title (large tiles)|
|SizeNormal|30|Title|
|SizeSmall|27||
|SizeXSmall|24|Title (compact), primary text|
|Size2XSmall|21||
|Size3XSmall|18|Body / row text|
|Size4XSmall|15|Secondary / captions (minimum)|

`15` is the smallest usable size. Do not use other sizes — they are unsupported and will break. Width, height, padding, margin, borderRadius, and borderWidth are not restricted this way.



## 3. Widget sizes (`WidgetSize`)

Tile dimensions come from the size class. Column width is driven by the widest widget in that column.

|Name|value|width|height|notes|
|-|-|-|-|-|
|MINI|0|auto (max 504)|56|Pill; shrinks to content|
|MINI_EXPANDED|0.1|504|56||
|MINI_EXPANDED_HEIGHT|0.2|auto (max 504)|120||
|DEFAULT|1|504|152|Standard tile|
|LARGE|2|504|328||
|FULL|3|504|504|Square|
|XL|6|1032|504|Double-wide (2 columns)|

Base metrics from the hub:

* `WIDGET_WIDTH = 504`
* `WIDGET_HEIGHT = 152`
* `WIDGET_WIDTH_SPACING = 528` (504 + 24 gutter)
* `WIDGET_SPACING = 24`
* `WIDGET_PADDING = 16`
* `WIDGET_BORDER_RADIUS = 16`
* `MINI_WIDGET_HEIGHT = 56`

These are available as `wh.Metrics` (plus `XL_WIDTH: 1032` and `MAT_COLOR: '#17191E'`); size classes as `wh.WidgetSize`.

Grid transform per cell: `X = column * 528`, `Y = row * 176`, rendered at `scale 0.75`.

**Practical rule:** set your root `View` to `width: 504` (single column) or `width: 1032` (double).



## 4. Reserved stock ids

Do not reuse these — they belong to the built-in widgets:

`accessibility`, `activity:feed`, `activity:recent`, `recently.played`, `battery`, `campaigns`, `community activity`, `discovery`, `friends:online`, `friends:activity`, `highlights`, `media`, `messages`, `news`, `notes`, `psplus`, `storage`, `store`, `transfers`, `trophy:summary`, `wishlist`, `newWidget`.



## 5. Config (`config.json`)

```jsonc
{
  "id": "payload-monitor",      // required, unique, not a stock id
  "title": "Payload Monitor",   // Edit Widgets list name (default: id)
  "description": "...",         // Edit Widgets description shown on focus (optional)
  "glyph": "glyph.png",         // white-on-transparent PNG in this folder -> icon "wh:<id>"
  "iconId": "trophies",         // OR a stock IconPS glyph (default: "wh:<id>" if glyph, else app_welcome)
  "iconFallback": "grid",       // stock glyph used if the image glyph can't load
  "size": 1,                    // starting WidgetSize (DEFAULT=1, LARGE=2, FULL=3)
  "settings": [ ... ]           // per-widget settings schema (see below)
}
```

Any other field you add is parsed and handed to your component on `props.config`, so a widget can carry its own configuration (e.g. `"url": "..."`, `"threshold": 80`). Unknown fields are never touched by the loader.

### `settings` — per-widget settings schema

Declare settings the user can change; the loader validates them and passes the current values to your component on `props.settings` (an object keyed by setting `id`). Each entry:

```jsonc
"settings": [
  { "id": "sort", "title": "Sort by", "type": "choice",
    "options": [ { "value": "memory", "label": "Memory" }, { "value": "name", "label": "Name" } ],
    "default": "memory" },
  { "id": "showPid", "title": "Show PID", "type": "toggle", "default": true }
]
```

* `type` is `"choice"` (needs `options`) or `"toggle"`; omit it and a list of `options` means choice, otherwise toggle.
* `options` may be `{value,label}` objects or bare strings/numbers.
* A missing or malformed entry is skipped with a log line; a `default` outside the options falls back to the first option.

When the widget is focused, **Options** (Start) opens the stock options popup built from this schema (`toggle` -> a Switch row, `choice` -> a Dropdown). Changing a value updates `props.settings` live and re-renders the widget. Values **persist** across hub reloads and reboots: they are saved to `/data/wh-widgets/<id>/.settings.json` by the resident payload and reloaded on mount (merged over the config defaults).

A focused widget also shows a stock **key-guide hint bar** at the bottom of the screen (Settings on Options, Select/Edit on X, and Prev/Next/Done while inside a `wh.Focusable` tile).

### Runtime form

The hub’s config object is `{ expandedSize }`, where `expandedSize` is a value **or** a function returning a `WidgetSize`:

```js
// constant
config = { expandedSize: 2 /* LARGE */ };

// or dynamic
config = {
  expandedSize: function (props, isExpanded) {
    return isExpanded ? 3 /* FULL */ : 1 /* DEFAULT */;
  },
};
```

The grid reads `WIDGET_CONFIGS[id].expandedSize` on focus. With no config it falls back to `MINI`. Most authors only need to set `size` in `config.json`.



## 6. Stock Widget Style Guide

Match these so a custom widget feels native.

### Shape & spacing

* `borderRadius: 16` on the card
* Inner padding `16` (`WIDGET_PADDING`)
* Padding scale used by stock UI: Small 8 / Medium 16 / Large 24
* Keep content comfortably inside the tile height

### Type (use the stock components)

Stock widgets don't set a font family or text colour: they use the system font, the theme colour, and a fixed set of sizes. The loader recreates the hub's own text components so you get the same look for free:

| component | stock source | what it renders |
|-|-|-|
| `wh.Title` | hub modules 77 + 94 | title row: 40px icon + **bold size-21** text (1 line, ellipsis) + optional right-aligned `badge` |
| `wh.Label` | hub module 21 | body text: size 21, theme colour, 1 line by default, font scaling capped like stock |

```js
ce(wh.Title, { iconId: props.config.iconId, badge: '12 running' }, 'Payload Monitor')
ce(wh.Label, null, 'Once you play a game, your stats will appear here.')
ce(wh.Label, { style: { fontSize: 18, opacity: 0.6 } }, 'secondary info')   // dim, don't recolour
```

* Titles 21 bold, body 21, small/secondary 18; only `FontSizePS` values are allowed.
* For secondary text prefer `opacity: 0.6` over a custom grey. Keep colour for real status (e.g. a green "running" dot).
* `wh.TextStyles` exposes the raw `title` / `label` / `badge` styles.

Use **hex strings** for any colour. Do not pass web-only style props (`boxShadow`, `cursor`, `fontFamily`, `textOverflow`, `whiteSpace`, `letterSpacing`, `animation`) — RNPS may throw.

### Focus

Focus is handled for you. The loader wraps every widget in `FocusLayerPS` with a focusable container named after your widget's `id`. Your tile joins the hub's navigation and gets the same native focus highlight that stock widgets use. Don't add your own `FocusLayerPS` or draw a focus border.

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

The loader also reports focus to the hub's grid (so it scrolls your tile into view) and forwards edit-mode presses (Move/Remove), exactly like the stock widget frame.

### Buttons (`wh.Button`, `wh.onPressed`)

`wh.Button` names the controller buttons. The values are the console's own key names (the `keyType` of a key event); the system has no button enum of its own to expose.

| `wh.Button.` | value | can a widget handle it? |
|-|-|-|
| `Cross` | `'Enter'` | yes |
| `Square` | `'Square'` | yes |
| `Options` | `'Options'` | yes (stock widgets open their options menu with it, e.g. Battery's View selector) |
| `L1` / `R1` | `'L'` / `'R'` | yes (inside an entered tile they move the `wh.Focusable` selection) |
| `L2` / `R2` / `L3` / `R3` | `'L2'` / `'R2'` / `'L3'` / `'R3'` | yes, but these are hub shortcuts (R3 opens Edit Widgets); handling one takes it over while your tile is focused. L3 may be unavailable when Showcase Mode is on |
| `Triangle` | `'Triangle'` | only inside an entered tile (otherwise it opens Edit Widgets) |
| `Circle`, `Up`/`Down`/`Left`/`Right` | `'Back'`, arrows | no: Circle goes back (or leaves an entered tile), arrows move between tiles (or between items inside an entered tile) |

Handle a button for the whole tile with `wh.onPressed(button, handler)`. Call it from your component on every render, like any hook, once per button:

```js
wh.onPressed(wh.Button.Cross,  function (e) { setMode(function (m) { return !m; }); });
wh.onPressed(wh.Button.Square, function (e) { refresh(); });
```

* A handler runs only while your tile has focus and the hub is not in edit mode. In edit mode the hub keeps every button (Move/Remove, L1/R1 resize).
* Return `false` from a handler to let the hub handle that button as usual. Returning anything else (or nothing) means you handled it.
* The tile only intercepts a button when your widget registers a handler for it (or needs it: X always, Options when it has settings, arrows/L1/R1/Circle/Triangle while entered). Every other button reaches the hub exactly as on a stock widget, so shortcuts like R3 (Edit Widgets) and Triangle (Utilities) keep working.
* The first time a handler fires, `wh.log` records `button <key> handled`. If a handler throws, the error is logged and the button still counts as handled.

### Selectable items inside a tile (`wh.Focusable`)

A tile with `wh.Focusable` items works like the stock "locked" controls:

1. Focus the tile and press **X** to enter it. The first item is selected.
2. Inside, the **arrows** (and L1/R1) move between items by their position on screen, and **X** presses the selected item. Focus can't leave the tile while you're inside.
3. Press **Circle** to leave. The tile also leaves if it loses focus or the hub goes into edit mode.

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

* Your component gets `props.active` (true while entered), e.g. to show a hint such as "Circle: done".
* While entered, a button goes to the selected item first, then to your `wh.onPressed` handlers. **Triangle** can be handled only while entered (outside, it opens Edit Widgets).
* A tile without `wh.Focusable` items is never entered; X goes to `wh.onPressed(wh.Button.Cross, ...)`.
* `hello-wh` is the reference: X enters, arrows pick a chip, X toggles it, Square (`wh.onPressed`) resets both, Circle leaves.

### Size and resizing

Users resize tiles in edit mode with L1/R1. The loader sizes your tile from the grid's live size and passes it to your component:

| prop | meaning |
|-|-|
| `props.size` | current `WidgetSize` (starts at `config.json` `size`, changes on L1/R1) |
| `props.width` / `props.height` | tile box in px (504×152 / 504×328 / 504×504; XL 1032×504) |
| `props.editing` | `true` while the hub is in edit mode |

L1/R1 step through **DEFAULT → LARGE → FULL** only (the stock editor's range). Reaching XL from the editor is not supported — an earlier attempt to extend L1/R1 to XL crashed the hub and was reverted. Use the layout for XL (below).

**XL via the layout** also works (useful to start a widget double-wide): in `widget:customTemplates` each inner array is one screen column of 3 rows. Repeat your id in all 3 rows of **two adjacent columns** and the hub renders one double-wide tile (`size: 6`, 1032×504):

```json
{"custom":[["battery","trophy:summary","storage"],
           ["my-widget","my-widget","my-widget"],
           ["my-widget","my-widget","my-widget"]]}
```

Write the layout only while signed out (`whctl place <user> '<json>'`), then sign in.

Fill `width` × `height` and adapt your content to it — the tile clips anything outside. `wh.dims(size)` returns the same `{width, height}` for any size.

### Icons and images

Stock glyphs are **white shapes on a transparent background**. Three ways to get one:

1. **A stock glyph** — `"iconId": "trophies"` (any IconPS id: `game`, `storage`, `grid`, `date_time`, `settings`, …).
2. **Your own image glyph** — put a white-on-transparent PNG in your widget folder and set `"glyph": "glyph.png"`. It becomes IconPS id `wh:<your-id>` and shows in the Edit Widgets list *and* in `wh.Title`, tinted white like stock glyphs.
   * App icon on a coloured tile? Convert it: `python tools/make_glyph.py app-icon.png widgets/<id>/glyph.png` (keeps the light glyph, drops the tile, 112px).
   * Icon already transparent but coloured? Ship it as-is; the loader tints it white (`tintColor`).
3. **Any image in your widget** — `props.config.assetBase + 'file.png'` gives its URL:
   `ce(wh.Image, { source: { uri: props.config.assetBase + 'chart.png' }, style: { width: 64, height: 64 } })`.
   Add `tintColor: '#ffffff'` to the style to recolour a transparent-background image.

How it works / limits: the hub's `Image` only loads `http://` URLs (inline `data:` and `file://` don't work), so the framework payload stays resident and serves widget images from `/data/wh-widgets/<id>/` on `http://127.0.0.1:8098/` — loopback only, read-only, `.png`/`.jpg` up to 1 MB, nothing else. If an image glyph fails or stalls (4 s) the stock `iconFallback` glyph is shown instead. `wh.registerGlyph(name, spec)` registers extra `wh:<name>` ids from code (`{image: url, fallback: id}`).

### Gradients

The hub uses gradient mats on some surfaces. If needed, use the RN-PS gradient primitive (not CSS `linear-gradient`).

> Placeholder: confirm the exact gradient component + color-stop API from the stock mats before documenting further.



## 7. Logging and troubleshooting

Everything that can stop a widget loading is written to **`/data/wh-widgets/wh.log`**
(rotates to `wh.log.1` at 256 KB). Read the end of it with `python scripts/whctl.py log`.

| tag | written by | examples |
|-|-|-|
| `[installer]` | the payload | each install step; `skip <folder>: config.json missing`; `glyph file x.png not found`; `install failed (rc=13): evaluateJavaScript prologue mismatch (unsupported firmware?)` |
| `[hub]` | the loader inside the hub | `loader ready in the hub runtime`, `hub registered 2 widget(s) [...]`, `edit list title set ...`, glyph images that failed and fell back |
| `[widget:<id>]` | the loader / your widget | `loaded (size 1, glyph glyph.png)`, `not loaded: widget.js ran but never called wh.register(Component)`, `render error (tile hidden): <message> \| <stack>` |
| `[assets]` | the asset server | refused requests with the reason (`file not found`, `not a .png/.jpg image`), server handoffs |

Log from your own widget:

```js
var log = wh.logger('my-widget');      // lines tagged [widget:my-widget]
log('fetched ' + items.length + ' items');
```

Lines are queued and sent by the loader shortly after; at most 120 lines/minute are kept.

**Syntax errors can't be logged** (one syntax error stops the whole widget prelude from
compiling), so `whctl deploy` checks every widget first — valid `config.json` with an `id`,
`widget.js` syntax (`node --check`), glyph file present — and skips broken ones with the
exact error. Use `--force` to upload anyway.

**New code needs a new hub runtime.** The hub's JS runtime survives refocusing (it only
re-renders), so after deploying or installing, sign out and back in (or `whctl install --race`).

## 8. Open items

* **Per-widget settings (planned):** stock widgets open an options menu with Options (Start), e.g. Battery's Detail/Compact View. The goal is to let a custom widget declare its settings and get the same stock menu, with the choice saved per user.

Known gaps. Documented so authors know the current limits.

**Overlays / in-tile selectors**
Stock widgets open these through the frame + a portal/overlay layer (e.g. battery view selector, expanded detail panels). Not exposed yet.

**Normal-mode press actions**
Edit-mode presses (Move/Remove) and L1/R1 resize work. Outside edit mode, the grid's `onPress` drives stock actions keyed by id, so it is not forwarded to custom tiles yet.

**Extra config fields**
Unknown `config.json` fields are not passed through yet; keep widget-specific settings as constants in `widget.js`.

## Installing a widget

Drop your widget folder into `/data/wh-widgets/`. Each immediate subfolder is one widget, named by its id:

```
/data/wh-widgets/
  payload-monitor/
    widget.js        # required – the component module
    config.json      # required – id, title, size
    icon.png         # optional – Edit Widgets list icon
    README.md        # optional – ignored by the loader
```

* Folder name should match `config.json`’s `id`.
* Use a namespaced, collision-safe id (`author.widget`, `payload-monitor`, etc.).
* Avoid the reserved stock ids listed above.
* `widget.js` is evaluated once per hub load and must be self-contained — no `import` / `require`.

