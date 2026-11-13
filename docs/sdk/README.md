# Welcome Hub Custom Widget SDK

Build custom widgets for the PS5 Welcome Hub.

A widget is plain JavaScript that renders a React Native component.

The hub is **React Native, not the web**. There is no DOM, no `div`, no CSS, no
`window`/`document`. You get `View`, `Text`, `Image`, React hooks, and host globals
(`fetch`, `setTimeout`, `setInterval`).

## Guides

| page | what it covers |
|---|---|
| [Getting started](getting-started.md) | a minimal widget end to end, and how to deploy it |
| [config.json](config.md) | id, title, icon, size, reserved ids |
| [API reference](api.md) | the `wh` handle, primitives, hooks, logging |
| [Sizes and layout](sizes-and-layout.md) | `WidgetSize`, tile dimensions, XL tiles |
| [Input and focus](input-and-focus.md) | focus, controller buttons, `wh.Focusable` |
| [Settings](settings.md) | per-widget options and persistence |
| [Style guide](style-guide.md) | stock look, type, spacing, colours |
| [Glyphs and images](glyphs.md) | stock icons, image glyphs, asset URLs |
| [Troubleshooting](troubleshooting.md) | `wh.log`, common errors, reloading |
| [Loader internals](loader-internals.md) | how the framework hooks the hub |

## Install

Drop your widget folder into `/data/wh-widgets/` on the console. Each immediate
subfolder is one widget, named by its id:

```
/data/wh-widgets/
  payload-monitor/
    widget.js        # required - the component module
    config.json      # required - id, title, size
    glyph.png        # optional - Edit Widgets list icon
    README.md        # optional - ignored by the loader
```

* Folder name should match `config.json`'s `id`.
* Use a namespaced, collision-safe id (`author.widget`, `payload-monitor`, ...).
* Avoid the [reserved stock ids](config.md#reserved-stock-ids).
* `widget.js` is evaluated once per hub load and must be self-contained - no
  `import` / `require`.

Two complete examples live in [`sample-widgets/`](../../sample-widgets/):
`hello-wh` (minimal, reference for `wh.Focusable`) and `payload-monitor`
(polling, settings, image glyph).
