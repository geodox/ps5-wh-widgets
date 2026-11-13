# config.json

Every widget folder holds a `config.json`:

```jsonc
{
  "id": "payload-monitor",      // required, unique, not a stock id
  "title": "Payload Monitor",   // Edit Widgets list name (default: id)
  "description": "...",         // Edit Widgets description shown on focus (optional)
  "glyph": "glyph.png",         // white-on-transparent PNG in this folder -> icon "wh:<id>"
  "iconId": "trophies",         // OR a stock IconPS glyph (default: "wh:<id>" if glyph, else app_welcome)
  "iconFallback": "grid",       // stock glyph used if the image glyph can't load
  "size": 1,                    // starting WidgetSize (DEFAULT=1, LARGE=2, FULL=3)
  "settings": [ ... ]           // per-widget settings schema (see settings.md)
}
```

| field | required | meaning |
|---|---|---|
| `id` | yes | unique widget id; also the default folder name |
| `title` | no | name shown in the Edit Widgets list (default: `id`) |
| `description` | no | line shown under the title while the entry is focused |
| `glyph` | no | PNG file in the folder, used as icon `wh:<id>` |
| `iconId` | no | stock `IconPS` id; overrides the glyph |
| `iconFallback` | no | stock glyph shown if the image glyph fails (default `app_welcome`) |
| `size` | no | starting `WidgetSize` value (default `1`, see [sizes](sizes-and-layout.md)) |
| `settings` | no | settings schema, see [settings](settings.md) |

Any other field you add is parsed and handed to your component on `props.config`,
so a widget can carry its own configuration (e.g. `"url": "..."`,
`"threshold": 80`). Unknown fields are never touched by the loader.

## Reserved stock ids

Do not reuse these - they belong to the built-in widgets:

`accessibility`, `activity:feed`, `activity:recent`, `recently.played`, `battery`,
`campaigns`, `community activity`, `discovery`, `friends:online`,
`friends:activity`, `highlights`, `media`, `messages`, `news`, `notes`, `psplus`,
`storage`, `store`, `transfers`, `trophy:summary`, `wishlist`, `newWidget`.

## Runtime form

The hub's config object is `{ expandedSize }`, where `expandedSize` is a value
**or** a function returning a `WidgetSize`:

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

The grid reads `WIDGET_CONFIGS[id].expandedSize` on focus. With no config it falls
back to `MINI`. Most authors only need to set `size` in `config.json`.
