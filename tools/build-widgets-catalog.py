#!/usr/bin/env python3
"""Generate widgets.json catalog for the Welcome Hub Widget Store.

Scans sample-widgets/*/config.json and emits widgets.json with raw GitHub file
URLs (CORS-friendly for PS5 browsers) so the built-in Widget Store can install
and update widgets with one click.

  python tools/build-widgets-catalog.py [--branch main] [--out widgets.json]
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SDK = os.path.dirname(HERE)

CATEGORIES = {
    "console-stats": "System",
    "network-info": "System",
    "payload-monitor": "System",
    "payload-launcher": "Tools",
    "home-assistant": "Smart Home",
    "weather": "Weather",
    "hello-wh": "Reference",
    "hello-mini": "Reference",
}

ALLOWED_EXTS = (".json", ".js", ".png", ".jpg", ".jpeg")


def main():
    args = sys.argv[1:]
    branch = "main"
    out_path = os.path.join(SDK, "widgets.json")
    if "--branch" in args:
        i = args.index("--branch")
        branch = args[i + 1]
    if "--out" in args:
        i = args.index("--out")
        out_path = args[i + 1]

    util_h = open(os.path.join(SDK, "framework", "util.h"), encoding="utf-8").read()
    m = re.search(r'#define\s+WH_VERSION\s+"([^"]+)"', util_h)
    version = m.group(1) if m else "1.0.0"

    raw_base = f"https://raw.githubusercontent.com/geodox/ps5-wh-widgets/{branch}/sample-widgets"
    samples_dir = os.path.join(SDK, "sample-widgets")
    widgets = []

    for name in sorted(os.listdir(samples_dir)):
        wdir = os.path.join(samples_dir, name)
        cfg_path = os.path.join(wdir, "config.json")
        if not os.path.isdir(wdir) or not os.path.isfile(cfg_path):
            continue
        cfg = json.load(open(cfg_path, encoding="utf-8"))
        wid = cfg.get("id", name)
        files = {}
        for fn in sorted(os.listdir(wdir)):
            fp = os.path.join(wdir, fn)
            if not os.path.isfile(fp):
                continue
            if fn.startswith(".") or not fn.lower().endswith(ALLOWED_EXTS):
                continue
            files[fn] = f"{raw_base}/{name}/{fn}"
        if "config.json" not in files or "widget.js" not in files:
            continue
        widgets.append({
            "id": wid,
            "name": cfg.get("title", wid),
            "description": cfg.get("description", ""),
            "version": cfg.get("version", version),
            "author": cfg.get("author", "geodox"),
            "category": CATEGORIES.get(wid, "Widgets"),
            "size": cfg.get("size", 1),
            "iconId": cfg.get("iconId", ""),
            "files": files,
        })

    catalog = {
        "name": "Welcome Hub Official Widgets",
        "widgets": widgets,
    }
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(catalog, f, indent=2)
        f.write("\n")
    print(f"wrote {out_path} ({len(widgets)} widgets, version {version})")


if __name__ == "__main__":
    main()
