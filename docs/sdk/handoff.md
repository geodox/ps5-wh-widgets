# Handoff: building a widget

Read this first if you are a model (or a person) asked to build a Welcome Hub
widget. It gives the working order, the rules that break widgets on the console,
and a skeleton to start from. The other pages in this folder are the reference;
this page links to them where you need detail.

## What you are building

- A widget is a folder with two files, `config.json` and `widget.js`, copied to
  `/data/wh-widgets/<id>/` on the console.
- `widget.js` is plain JavaScript evaluated inside the hub. It renders a **React
  Native** component, not a web page: there is no DOM, no CSS, no `window` and no
  `document`. You get `View`, `Text`, `Image`, React hooks, `fetch`, `setTimeout`
  and `setInterval`, plus the SDK handle `wh`.
- The payload (`wh_bridge.elf`) and the loader (`framework/loader.js`) are already
  done. You do **not** change them to build a widget. If the widget needs
  something the SDK does not offer, stop and say so; do not patch the framework
  unless you are asked to.

## Read in this order

1. [Getting started](getting-started.md): the smallest widget, end to end.
2. The sample closest to your task, in [`sample-widgets/`](../../sample-widgets/):
   - `hello-wh`: selectable items, settings, a full-screen page;
   - `payload-monitor`: polling a local HTTP endpoint, a list, an image glyph;
   - `console-stats`: polling the payload's `/__stats`, layouts per tile size;
   - `payload-launcher`: launching URIs, port probing;
   - `home-assistant`: a `WebSocket` to a LAN server, a page with `wh.List`
     rows (switch, dropdown, slider), search, storage, confirm dialogs;
   - `weather`: internet data with a timeout, place search on a page, images
     done safely (see the image rules in [glyphs](glyphs.md#3-any-image-in-your-widget));
   - `hello-mini`: a MINI widget (the small pill row).
3. [API reference](api.md): every `wh.*` member and every prop.
4. [Style guide](style-guide.md): the stock look you must match.
5. As needed: [config.json](config.md), [sizes and layout](sizes-and-layout.md),
   [input and focus](input-and-focus.md), [settings](settings.md),
   [pages](pages.md), [glyphs and images](glyphs.md), [icons](icons.md),
   [troubleshooting](troubleshooting.md).

## Rules that break widgets

Each of these was learned on a console. Follow them even where React Native on
other platforms behaves differently.

**Code**
- `widget.js` must be self-contained: no `import`, no `require`. Wrap it in
  `(function (wh) { ... })(globalThis.__wh);` and call `wh.register(Component)`
  exactly once.
- Write ES5 like the samples (`var`, `function`, string concatenation). It is the
  only style tested in the hub. Keep the source ASCII; build special characters
  with `String.fromCharCode`.
- One syntax error stops **every** widget from loading. Run `node --check
  widget.js` before deploying.
- Guard newer APIs (`wh.List`, `wh.TextInput`, ...): a user may run an older
  payload, where they are `undefined`.

**Rendering**
- `fontSize` must be a `wh.FontSizePS` value (`SizeLarge`, `SizeSmall`,
  `Size3XSmall`, ...). Any other number throws `Unsupported fontSize` and the tile
  or page disappears.
- `overflow: 'hidden'` does **not** clip. Do not rely on it to hide content; do not
  render what should not show.
- Do not draw a background or mat on the tile. The stock frame draws it.
- Fill the box you are given: `props.width` × `props.height`. Tiles are 504 wide,
  and 152 (DEFAULT), 328 (LARGE) or 504 (FULL) high. A widget that turns on the
  [key guide](input-and-focus.md#key-guide) gets a bar about 48 px high along the
  bottom while focused: keep important content above it.
- Only use icon ids listed in [icons](icons.md). An unknown id draws nothing.
- Dropdown items (`wh.MenuListItemPS.Dropdown`) are `wh.Picker.Item` **elements**,
  not plain `{label, value}` objects. Plain objects throw.

**Behaviour**
- Settings belong in `config.json` `settings`: the user opens them with Options,
  in the stock menu. Do not build a settings page.
- Poll only while `props.hubVisible !== false`, and clear every timer in the effect
  cleanup. While a game runs, the hub does not run at all; the widget mounts fresh
  when the user comes back.
- The console is usually **offline from PlayStation Network**, and Sony's servers
  are blocked on consoles running homebrew. Do not depend on PSN or on Sony
  downloads. Use local data: the payload's endpoints on `http://127.0.0.1:8098`,
  other payloads' local ports, or LAN servers the user configures.
- A request to a host that does not answer fails only after 60 s. Give every
  network call your own short timeout and show that the server can't be reached.
- Opening a `WebSocket` to a host that does not answer freezes the hub for about
  75 s. Check the server with `fetch` first ([API](api.md#hooks-data-polling)).
- No images in edit mode, and never remove an image right after adding it: that
  can crash ShellUI ([glyphs](glyphs.md#3-any-image-in-your-widget)).
- Launch, notify and sound only on a user action (a button press), never on a
  timer or on mount.
- Pick a unique id (`author.widget` style), not a [reserved stock
  id](config.md#reserved-stock-ids). The folder name must match it. Never rename
  it later: placements are stored by id.

**Logging**
- Use `var log = wh.logger('<id>')`. Lines over 440 characters are cut, and at most
  120 lines a minute are kept. Log state changes, not every render.

## Skeleton

```js
// my-widget - one line on what it shows.
(function (wh) {
  var React = wh.React, ce = React.createElement, F = wh.FontSizePS;
  var log = wh.logger('my-widget');

  var styles = wh.StyleSheet.create({
    body: { flex: 1, padding: 16 },
    value: { fontSize: F.SizeSmall, marginTop: 8 },
    caption: { fontSize: F.Size3XSmall, opacity: 0.6 }
  });

  function MyWidget(props) {
    var settings = props.settings || {};
    var st = React.useState(null), data = st[0], setData = st[1];
    var hubVisible = props.hubVisible !== false;

    React.useEffect(function () {
      if (!hubVisible) return;                 // tiles covered: no polling
      var live = true;
      function load() {
        fetch('http://127.0.0.1:8098/__stats')
          .then(function (r) { return r.json(); })
          .then(function (d) { if (live) setData(d); })
          .catch(function (e) { log('load failed: ' + (e && e.message)); });
      }
      load();
      var id = setInterval(load, 5000);
      return function () { live = false; clearInterval(id); };
    }, [hubVisible]);

    var cfg = props.config || {};
    return ce(wh.View, { style: [styles.body, { width: props.width || 504, height: props.height || 152 }] },
      ce(wh.Title, { iconId: cfg.iconId || 'app_welcome' }, cfg.title || 'My Widget'),
      ce(wh.Label, { style: styles.value }, data ? String(data.uptime) : '-'),
      ce(wh.Label, { style: styles.caption }, 'Uptime (s)'));
  }

  wh.register(MyWidget);
})(globalThis.__wh);
```

```json
{
  "id": "my-widget",
  "title": "My Widget",
  "description": "One line shown in the Edit Widgets list.",
  "iconId": "ps5",
  "size": 1,
  "settings": [
    { "id": "unit", "title": "Units", "type": "choice",
      "options": [ { "value": "a", "label": "A" }, { "value": "b", "label": "B" } ],
      "default": "a" }
  ]
}
```

## Need → use

| The widget needs to | Use |
|---|---|
| show a stock title row, text | `wh.Title`, `wh.Label` ([style guide](style-guide.md)) |
| let the user pick items inside the tile | `wh.Focusable`, `wh.onPressed` ([input](input-and-focus.md)) |
| user options | `config.json` `settings`, read from `props.settings` ([settings](settings.md)) |
| remember data across reboots | `props.storage.get / set` ([API](api.md#storage)) |
| a full-screen view (details, a list, a form) | `wh.registerPage`, `props.openPage` ([pages](pages.md)) |
| a scrolling Settings-style list on a page | `wh.List` + `wh.MenuListItemPS` ([pages](pages.md#lists)) |
| text entry on a page | `wh.TextInput` ([pages](pages.md#text-input)) |
| a yes / no question | `wh.AlertDialogPS` ([API](api.md#dialogs)) |
| a system notification | `wh.notify` ([API](api.md#notifications)) |
| a UI sound | `wh.playSound` ([API](api.md#sounds)) |
| 12/24-hour time, date order, language | `wh.useLocale` ([API](api.md#locale)) |
| start a game or open its game hub | `wh.launch` ([API](api.md#launching-apps)) |
| pause work when the hub is hidden or unfocused | `props.hubVisible`, `props.hubFocused` ([API](api.md#hub-state)) |
| live data from a server on the LAN | `WebSocket` or `fetch` with a timeout ([API](api.md#hooks-data-polling)) |
| a level on a page (brightness, volume) | `wh.MenuListItemPS.Slider` ([pages](pages.md#sliders)) |
| temperatures, fan, storage | `GET http://127.0.0.1:8098/__stats` ([loader internals](loader-internals.md)) |
| more items than fit, on a tile with `wh.Focusable` items | a scrolling window with item `buttons` + `autoSelect` ([input](input-and-focus.md#selectable-items-inside-a-tile-whfocusable)) |
| more rows than fit, on a tile you can't enter | `wh.usePages` ([API](api.md#long-lists-on-a-tile-you-cant-enter-whusepages)) |
| a small pill instead of a tile | a MINI size ([sizes](sizes-and-layout.md#mini-widgets)) |
| its own icon | `glyph` PNG in the folder ([glyphs](glyphs.md)) |

## Test loop

You cannot see the console screen. The user can; the log is yours.

1. `node --check widget.js` and check that `config.json` is valid JSON.
2. Copy the folder to the console:
   `python scripts/whctl.py --host <console-ip> deploy <parent folder> --only <id>`
   (or FTP to `/data/wh-widgets/<id>/`). The payload picks the change up about six
   seconds after it settles.
3. Wait ~6–8 seconds for the payload to rebuild the prelude and **automatically
   reload the embedded Welcome Hub** (no sign-out needed). If needed, the user can
   also press **Welcome Hub Settings → Reload Welcome Hub** (or sign out and back
   in as a fallback).
4. Ask the user to add the widget from **Edit Widgets** the first time (custom
   widgets are in the **Custom Widgets** list: press L2 / R2 there).
5. Read the log: `python scripts/whctl.py --host <console-ip> log`, or
   `/data/wh-widgets/wh.log` over FTP. Look for `[widget:<id>] loaded`, then for
   `render error` or `not loaded` lines (see [troubleshooting](troubleshooting.md)).
6. Ask the user to check what you cannot: give short numbered steps (focus the
   tile, press X, resize with L1 / R1 in edit mode, open Options) and say what
   they should see at each one. Ask for a screenshot when the layout matters.

## Done when

- [ ] `node --check` passes and `config.json` parses.
- [ ] The widget loads (`[widget:<id>] loaded`) with no `render error`.
- [ ] It looks right at every size it allows, and stays clear of the focus key
      guide at the bottom.
- [ ] Every `fontSize` is a `wh.FontSizePS` value; no tile background.
- [ ] Timers stop when the widget unmounts and while `props.hubVisible` is false.
- [ ] Settings, if any, open from Options and change the widget live.
- [ ] Nothing depends on PSN or on Sony servers.
- [ ] Only the widget folder changed (no framework edits unless asked).
