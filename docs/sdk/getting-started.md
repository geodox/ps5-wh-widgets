# Getting started

Your `widget.js` must:

1. Grab React + the RN primitives from the SDK handle (they are not importable modules).
2. Build a component.
3. Register it.

No JSX - use `React.createElement`. Minimal example:

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

`globalThis.__wh` is the SDK handle. See the [API reference](api.md) for
everything it carries.

The framework wraps every widget in an error boundary. A bad render stays
isolated to that widget - you only need to ship valid React Native JS.

## config.json

Next to `widget.js`, add a `config.json` with the id, list title and starting
size. See [config.json](config.md) for every field.

```jsonc
{
  "id": "my-widget",
  "title": "My Widget",
  "size": 1
}
```

## Deploy

Copy the folder to `/data/wh-widgets/` on the console, or let the CLI mirror a
tree and validate it first:

```
python scripts/whctl.py --host <console-ip> deploy
```

`deploy` checks each widget (`config.json` is valid JSON with an `id`,
`widget.js` passes `node --check`, a declared glyph file exists) and skips broken
ones - one syntax error stops the whole widget prelude from compiling.

## See it

The hub's JS runtime survives refocusing, so new code needs a new hub runtime:
sign out and back in, or run

```
python scripts/whctl.py --host <console-ip> install out/wh_bridge.elf --race
```

Read `/data/wh-widgets/wh.log` if a widget does not appear
(`python scripts/whctl.py --host <console-ip> log`), and see
[Troubleshooting](troubleshooting.md).
