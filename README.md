<div align="center">

![ps5-wh-widgets — custom widgets for the PS5 Welcome Hub](img/readme-banner.svg)

# ps5-wh-widgets

### Turn your PS5 Welcome Hub into something more.

**One ELF. Your hub, your widgets.**

Add your own widgets to the PS5 Welcome Hub — injected into the running hub at runtime. Nothing on disk is patched, and a reboot returns the console to stock.

[![PS5](https://img.shields.io/badge/Platform-PlayStation%205-174B91?style=for-the-badge)](#before-installing)
[![Firmware](https://img.shields.io/badge/Firmware-11.20%20%7C%2011.40%20%7C%2013.20%20%7C%2013.40%20%7C%2013.60-168E78?style=for-the-badge)](#before-installing)
[![MIT License](https://img.shields.io/badge/License-MIT-556477?style=for-the-badge)](LICENSE)

[**Installation Prerequisites**](#before-installing) · [**Developer SDK**](docs/sdk/README.md)

</div>

---

## Before Installing

> [!IMPORTANT]
> **Install and run [WelcomeHubActivator](https://github.com/ghost1372/WelcomeHubActivator) by [@ghost1372](https://github.com/ghost1372) first.** The PS5 Welcome Hub must be activated before custom widgets can run.

- **Supported firmware: PS5 11.20, 11.40, 13.20, 13.40 and 13.60.** See [Testing and current status](#testing-and-current-status) for what each has been verified on, and how to help add another firmware.
- A PS5 with a homebrew environment and a way to load an ELF payload is required.
- Use the payload from this repository's releases — a stock bridge build does not include the widget loader and will not load widgets.

## Installing

There is nothing else to install: the widget loader lives inside the payload. It stays resident as the widget asset server, and everything it does is in memory — a reboot removes it, so run the payload again to bring the widgets back.

### Payload Manager (custom source)

[PS5 Payload Manager](https://github.com/itsPLK/ps5-payload-manager) can install and update the payload from this repository's catalog ([`repo.json`](repo.json)):

1. Open Payload Manager, then **Settings** (gear icon) > **Manage Sources**.
2. Choose **Add Source**, paste this URL and press **Add**:

   ```text
   https://raw.githubusercontent.com/geodox/ps5-wh-widgets/main/repo.json
   ```

3. Find **Welcome Hub Bridge** (source "Welcome Hub") and install it.

### Manual

Send `wh_bridge.elf` from the [releases](https://github.com/geodox/ps5-wh-widgets/releases) with your payload loader (elfldr, or whatever you normally use).

### Adding Widgets

Open **Welcome Hub Settings → Widget Store** on the console, or visit `http://<ps5-ip>:8098/` (or `http://127.0.0.1:8098/__store` in the console browser / BrowserPS5) from any phone, tablet, or PC on your network to browse, install, update, and remove widgets from the official [`widgets.json`](widgets.json) catalog or your own custom `widgets.json` sources — no FTP needed. See [Publishing a Widget Repository](docs/sdk/widget-repos.md) to host your own widget catalog.

You can also install widgets manually by placing each unpacked widget in its own folder on the console:

```text
/data/wh-widgets/
  example-widget/
    config.json
    widget.js
    glyph.png       # optional
```

The folder name should match its widget id. Changes are picked up while the payload is running; see [Applying widget changes](#-applying-widget-changes). See the [SDK getting-started guide](docs/sdk/getting-started.md) for deployment and troubleshooting.

### Custom Animated Backgrounds

Drop `.mp4` videos into `/data/wh-backgrounds/` on the console to add them to the Welcome Hub's native **Change Background → From PlayStation** picker:

```text
/data/wh-backgrounds/
  my-loop.mp4                 # required — H.264/MP4 video
  my-loop.jpg                 # optional — thumbnail & placeholder (.jpg/.png; or -thumbnail.jpg / -placeholder.jpg)
  my-loop.audio               # optional — empty file to unmute the video's audio (muted by default)
```

Custom backgrounds appear at the start of the **From PlayStation** list and are served over loopback by the resident payload. Selecting one persists through the console's own background settings.

## Testing And Current Status

The payload and loader have been run on-console: the hook installs into SceShellUI, both sample widgets render inside the native hub frame, settings persist, and a widget source change is rebuilt and swapped in place without restarting the shell.

**Firmware:** each firmware ships its own Welcome Hub, so the payload carries one hub patch per supported firmware and picks the one for your console at install time.

| Firmware | Status |
| :--- | :--- |
| **11.20** | Verified on-console. |
| **11.40** | Verified on-console. |
| **13.20** | Verified on-console. |
| **13.40** | Verified on-console. |
| **13.60** | Verified on-console. |

On any other firmware the payload does not install. It shows `WHBridge failed: FW x.yy not supported yet` with the supported list, rather than loading and silently showing no widgets. Even on a supported firmware, the hub is only patched if it is byte-for-byte the build the patch was made from; anything else is left stock.

### Help Support Your Firmware

Adding a firmware needs a dump of that firmware's stock hub. With ps5debug-NG running on the console (port 744), reboot the console, **do not** load `wh_bridge.elf`, open the Welcome Hub once, then run:

```text
python scripts/dump_hub.py --host <console-ip> --out .
```

It only reads from the console and writes `hub_fw<NNNN>_<hash>.hbc` on your PC. Open an issue to arrange sending it. The file is Sony's bytecode, so please **do not attach it publicly**.

## 🚀 What Powers ps5-wh-widgets

### Native Welcome Hub Integration

- Renders your widgets inside the Welcome Hub's native frame and header.
- Passes widget configuration through `props.config` and per-widget settings through `props.settings`.
- Provides a native settings menu and persists widget settings in `.settings.json`.
- Supports controller navigation, focusable buttons, and native Hub interaction.
- Records detailed installation failures to support troubleshooting.

## 🔄 Applying Widget Changes

Widget folders are watched while the payload is resident: a `config.json` or `widget.js` change is noticed within a second and, once it has been stable for five seconds, rebuilt into a fresh prelude, swapped into the running shell, and **automatically applied by reloading the embedded Welcome Hub** — no sign-out, no payload reload, no shell restart.

You can also trigger a reload manually anytime from **Welcome Hub Settings → Reload Welcome Hub**. Leaving the hub and coming back does not reload it on its own; that runtime is kept.

> [!TIP]
> `[widget:<id>] not loaded` means that widget threw while evaluating, or never called `wh.register` — the other widgets still load. A **syntax** error is different: it stops the whole prelude from compiling, so nothing loads. Run `whctl deploy` first; it checks every `widget.js` with `node --check` and skips the broken ones with the exact error.

## 🧩 Sample Widgets

These widgets ship with the project, ready to use and as starting points for your own:

<div align="center">

![Payload Launcher and Home Assistant cards in the Welcome Hub](img/widgets-cards.jpg)

![Console Stats and Payload Monitor in the Welcome Hub](img/widgets-stats.jpg)

</div>

| Widget | What it does |
| :--- | :--- |
| **Payload Monitor** | Lists the homebrew payloads running on the console with their PID and memory use, updating live. A long list turns pages by itself; L1 / R1 page it while the tile is focused. |
| **Console Stats** | CPU and SoC temperature, fan speed, optional SoC power & CPU/GFX clocks, free space and a usage bar per drive (console storage, M.2, USB), and uptime. Pauses while the tiles are covered. |
| **Network Info** | Local IP address, Wi-Fi signal strength (percentage, dBm, bar), SSID, band/channel, NAT type, and connection uptime — read directly from ShellUI's native network modules, completely offline. |
| **Home Assistant** | Shows and controls your Home Assistant entities, as cards: lights, switches, sensors, climate, covers, locks, media players and more. X toggles or runs one; the full-screen page adds brightness, volume and position sliders, target temperature and mode, and the entity chooser. Unlocking and opening a garage door ask first. Needs a token in its `config.json`: see its [README](sample-widgets/home-assistant/README.md). |
| **Weather** | Current weather and forecast for your saved places, anywhere in the world: search by city or postal code, switch places with L1 / R1. Background photos for the current weather, a 5-day forecast and hourly details at the larger sizes, units from the console's region or your choice. Based on VintendoPower's Weather widget; see its [README](sample-widgets/weather/README.md). |
| **Payload Launcher** | Shows the payload web pages answering on the console (Payload Manager, PKG Manager, ShadowMount+, ...) as cards; press X on one to open it in the console's browser. |

### Reference Widgets

The smallest complete widgets, written to show how the SDK works:

| Widget | What it does |
| :--- | :--- |
| **Hello Hub** | A live clock built with the SDK: stock title row, stock text, an icon, hooks, a timer and a settings menu (clock format, following the console's 12/24-hour setting by default; seconds). The smallest complete widget. |
| **Hello Mini** | A MINI widget: a pill with an icon and a live clock in the hub's MINI row, sized to its content like the stock ones. |

Drop any of these folders into `/data/wh-widgets/` to use it; the sources are in [`sample-widgets/`](sample-widgets/).

## Building Your Own

Widgets are React Native components: plain JavaScript built with `React.createElement` and the SDK handle `globalThis.__wh` — not web HTML, CSS or DOM APIs. A widget's entry file registers its component with `wh.register(Component)`.

- [SDK overview](docs/sdk/README.md)
- [Getting started](docs/sdk/getting-started.md)
- [API reference](docs/sdk/api.md)
- [config.json](docs/sdk/config.md)
- [Sizes and layout](docs/sdk/sizes-and-layout.md)
- [Input and focus](docs/sdk/input-and-focus.md)
- [Settings and persistence](docs/sdk/settings.md)
- [Glyphs and images](docs/sdk/glyphs.md)
- [Style guide](docs/sdk/style-guide.md)
- [Troubleshooting](docs/sdk/troubleshooting.md)
- [Sample widgets](sample-widgets/)

### Source Layout

```text
framework/      payload sources: hook/installer, prelude, loader, asset server
docs/           SDK documentation (docs/sdk/)
sample-widgets/ example widget projects
scripts/        whctl (deploy, install, logs) and console/toolchain helpers
tools/          HBC, detour and payload build utilities, per-firmware maps (fidmaps/), tests/
img/            screenshots and documentation images
repo.json       Payload Manager custom source (payload catalog)
```

## 📸 Community Showcase

Screenshots from other setups, shared by the [NiDUS](https://github.com/manchildtechnologies-ui/NiDUS) project:

<div align="center">
<table><tr><td width="50%"><img src="https://raw.githubusercontent.com/manchildtechnologies-ui/NiDUS/main/img/20261113_110144_00592274.webp" alt="Community widgets in the Welcome Hub" width="100%"></td><td width="50%"><img src="https://raw.githubusercontent.com/manchildtechnologies-ui/NiDUS/main/img/20261113_110150_00429265.webp" alt="Widget Store and game tiles in the Welcome Hub" width="100%"></td></tr></table>
</div>

*Images courtesy of [NiDUS](https://github.com/manchildtechnologies-ui/NiDUS) — not produced by this project.*

## ❤️ Credits

- **[VintendoPower](https://github.com/manchildtechnologies-ui)** — co-author.
- **[@ghost1372](https://github.com/ghost1372)** — [WelcomeHubActivator](https://github.com/ghost1372/WelcomeHubActivator), which enables the Welcome Hub where it is not already active, and the projects it credits.
- **[NiDUS](https://github.com/manchildtechnologies-ui/NiDUS)** — the community screenshots in the showcase above, and the in-place refresh approach (fingerprint + revision-stamped prelude) this loader's widget reload is based on.
- **PS5 homebrew community** — [ps5-payload-sdk](https://github.com/ps5-payload-dev/ps5-payload-sdk) and the payload tooling this project builds with.

### Dumps & Testers

Thanks to everyone who provided stock hub dumps and on-console testing:

- **[@pm5krj](https://github.com/pm5krj)**
- **[@TRIPSLORD](https://github.com/TRIPSLORD)**

This is an independent, unofficial community homebrew project. It is not affiliated with or endorsed by Sony Interactive Entertainment or PlayStation.

## License

Released under the MIT license — see [LICENSE](LICENSE).
