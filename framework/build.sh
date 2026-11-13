#!/usr/bin/env bash
# Build the Welcome Hub payload ELFs (FreeBSD PIE) with the PS5 payload SDK.
#   bash framework/build.sh [path/to/bridge.delta]   (default: ../out/bridge.delta)
# The delta comes from (Windows/node side, after tools/build_bridge_hbc.js):
#   node tools/make_delta.js <original hub .hbc> out/bridge.hbc out/bridge.delta
# Outputs:
#   out/wh_bridge.elf   framework installer (slot-2 hook + loader + bridge delta)
#   out/wh_kill.elf     SIGKILL SceShellUI -> respawn (hub reload; used by whctl reload)
#   out/<id>.zip        one archive per sample-widgets/<id> folder
# Full chain (run the node + python steps first, then this):
#   node tools/build_bridge_hbc.js <orig.hbc> out/bridge.hbc
#   node tools/make_delta.js <orig.hbc> out/bridge.hbc out/bridge.delta
#   python tools/gen_detour.py framework/wh_detour.h
# Paths resolve relative to this script. Toolchain: scripts/setup_toolchain.sh.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="$(cd "$HERE/.." && pwd)"
DELTA="${1:-$SDK_ROOT/out/bridge.delta}"
LOADER="$SDK_ROOT/out/loader.min.js"
export PS5_PAYLOAD_SDK="${PS5_PAYLOAD_SDK:-$HOME/ps5-payload-sdk}"
export LLVM_CONFIG="${LLVM_CONFIG:-$HOME/bin/llvm-config}"
CC="$PS5_PAYLOAD_SDK/bin/prospero-clang"
[ -f "$DELTA" ] || { echo "MISSING bridge delta: $DELTA"; exit 1; }
[ -f "$LOADER" ] || { echo "MISSING minified loader: $LOADER (node tools/build_loader.js)"; exit 1; }
mkdir -p "$SDK_ROOT/out"
BUILD="$(mktemp -d)"
cp "$HERE"/*.c "$HERE"/*.h "$HERE"/embed.S "$BUILD"/
cp "$DELTA" "$BUILD"/bridge.delta    # embed.S .incbin references these names
cp "$LOADER" "$BUILD"/loader.min.js
echo "embedded delta = $(stat -c %s "$BUILD"/bridge.delta) bytes"
rc=0
( cd "$BUILD"
  "$CC" -Wall -g -o wh_bridge.elf main.c util.c remote.c hookpoint.c \
        prelude.c server.c install.c embed.S 2>&1 | tail -15
  "$CC" -Wall -g -o wh_kill.elf wh_kill.c util.c remote.c 2>&1 | tail -15 )
for e in wh_bridge.elf wh_kill.elf; do
  if [ -f "$BUILD/$e" ]; then cp "$BUILD/$e" "$SDK_ROOT/out/$e"; echo "OK -> out/$e ($(stat -c %s "$SDK_ROOT/out/$e") bytes)"
  else echo "BUILD FAILED: $e"; rc=1; fi
done
rm -rf "$BUILD"
# Package each sample widget as out/<id>.zip (the release asset users drop on the console).
if [ -d "$SDK_ROOT/sample-widgets" ]; then
  for d in "$SDK_ROOT"/sample-widgets/*/; do
    [ -d "$d" ] || continue
    id="$(basename "$d")"
    rm -f "$SDK_ROOT/out/$id.zip"
    if command -v zip >/dev/null 2>&1; then
      ( cd "$SDK_ROOT/sample-widgets" && zip -qr "$SDK_ROOT/out/$id.zip" "$id" )
    else
      ( cd "$SDK_ROOT/sample-widgets" && python3 - "$id" "$SDK_ROOT/out/$id.zip" <<'PY'
import os, sys, zipfile
name, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(name):
        for f in files:
            z.write(os.path.join(root, f))
PY
      )
    fi
    echo "OK -> out/$id.zip"
  done
else
  echo "skip widget zips (no sample-widgets/)"
fi
exit $rc
