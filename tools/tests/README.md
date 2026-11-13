# Native tests

`match_test.c` runs the generated detour helper `WH_C_MATCH` (framework/wh_detour.h)
natively against the real hub + bridge + delta, with a fake `jsi::Buffer`. It checks:
small buffer ignored, hub buffer rebuilt byte-exact from the delta then swapped,
second hit not rebuilt, and source-hash / size mismatch -> no swap (counter bumped).

The original hub bundle is **not** in this repo. Get the decrypted
`application.ps.bundle` / hub `.hbc` for your firmware from your own console dump
and pass it as the first argument; all three inputs are read-only.

    node tools/build_bridge_hbc.js <orig.hbc> out/bridge.hbc
    node tools/make_delta.js       <orig.hbc> out/bridge.hbc out/bridge.delta
    python tools/gen_detour.py     framework/wh_detour.h
    mkdir -p out
    gcc -O1 -o out/match_test tools/tests/match_test.c -Iframework
    out/match_test <orig.hbc> out/bridge.hbc out/bridge.delta   # -> "ALL OK"
