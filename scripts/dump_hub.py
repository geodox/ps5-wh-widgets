"""Dump the decrypted Welcome Hub HBC bundle from a live console over ps5debug-NG.

This produces the per-firmware input that tools/build_bridge_hbc.js needs to build
a delta for a firmware we do not yet support (see GitHub issue #2). It reads only;
it never writes to the console.

Requirements on the console:
  - ps5debug-NG running (port 744) -- the same homebrew loader that runs elfldr.
  - The Welcome Hub has been opened at least once this boot, so its bundle is
    resident in SceShellUI. If the dump finds nothing, open the Hub and retry.

Usage:
  python scripts/dump_hub.py [--host <ip>] [--out <dir>]

The console address comes from --host or $WH_HOST (see scripts/ps5dbg.py).
"""
import hashlib
import os
import struct
import sys

from ps5dbg import PS5Dbg, DbgError

HBC_MAGIC = bytes.fromhex("c61fbc03c103191f")   # Hermes HBC, verified on FW 13.20
HBC_VER = 89                                    # HBC bytecode version (Hermes 0.11)
HUB_NEEDLE = b"widget:customTemplates"          # only the Welcome Hub bundle has it
BRIDGE_NEEDLE = b"__whWidgetMap"                # only our patched bridge has it
FLEN_OFF = 32                                   # u32 fileLength in the HBC header
MIN_LEN = 0x100000                              # 1 MB  -- below this is not the hub
MAX_LEN = 0x800000                              # 8 MB  -- above this is not the hub
MAX_REGION = 0x8000000                          # 128 MB: skip huge reserved mappings


def _host(argv):
    host = None
    if "--host" in argv:
        i = argv.index("--host")
        host = argv[i + 1]
        del argv[i:i + 2]
    return host


def _opt(argv, name, default):
    if name in argv:
        i = argv.index(name)
        val = argv[i + 1]
        del argv[i:i + 2]
        return val
    return default


def scan_region(d, pid, start, end):
    """Yield every HBC-magic address in [start, end)."""
    addr = start
    while addr < end:
        hit = d.scan_aob_multi(pid, addr, end - addr, [HBC_MAGIC])[0]
        if not hit:
            return
        yield hit
        addr = hit + len(HBC_MAGIC)


def find_hub(d, pid):
    """Return (addr, fileLength, bridges) for the stock Welcome Hub bundle.

    addr is None when no stock hub is resident. bridges counts hub copies that
    carry our bridge patches: a resident wh payload swaps one in, and dumping it
    would hand the matcher our own 13.20-derived output instead of this
    firmware's hub."""
    bridges = 0
    for m in d.maps(pid):
        if not (m["prot"] & 1):                 # must be readable
            continue
        size = m["end"] - m["start"]
        if size < MIN_LEN or size > MAX_REGION:
            continue
        for hit in scan_region(d, pid, m["start"], m["end"]):
            hdr = d.read(pid, hit, FLEN_OFF + 4)
            if struct.unpack("<I", hdr[8:12])[0] != HBC_VER:
                continue
            flen = struct.unpack("<I", hdr[FLEN_OFF:FLEN_OFF + 4])[0]
            if not (MIN_LEN <= flen <= MAX_LEN) or hit + flen > m["end"]:
                continue
            # Cheap server-side confirm: is the hub needle inside this bundle?
            if not d.scan_aob_multi(pid, hit, flen, [HUB_NEEDLE])[0]:
                continue
            if d.scan_aob_multi(pid, hit, flen, [BRIDGE_NEEDLE])[0]:
                bridges += 1
                continue
            return hit, flen, bridges
    return None, None, bridges


def read_all(d, pid, addr, length, chunk=0x40000):
    out = bytearray()
    while len(out) < length:
        n = min(chunk, length - len(out))
        out += d.read(pid, addr + len(out), n)
    return bytes(out)


def main(argv):
    host = _host(argv)
    out_dir = _opt(argv, "--out", ".")
    d = PS5Dbg(host)
    try:
        fw = d.fw()                             # e.g. 1320 == FW 13.20
        pid = d.find_pid("SceShellUI")
        print(f"console fw={fw // 100}.{fw % 100:02d}  SceShellUI pid={pid}")
        addr, flen, bridges = find_hub(d, pid)
        if addr is None:
            if bridges:
                print("only a wh-patched hub is resident. Reboot the console, do not "
                      "load the wh payload, open the Welcome Hub, then run this again.",
                      file=sys.stderr)
            else:
                print("hub bundle not found. Open the Welcome Hub on the console, then "
                      "run this again.", file=sys.stderr)
            return 1
        if bridges:
            print(f"skipped {bridges} wh-patched hub copy(ies)")
        print(f"hub bundle @ {addr:#x}  fileLength={flen} ({flen / 1048576:.2f} MB); reading...")
        data = read_all(d, pid, addr, flen)
        if len(data) != flen or data[:8] != HBC_MAGIC:
            print(f"read-back mismatch (got {len(data)} bytes); aborting.", file=sys.stderr)
            return 1
        sha = hashlib.sha1(data).hexdigest()
        name = f"hub_fw{fw:04d}_{sha[:12]}.hbc"
        path = os.path.join(out_dir, name)
        with open(path, "wb") as f:
            f.write(data)
        print(f"wrote {path}  ({len(data)} bytes, sha1 {sha})")
        print("Send this file to the maintainer to add delta support for this firmware.")
        return 0
    except DbgError as e:
        print(f"ps5debug error: {e}", file=sys.stderr)
        return 1
    finally:
        d.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
