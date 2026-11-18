# API reference

`globalThis.__wh` (usually just `wh`) is the SDK handle. It carries:

| member | what it is |
|---|---|
| `React` | the vendor React module (`createElement`, `useState`, `useEffect`, ...) |
| `View`, `Text`, `Image` | the RN-PS primitives |
| `FocusLayerPS`, `StyleSheet`, `FontSizePS`, `IconPS`, `I18nPS`, `Animated`, `ActivityIndicator`, `KeyGuidePS`, `ScrollView`, `LayoutAnimation`, `findNodeHandle` | vendor primitives |
| `WidgetSize` | literal enum (firmware-independent), see [sizes](sizes-and-layout.md) |
| `StockTile` | literal stock tile measurements, see [sizes](sizes-and-layout.md) |
| `Button` | friendly controller-button names, see [input](input-and-focus.md) |
| `Title`, `Label`, `TextStyles`, `Focusable` | stock-look components, see [style guide](style-guide.md) |
| `onPressed(button, fn)` | handle a controller button while the tile is focused |
| `dims(size)` | `{width, height}` for a `WidgetSize` |
| `registerGlyph(name, spec)` | register a `wh:<name>` icon from code |
| `register(Component)` | register your widget component |
| `registerPage(Page)` | register the widget's full-screen page, see [pages](pages.md) |
| `logger(id)` | write to `wh.log` with a `[widget:<id>]` tag |
| `launch(uri)` | ask the console to launch a URI, see [Launching apps](#launching-apps) |
| `notify(text)` | show a system notification, see [Notifications](#notifications) |
| `AlertDialogPS` | the stock alert dialog, see [Dialogs](#dialogs) |
| `config` | your parsed `config.json` |

Any PS-only primitive may be `undefined` on older firmware - guard before use.
The loader locates the primitives on the vendor module the hub already requires;
a `widget.js` written against `wh.*` needs no version-specific glue.

## Hooks, data, polling

Hooks come from the vendor React handle (`React.useState`, `React.useEffect`,
`React.useRef`, ...). `fetch`, `setInterval` and `setTimeout` are host globals.

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

## Props

The loader passes these to your component:

| prop | meaning |
|---|---|
| `size` | current `WidgetSize` |
| `width`, `height` | tile box in px |
| `editing` | true while the hub is in edit mode |
| `focused` | true while the tile has focus |
| `active` | true while the tile is entered with X (`wh.Focusable`) |
| `config` | your parsed `config.json`, including unknown fields |
| `settings` | current settings values (see [settings](settings.md)) |
| `onPressEdit` | the hub's edit action, if your tile forwards it |
| `openPage(params)` | opens the widget's [full-screen page](pages.md); `undefined` without one |
| `storage` | the widget's own key/value store, see [Storage](#storage) |
| `visible`, `setVisible(bool)` | MINI widgets only: show or hide the pill, see [MINI widgets](sizes-and-layout.md#showing-and-hiding-a-mini-widget) |

## Storage

`props.storage` keeps small values for your widget across reboots. The hub stores
them for the signed-in user (AsyncStorage key `wh:data:<your id>`), so each user has
their own, and they survive a boot without the payload. The page gets the same
store.

```js
function Counter(props) {
  var s = wh.React.useState(0), n = s[0], setN = s[1];
  wh.React.useEffect(function () {
    props.storage.get('count', 0).then(setN);      // fallback when unset
  }, []);
  wh.onPressed(wh.Button.Cross, function () {
    setN(n + 1);
    props.storage.set('count', n + 1);
  });
  return wh.React.createElement(wh.Label, null, 'Pressed ' + n + ' times');
}
```

| method | returns | |
|---|---|---|
| `get(key, fallback)` | promise of the value, or `fallback` when unset | |
| `set(key, value)` | promise, resolved once stored | `value` must be JSON (no functions, no `undefined`); `set(key, undefined)` removes |
| `remove(key)` | promise | |

Writes are applied in call order, and each one stores the widget's whole object, so
keep it small (settings-sized, not caches of images or long logs). For
user-facing options, use [settings](settings.md) instead: they get a menu for free.

## Logging

```js
var log = wh.logger('my-widget');      // lines tagged [widget:my-widget]
log('fetched ' + items.length + ' items');
```

Lines are queued and sent by the loader shortly after; at most 120 lines/minute
are kept. See [Troubleshooting](troubleshooting.md).

## Launching apps

```js
// in your component; props.config.launchUri is a field in your config.json
wh.onPressed(wh.Button.Cross, function () {
  wh.launch(props.config.launchUri).then(function (ok) {
    if (!ok) log('launch failed');
  });
});
```

`wh.launch(uri)` hands the URI to the console's own launcher (ShellUI
`LaunchByUri`) and returns a promise that resolves to `true` once the console
accepted it, or `false`. Any URI with a scheme is passed through; it must not
contain spaces or control characters and is at most 511 characters. Launches are
rate limited to 6 per minute across all widgets. Every launch is written to
`wh.log` as `launch: <uri> rc=<n>`.

Launch from a user action (a button press), not on a timer or on mount. Any
installed widget can launch any URI, so users should only install widgets they
trust.

## Notifications

```js
wh.notify('Backup finished
12 files').then(function (ok) { /* true once sent */ });
```

`wh.notify(text)` shows the console's system notification (the toast at the top
right, the same one payloads use). The text is plain UTF-8, at most 256 bytes,
and may contain newlines; other control characters are refused. Notifications are
rate limited to 6 per minute across all widgets and logged as `notify: <text>`.

Notify about something the user would want to know right away (a job finished, a
download failed), not about every change: they also appear outside the hub.

## Dialogs

`wh.AlertDialogPS` is the stock alert dialog. Render it while it should show, and
stop rendering it when the user answers:

```js
function Cleaner(props) {
  var s = wh.React.useState(false), asking = s[0], setAsking = s[1];
  wh.onPressed(wh.Button.Square, function () { setAsking(true); });
  function answer(yes) {
    return function () { setAsking(false); if (yes) { /* delete */ } };
  }
  return wh.React.createElement(wh.View, null,
    wh.React.createElement(wh.Label, null, 'Square: clean up'),
    asking ? wh.React.createElement(wh.AlertDialogPS, {
      title: 'Delete old logs?',
      buttons: {
        positive: { text: 'Delete', onPress: answer(true) },
        negative: { text: 'Cancel', onPress: answer(false) }
      },
      onRequestClose: answer(false)
    }, wh.React.createElement(wh.Text, null, 'This cannot be undone.')) : null);
}
```

| prop | meaning |
|---|---|
| `title` | dialog title |
| children | the body, usually one `wh.Text` |
| `buttons.positive`, `buttons.negative` | `{text, onPress}`; `negative` is optional |
| `onRequestClose` | called when the user dismisses the dialog (Circle) |

The dialog opens over the whole screen and takes focus. The buttons are
console-verified from a tile; `onRequestClose` is the hub's own wiring and was not
exercised separately.
