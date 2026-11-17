#!/usr/bin/env bash
# Build the Welcome Hub payload ELFs (FreeBSD PIE) with the PS5 payload SDK.
#   bash framework/build.sh [deltas dir]   (default: ../out/deltas)
# The deltas (one per supported firmware) and their table come from (node side):
#   node tools/build_deltas.js      # tools/fidmaps/*.json + hub dumps in dumps/
# Outputs:
#   out/wh_bridge.elf   framework installer (slot-2 hook + loader + bridge deltas)
#   out/wh_kill.elf     SIGKILL SceShellUI -> respawn (hub reload; used by whctl reload)
#   out/<id>.zip        one archive per sample-widgets/<id> folder
# Full chain (run the node + python steps first, then this):
#   node tools/build_deltas.js
#   node tools/build_loader.js
#   python tools/gen_detour.py framework/wh_detour.h
# Paths resolve relative to this script. Toolchain: scripts/setup_toolchain.sh.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="$(cd "$HERE/.." && pwd)"
DELTAS="${1:-$SDK_ROOT/out/deltas}"
LOADER="$SDK_ROOT/out/loader.min.js"
export PS5_PAYLOAD_SDK="${PS5_PAYLOAD_SDK:-$HOME/ps5-payload-sdk}"
export LLVM_CONFIG="${LLVM_CONFIG:-$HOME/bin/llvm-config}"
CC="$PS5_PAYLOAD_SDK/bin/prospero-clang"
[ -f "$DELTAS/deltas.S" ] && [ -f "$DELTAS/deltas.h" ] || { echo "MISSING bridge deltas in $DELTAS (node tools/build_deltas.js)"; exit 1; }
[ -f "$LOADER" ] || { echo "MISSING minified loader: $LOADER (node tools/build_loader.js)"; exit 1; }
mkdir -p "$SDK_ROOT/out"
BUILD="$(mktemp -d)"
cp "$HERE"/*.c "$HERE"/*.h "$HERE"/embed.S "$BUILD"/
cp "$DELTAS"/deltas.S "$DELTAS"/deltas.h "$DELTAS"/fw*.delta "$BUILD"/   # deltas.S .incbin names
cp "$LOADER" "$BUILD"/loader.min.js                                     # embed.S .incbin name
for d in "$BUILD"/fw*.delta; do echo "embedded $(basename "$d") = $(stat -c %s "$d") bytes"; done
rc=0
( cd "$BUILD"
  "$CC" -Wall -g -o wh_bridge.elf main.c util.c remote.c hookpoint.c \
        prelude.c server.c install.c bridge.c embed.S deltas.S -lSceUserService 2>&1 | tail -15
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
