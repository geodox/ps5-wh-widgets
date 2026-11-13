# Settings

Declare settings the user can change; the loader validates them and passes the
current values to your component on `props.settings` (an object keyed by setting
`id`). Add a `settings` array to `config.json`:

```jsonc
"settings": [
  { "id": "sort", "title": "Sort by", "type": "choice",
    "options": [ { "value": "memory", "label": "Memory" }, { "value": "name", "label": "Name" } ],
    "default": "memory" },
  { "id": "showPid", "title": "Show PID", "type": "toggle", "default": true }
]
```

* `type` is `"choice"` (needs `options`) or `"toggle"`; omit it and a list of
  `options` means choice, otherwise toggle.
* `options` may be `{value,label}` objects or bare strings/numbers.
* A missing or malformed entry is skipped with a log line; a `default` outside
  the options falls back to the first option.

## Options menu

When the widget is focused, **Options** (Start) opens the stock options popup
built from this schema (`toggle` -> a Switch row, `choice` -> a Dropdown).
Changing a value updates `props.settings` live and re-renders the widget.

Values **persist** across hub reloads and reboots: they are saved to
`/data/wh-widgets/<id>/.settings.json` by the resident payload and reloaded on
mount (merged over the config defaults).

```js
function MyWidget(props) {
  var sort = props.settings.sort;        // "memory" | "name"
  var showPid = props.settings.showPid;  // boolean
  // ...
}
```
