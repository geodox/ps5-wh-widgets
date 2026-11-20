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
| `register(Component, options)` | register your widget component. `options.keyGuide`: the key guide bar inside the focused tile, see [Key guide](input-and-focus.md#key-guide) (off by default) |
| `registerPage(Page)` | register the widget's full-screen page, see [pages](pages.md) |
| `logger(id)` | write to `wh.log` with a `[widget:<id>]` tag |
| `launch(uri)` | ask the console to launch a URI, see [Launching apps](#launching-apps) |
| `notify(text)` | show a system notification, see [Notifications](#notifications) |
| `playSound(name)` | play a stock UI sound, see [Sounds](#sounds) |
| `useHubState()` | `{visible, focused}`, the `hubVisible` / `hubFocused` props as a hook (for pages), see [Hub state](#hub-state) |
| `getLocale()`, `useLocale()` | the console's language and date and time formats, see [Locale](#locale) |
| `AlertDialogPS` | the stock alert dialog, see [Dialogs](#dialogs) |
| `TextInput` | a text field with the system keyboard, for pages, see [pages](pages.md#text-input) |
| `List`, `MenuListItemPS`, `Picker` | the stock scrolling list and its Settings-style rows, for pages, see [pages](pages.md#lists) |
| `config` | your parsed `config.json` |

`wh.IconPS.iconIds` is the console's list of valid stock icon ids; see
[icons](icons.md).

Any PS-only primitive may be `undefined` on older firmware - guard before use.
The loader locates the primitives on the vendor module the hub already requires;
a `widget.js` written against `wh.*` needs no version-specific glue.

## Hooks, data, polling

Hooks come from the vendor React handle (`React.useState`, `React.useEffect`,
`React.useRef`, ...). `fetch`, `WebSocket`, `XMLHttpRequest`, `setInterval` and
`setTimeout` are host globals.

* `fetch` and `WebSocket` reach servers on the local network, not only
  `127.0.0.1` (console-verified on 13.20; the Home Assistant sample uses both).
* A request to a host or port that does not answer fails only after **60 s**,
  the hub's own timeout. Put your own shorter timeout on it, and show "can't
  reach" instead of a blank tile.
* **Never open a `WebSocket` to a host that may not answer.** Opening one blocks
  the hub's JavaScript until the connection attempt gives up, about 75 s. Input
  freezes, and ShellUI may be killed. `fetch` doesn't block, so check the server
  with `fetch` first, with your own timeout, and open the socket only once it
  has answered. The Home Assistant sample does this.

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

### Long lists on a tile you can't enter: `wh.usePages`

A tile without `wh.Focusable` items gets no arrows (they move focus between
tiles). When its list does not fit, show it a page at a time:

```js
var pager = wh.usePages ? wh.usePages(items.length, rowsThatFit) : null;
var visible = pager ? items.slice(pager.first, pager.end) : items.slice(0, rowsThatFit);
// title badge: (pager && pager.label) || items.length + ' items'   -> "1-4 of 9"
```

* The page turns by itself every `interval` ms (default 6000; `0` = never), only
  while the hub's tiles are on screen.
* **L1** / **R1** turn it while the tile is focused, wrapping around. A turn by hand
  pauses the automatic one for `pause` ms (default 15000).
* Options: `wh.usePages(total, perPage, { interval, pause })`.
* Returns `{ page, pages, first, end, label }`; `label` is `null` when everything
  fits.
* It claims L1 / R1 for the tile, so don't also use them with `wh.onPressed`.
  Guard for older payloads: `wh.usePages` may be `undefined`.
* `payload-monitor` is the reference.

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
| `hubVisible` | false while a screen (a widget page, Settings, the screensaver) covers the hub's tiles: pause polling, see [Hub state](#hub-state) |
| `hubFocused` | false while the user is on the game row, or the Control Center or the system keyboard is open; the tiles stay on screen, see [Hub state](#hub-state) |
| `visible`, `setVisible(bool)` | MINI widgets only: show or hide the pill, see [MINI widgets](sizes-and-layout.md#showing-and-hiding-a-mini-widget) |

## Hub state

Two props tell a widget whether the user can see it:

| prop | false while | tiles on screen? |
|---|---|---|
| `hubVisible` | a widget page, Settings or the screensaver is on top of the hub | no |
| `hubFocused` | the user is on the game row, the Control Center is open, or the system keyboard is open | yes |

Stop polling while `hubVisible` is false, and resume when it turns true:

```js
var hubVisible = props.hubVisible !== false;   // undefined on older loaders
React.useEffect(function () {
  if (!hubVisible) return;
  load();
  var id = setInterval(load, 3000);
  return function () { clearInterval(id); };
}, [hubVisible]);
```

`hubFocused` is for things only worth doing while the user looks at the hub area,
such as an animation. Keep a clock running when it is false: the tile still shows.

While a game runs, the hub does not run at all: its timers stop, and when the user
comes back to Home the hub starts again and your widget mounts fresh. Nothing needs
pausing for games.

A page reads the same state with `wh.useHubState()`. On a page `visible` is false
(the page covers the tiles), so a page uses `focused`.

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

The data stays when the widget's folder is removed. Users see and delete it in
**Welcome Hub Settings > Widget Data**, which lists each widget's stored data for
the signed-in user, with its size and whether the widget is still installed.
After a delete, `get` reads the store again; a tile on screen keeps what it
already shows until the user signs out and back in.

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

Console URIs a widget can use (console-verified on 13.20 with a title id such as
`PPSA01325`):

| goal | URI |
|---|---|
| start a game | `psgm:play?id=<titleId>` |
| open a game's game hub | `psgamehub:main?titleId=<titleId>`, or `?conceptId=<id>` / `?productId=<id>` |

There is no URI for a game's PlayStation Store page: the hub opens the game hub,
and its Store button leads on.

Launch from a user action (a button press), not on a timer or on mount. Any
installed widget can launch any URI, so users should only install widgets they
trust.

## Notifications

```js
wh.notify('Backup finished\n12 files').then(function (ok) { /* true once sent */ });
```

`wh.notify(text)` shows the console's system notification (the toast at the top
right, the same one payloads use). The text is plain UTF-8, at most 256 bytes,
and may contain newlines; other control characters are refused. Notifications are
rate limited to 6 per minute across all widgets and logged as `notify: <text>`.

Notify about something the user would want to know right away (a job finished, a
download failed), not about every change: they also appear outside the hub.

## Sounds

```js
wh.onPressed(wh.Button.Cross, function () {
  wh.playSound('enter');
  // ...
});
```

`wh.playSound(name)` plays one of the console's own UI sounds and returns `true`
when it played. Use them the way the system does: as feedback to a button press,
not as alerts.

| name | stock sound |
|---|---|
| `move`, `blocked` | focus moved / focus cannot move further |
| `enter`, `back` | confirm / cancel |
| `error` | error |
| `optionsOpen`, `optionsClose` | options menu opens / closes |
| `dialogOpen`, `errorDialogOpen` | dialog opens / error dialog opens |
| `positive`, `negative`, `neutral` | dialog buttons |
| `switchOn`, `switchOff`, `checkOn`, `checkOff` | toggles and check boxes |
| `toastInfo`, `toastAction`, `toastError` | notification sounds |

An unknown name plays nothing and returns `false`, as does a sound this firmware
does not have. At most one sound plays every 100 ms. System-event sounds (game
start, trophies, log out) are left out on purpose.

## Locale

```js
function Clock(props) {
  var locale = wh.useLocale();          // re-renders when the user changes the format
  var use12 = locale.timeFormat === 12;
  // ...
}
```

| field | value |
|---|---|
| `locale` | the console language, e.g. `'en-US'` |
| `timeFormat` | `12` or `24`: Settings > System > Date and Time |
| `dateFormat` | `'YYYY/MM/DD'`, `'DD/MM/YYYY'` or `'MM/DD/YYYY'` |

`wh.getLocale()` returns the same object once, outside a component. The formats
are `null` for a moment after the hub starts, until the console has answered, and
on firmware where the loader cannot read them. Plan a fallback (Hello Hub shows
24 h). `useLocale` picks up a change in Settings without a sign-out.

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

The dialog opens over the whole screen and takes focus. Console-verified from a
tile: both buttons, and Circle through `onRequestClose`.
