# Publishing a Widget Repository (`widgets.json`)

The built-in **Widget Store** (`http://<ps5-ip>:8098/` or **Welcome Hub Settings → Widget Store**) loads widget catalogs from `widgets.json` URLs. Anyone can publish a custom widget repository — on GitHub or any CORS-enabled web server — and users can add its `widgets.json` URL in the Store's **Sources** panel.

## Minimal `widgets.json`

```json
{
  "name": "My Widget Repo",
  "widgets": [
    {
      "id": "my-widget",
      "name": "My Widget",
      "description": "Short summary shown on the Store card.",
      "version": "1.0.0",
      "author": "your-handle",
      "category": "Tools",
      "size": 1,
      "iconId": "discover",
      "files": {
        "config.json": "https://raw.githubusercontent.com/<user>/<repo>/main/widgets/my-widget/config.json",
        "widget.js": "https://raw.githubusercontent.com/<user>/<repo>/main/widgets/my-widget/widget.js",
        "glyph.png": "https://raw.githubusercontent.com/<user>/<repo>/main/widgets/my-widget/glyph.png"
      }
    }
  ]
}
```

## Schema reference

### Top-level object

| Field | Required | Description |
| :--- | :--- | :--- |
| `name` | optional | Display name for your repository (shown as the source tag on each card). Defaults to the `widgets.json` URL if omitted. |
| `widgets` | **yes** | Array of widget entries. |

### Widget entry

| Field | Required | Description |
| :--- | :--- | :--- |
| `id` | **yes** | Widget folder name and `config.json` id (`[A-Za-z0-9._-]{1,64}`, no leading `.`, no `/` or `..`). Must match `config.json`'s `id` and avoid [reserved stock ids](config.md#reserved-stock-ids). |
| `name` | **yes** | Display name shown on the Store card. |
| `description` | optional | One-line description shown on the Store card. |
| `version` | optional | Version string (e.g. `"1.0.0"` or `"26.11.22"`). Used for **Update** detection (see [Versioning and updates](#versioning-and-updates)). |
| `author` | optional | Author handle or name. |
| `category` | optional | Category filter pill (e.g. `"System"`, `"Tools"`, `"Smart Home"`, `"Weather"`, `"Media"`). Defaults to `"Other"`. |
| `size` | optional | `0` (`MINI`), `1` (`DEFAULT`), `2` (`LARGE`), or `3` (`FULL`). Shown as a badge on the card. |
| `iconId` | optional | Stock icon id from [icons.md](icons.md) (metadata only; actual tile icon comes from `config.json` / `glyph.png`). |
| `files` | one of `files` or `zip` | Map of `<filename>: <url>` for every file to install into `/data/wh-widgets/<id>/`. **Recommended for GitHub repos.** |
| `zip` (or `url`) | one of `files` or `zip` | URL to a `.zip` archive containing the widget's files (stored or deflate-compressed). |

> [!NOTE]
> If two sources contain the same widget `id`, the first source wins (the official catalog is loaded first, followed by custom sources in the order they were added). Use a distinctive or namespaced `id` (such as `yourname-widget`) so your widgets never collide.

## Packaging: `files` vs `zip` (and CORS)

Because the Widget Store runs inside a browser (on the PS5 or on a phone/PC on the LAN) and fetches packages with `fetch()`, **every URL you list must send `Access-Control-Allow-Origin: *`**.

- **`files` with `raw.githubusercontent.com` (recommended):** GitHub's raw file CDN sends `Access-Control-Allow-Origin: *`, works in every browser (including the PS5 native browser and BrowserPS5), and needs no build step. List `config.json`, `widget.js`, and any `.png`/`.jpg` assets.
- **`zip` (or `url`):** Works when hosted on a server or CDN that returns `Access-Control-Allow-Origin: *` (for example GitHub Pages, Cloudflare R2/Pages, or a local web server). **Do not point `zip` at a `github.com/.../releases/download/...` URL** — GitHub Releases redirects to `objects.githubusercontent.com` without CORS headers, so browsers will block the download.
- Zip archives can have files at the archive root or inside a single subfolder (`my-widget/config.json`); the Store strips directory prefixes and ignores hidden dotfiles.

## File and size limits

When the Store uploads each file to the console (`POST /__store/file`), `server.c` enforces:

- **Required files:** `config.json` and `widget.js` must both be present.
- **Allowed filenames:** `[A-Za-z0-9._-]{1,64}`, no leading `.`, no subdirectories (all widget files live flat in `/data/wh-widgets/<id>/`).
- **Allowed extensions:** `.json`, `.js`, `.png`, `.jpg`, `.jpeg`, `.md`, `.txt`.
- **Max file size:** **1 MB** per file (`WH_ASSET_MAX`).

## Versioning and updates

When the Store installs a widget, it writes `/data/wh-widgets/<id>/.meta.json` with `{ "version": "...", "source": "..." }`.

- On subsequent visits, the Store compares each catalog entry's `version` string against the installed `.meta.json` `version` (falling back to `config.json`'s `version` if `.meta.json` is absent).
- If both are non-empty and differ, the card displays an **Update available** badge and an **Update** button.
- Re-installing or updating overwrites the files in `/data/wh-widgets/<id>/` and **preserves** the user's saved settings (`.settings.json`) and `props.storage` data.

## Generating `widgets.json` automatically

For repositories with multiple widgets, you can adapt [`tools/build-widgets-catalog.py`](../../tools/build-widgets-catalog.py). In this repo it scans `sample-widgets/*/config.json` and writes the root `widgets.json`:

```bash
python tools/build-widgets-catalog.py --branch main --out widgets.json
```

## Adding a custom source in the Store

1. Open the Widget Store:
   - On the PS5: **Welcome Hub Settings → Widget Store** (or `http://127.0.0.1:8098/__store` in BrowserPS5)
   - From a phone, tablet, or PC on the same LAN: `http://<ps5-ip>:8098/`
2. Click **Sources**.
3. Paste the raw URL to your `widgets.json` (for example `https://raw.githubusercontent.com/<user>/<repo>/main/widgets.json`) and click **Add Source**.
4. Custom sources are saved on the console in `/data/wh-widgets/.store.json` and persist across payload reloads and reboots.
