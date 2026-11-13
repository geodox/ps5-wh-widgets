# Glyphs and images

Stock glyphs are **white shapes on a transparent background**. Three ways to get
one.

## 1. A stock glyph

Set `"iconId": "<id>"` in `config.json`, or pass `iconId` to `wh.Title` /
`wh.IconPS`.

These ids are the ones the stock widgets use (extracted from the FW 13.20 hub
bundle, `F20067`). They have not each been spot-checked on device, but they are
the ids the hub itself passes to `IconPS`:

| stock widget | `iconId` |
|---|---|
| Accessibility | `accessibility` |
| Recently Played / Activity | `game` |
| Battery | `battery_full` |
| Discovery | `discover` |
| Friends Online | `friend` |
| Friends Activity | `feeds_activities` |
| Media | `app_media_gallery` |
| Messages | `messages` |
| News | `from_ps` |
| PS Plus | `ps_plus` |
| Storage | `storage` |
| Store | `ps_store` |
| Trophies | `trophies` |
| Wishlist | `favorite` |
| Community Activity | `trending` |

Other ids seen in the hub UI: `app_welcome` (default), `ps_button`,
`key_arrow_up`, `key_arrow_down`, `key_arrow_left`, `key_arrow_right`,
`battery_full_charged`. Any id the stock `IconPS` accepts works.

## 2. Your own image glyph

Put a white-on-transparent PNG in your widget folder and set
`"glyph": "glyph.png"`. It becomes IconPS id `wh:<your-id>` and shows in the Edit
Widgets list *and* in `wh.Title`, tinted white like stock glyphs.

* Icon already transparent but coloured? Ship it as-is; the loader tints it white
  (`tintColor`).
* An app icon on a coloured tile needs converting: keep the light glyph, drop the
  tile background, and export at 112px with transparency. There is no bundled
  converter; use your image editor.
* If the image glyph fails or stalls (4 s) the stock `iconFallback` glyph is shown
  instead.

## 3. Any image in your widget

`props.config.assetBase + 'file.png'` gives its URL:

```js
ce(wh.Image, {
  source: { uri: props.config.assetBase + 'chart.png' },
  style: { width: 64, height: 64 },
})
```

Add `tintColor: '#ffffff'` to the style to recolour a transparent-background
image.

## How images are served

The hub's `Image` only loads `http://` URLs (inline `data:` and `file://` don't
work), so the framework payload stays resident and serves widget images from
`/data/wh-widgets/<id>/` on `http://127.0.0.1:8098/` - loopback only, read-only,
`.png`/`.jpg` up to 1 MB, nothing else.

## Registering glyphs from code

`wh.registerGlyph(name, spec)` registers extra `wh:<name>` ids from code:

```js
wh.registerGlyph('chart', { image: props.config.assetBase + 'chart.png', fallback: 'trending' });
ce(wh.IconPS, { iconId: 'wh:chart', style: { width: 40, height: 40 } });
```

`spec` is `{image: url, fallback: id}`.

## Gradients

The hub uses gradient mats on some surfaces. Use the RN-PS gradient primitive if
you find it exposed on the vendor module - not CSS `linear-gradient`.
