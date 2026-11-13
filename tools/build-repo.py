#!/usr/bin/env python3
"""Emit a ps5-payload-manager repository manifest for the Welcome Hub payload.

ps5-payload-manager (itsPLK) shows a version only for payloads installed from a
REPOSITORY SOURCE: it never reads the version out of the ELF. The version is the
"version" string in a catalog entry; local/USB uploads show no version. So to see
"26.11.12 beta" in the manager, host wh_bridge.elf + this repo.json somewhere and
add that repo.json URL as a source in the manager.

  python tools/build-repo.py [out/wh_bridge.elf] [repo.json] [--url <download URL>]
                             [--author <name>]

The manifest's "checksum" is the sha256 of the ELF; the manager verifies it after
download, so regenerate this whenever the ELF changes. Fill --url with the public
URL the ELF will be served from (e.g. a GitHub release asset).
"""
import sys, os, re, json, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
SDK = os.path.dirname(HERE)
args = sys.argv[1:]


def take(flag, default):
    global args
    if flag in args:
        i = args.index(flag)
        val = args[i + 1]
        del args[i:i + 2]
        return val
    return default


url = take("--url", "")
author = take("--author", "geodox")
elf = args[0] if len(args) > 0 else os.path.join(SDK, "out", "wh_bridge.elf")
out = args[1] if len(args) > 1 else os.path.join(SDK, "repo.json")

m = re.search(r'#define\s+WH_VERSION\s+"([^"]+)"', open(os.path.join(SDK, "framework", "util.h"), encoding="utf-8").read())
version = m.group(1) if m else "0"
# The ELF name carries no version; the manager reads the version from the "version" field below.
filename = "wh_bridge.elf"

data = open(elf, "rb").read()
checksum = hashlib.sha256(data).hexdigest()

entry = {
    "name": "Welcome Hub Bridge",
    "filename": filename,
    "url": url or "REPLACE_WITH_PUBLIC_DOWNLOAD_URL/" + filename,
    "description": "Custom native-backed widgets in the PS5 Welcome Hub (drop unzipped widgets into /data/wh-widgets/).",
    "version": version,
    "category": "Customization",
    "checksum": checksum,
    "author": author,
}
manifest = {"name": "Welcome Hub", "payloads": [entry]}
with open(out, "w", encoding="utf-8", newline="\n") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(f"wrote {out}")
print(f"  version  {version}   filename {filename}   author {author}")
print(f"  checksum {checksum}   ({len(data)} bytes)")
if not url:
    print("  NOTE: set the real download URL with --url (or edit repo.json); the manager verifies the checksum after download.")
