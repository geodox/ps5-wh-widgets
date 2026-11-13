"""Minimal ps5debug-NG client (protocol "1.3", see PROTOCOL.md upstream).

Usage:  python ps5dbg.py [--host <ip>] <command> [args]

The console address comes from --host or WH_HOST; there is no built-in default.

  python ps5dbg.py info
  python ps5dbg.py procs
  python ps5dbg.py maps SceShellUI
  python ps5dbg.py read SceShellUI 0x12340000 0x100
  python ps5dbg.py dump SceShellUI 0x12340000 0x10000 out.bin
  python ps5dbg.py notify "hello"
"""
import os
import socket
import struct
import sys

HOST = os.environ.get("WH_HOST")   # --host or $WH_HOST; no default
PORT = 744
MAGIC = 0xFFAABBCC

# On-the-wire (bit-swapped) status values
ST_SUCCESS = 0x80000000
ST_NAMES = {
    0x80000000: "SUCCESS",
    0xF0000001: "ERROR",
    0xF0000003: "DATA_NULL",
    0xF0000004: "ALREADY_DEBUG",
    0xF0000005: "INVALID_INDEX",
}

CMD_VERSION = 0xBD000001
CMD_FW_VERSION = 0xBD000500
CMD_BRANDING = 0xBD000501
CMD_PROC_LIST = 0xBDAA0001
CMD_PROC_READ = 0xBDAA0002
CMD_PROC_WRITE = 0xBDAA0003
CMD_PROC_MAPS = 0xBDAA0004
CMD_PROC_CALL = 0xBDAA0006
CMD_PROC_ELF = 0xBDAA0007
CMD_PROC_INFO = 0xBDAA000A
CMD_PROC_ALLOC = 0xBDAA000B
CMD_PROC_FREE = 0xBDAA000C
CMD_PROC_ELF_RPC = 0xBDAA0010
CMD_CONSOLE_NOTIFY = 0xBDDD0004


class DbgError(Exception):
    pass


class PS5Dbg:
    def __init__(self, host=None, port=PORT, timeout=15):
        host = host or HOST
        if not host:
            raise SystemExit("ps5dbg: set WH_HOST or pass --host <ip>")
        self.s = socket.create_connection((host, port), timeout=timeout)
        self.s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def close(self):
        self.s.close()

    # --- framing -----------------------------------------------------------
    def _recv(self, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = self.s.recv(n - len(buf))
            if not chunk:
                raise DbgError("connection closed")
            buf += chunk
        return bytes(buf)

    def _send(self, cmd, body=b""):
        self.s.sendall(struct.pack("<III", MAGIC, cmd, len(body)) + body)

    def _status(self, what=""):
        st = struct.unpack("<I", self._recv(4))[0]
        if st != ST_SUCCESS:
            raise DbgError(f"{what}: status {ST_NAMES.get(st, hex(st))}")

    def _u32(self):
        return struct.unpack("<I", self._recv(4))[0]

    def _u64(self):
        return struct.unpack("<Q", self._recv(8))[0]

    # --- info --------------------------------------------------------------
    def version(self):
        self._send(CMD_VERSION)
        return self._recv(self._u32()).decode(errors="replace")

    def branding(self):
        self._send(CMD_BRANDING)
        return self._recv(self._u32()).split(b"\0")[0].decode(errors="replace")

    def fw(self):
        self._send(CMD_FW_VERSION)
        return struct.unpack("<H", self._recv(2))[0]

    # --- processes ---------------------------------------------------------
    def procs(self):
        self._send(CMD_PROC_LIST)
        self._status("proc_list")
        n = self._u32()
        out = []
        for _ in range(n):
            name, pid = struct.unpack("<32si", self._recv(36))
            out.append((pid, name.split(b"\0")[0].decode(errors="replace")))
        return out

    def find_pid(self, name_or_pid):
        try:
            return int(name_or_pid, 0)
        except ValueError:
            pass
        hits = [p for p, n in self.procs() if n == name_or_pid]
        if not hits:
            raise DbgError(f"process {name_or_pid!r} not found")
        return hits[0]

    def proc_info(self, pid):
        self._send(CMD_PROC_INFO, struct.pack("<I", pid))
        self._status("proc_info")
        pid_, name, path, tid, cid = struct.unpack("<I40s64s16s64s", self._recv(188))
        z = lambda b: b.split(b"\0")[0].decode(errors="replace")
        return dict(pid=pid_, name=z(name), path=z(path), titleid=z(tid), contentid=z(cid))

    def maps(self, pid):
        self._send(CMD_PROC_MAPS, struct.pack("<I", pid))
        self._status("proc_maps")
        n = self._u32()
        out = []
        for _ in range(n):
            name, start, end, off, prot = struct.unpack("<32sQQQH", self._recv(58))
            out.append(dict(name=name.split(b"\0")[0].decode(errors="replace"),
                            start=start, end=end, offset=off, prot=prot))
        return out

    def read(self, pid, addr, length):
        self._send(CMD_PROC_READ, struct.pack("<IQI", pid, addr, length))
        self._status("proc_read")
        return self._recv(length)

    def write(self, pid, addr, data):
        self._send(CMD_PROC_WRITE, struct.pack("<IQI", pid, addr, len(data)))
        self._status("proc_write ack")
        self.s.sendall(data)
        self._status("proc_write")

    def alloc(self, pid, length):
        self._send(CMD_PROC_ALLOC, struct.pack("<II", pid, length))
        self._status("proc_alloc")
        return self._u64()

    def free(self, pid, addr, length):
        self._send(CMD_PROC_FREE, struct.pack("<IQI", pid, addr, length))
        self._status("proc_free")

    def alloc_hinted(self, pid, hint, length):
        """Direct allocation (bypasses the server-side alloc arena)."""
        self._send(0xBDAA000E, struct.pack("<IQI", pid, hint, length))
        self._status("proc_alloc_hinted")
        return self._u64()

    def arena(self, enable):
        """Toggle the server-side per-pid alloc arena (0xBDAACC24)."""
        self._send(0xBDAACC24, struct.pack("<I", 1 if enable else 0))
        self._status("proc_arena")
        n = self._u32()
        return self._recv(n).decode(errors="replace")

    def protect(self, pid, addr, length, prot):
        self._send(0xBDAA0008, struct.pack("<IQII", pid, addr, length, prot))
        self._status("proc_protect")

    def module_base(self, pid, name_sub, want_exec=True):
        """First segment start of a loaded module whose map name contains name_sub."""
        best = None
        for m in self.maps(pid):
            if name_sub in m["name"] and (not want_exec or (m["prot"] & 4)):
                if best is None or m["start"] < best:
                    best = m["start"]
        if best is None:
            raise DbgError(f"module {name_sub!r} not found in {pid}")
        return best

    def call(self, pid, rip, *args):
        regs = list(args) + [0] * (6 - len(args))
        self._send(CMD_PROC_CALL, struct.pack("<IQQQQQQQQ", pid, 0, rip, *regs[:6]))
        self._status("proc_call")
        _pid, rax = struct.unpack("<IQ", self._recv(12))
        return rax

    def elf_rpc(self, pid, elf):
        """Load ELF into pid, return entry address (does not jump)."""
        self._send(CMD_PROC_ELF_RPC, struct.pack("<II", pid, len(elf)))
        self._status("elf_rpc ack")
        self.s.sendall(elf)
        self._status("elf_rpc")
        return self._u64()

    def elf(self, pid, elf):
        """Load ELF into pid and run its entry on a new thread."""
        self._send(CMD_PROC_ELF, struct.pack("<II", pid, len(elf)))
        self._status("elf ack")
        self.s.sendall(elf)
        self._status("elf")

    def scan_aob_multi(self, pid, addr, length, patterns, nth=1):
        """Server-side scan of [addr, addr+length) for each byte pattern.
        Returns one address per pattern (0 = no match)."""
        blob = b""
        for p in patterns:
            blob += struct.pack("<BI", nth, len(p)) + p + b"\x01" * len(p)
        self._send(0xBDAA0502, struct.pack("<IQIBI", pid, addr, length, 0, len(blob)))
        self._status("aob_multi ack")
        self.s.sendall(blob)
        self._status("aob_multi")
        res = [self._u64() for _ in patterns]
        self._status("aob_multi done")
        return res

    def notify(self, msg, mtype=222):
        b = msg.encode() + b"\0"
        self._send(CMD_CONSOLE_NOTIFY, struct.pack("<II", mtype, len(b)))
        self.s.sendall(b)
        self._status("notify")


PROT = {1: "r", 2: "w", 4: "x"}


def prot_str(p):
    return "".join(c if p & b else "-" for b, c in PROT.items())


def main(argv):
    global HOST
    if "--host" in argv:
        i = argv.index("--host")
        HOST = argv[i + 1]
        del argv[i:i + 2]
    if not argv:
        print(__doc__)
        return
    d = PS5Dbg(host=HOST)
    cmd, args = argv[0], argv[1:]
    if cmd == "info":
        print("protocol:", d.version())
        print("branding:", d.branding())
        print("fw:", d.fw())
    elif cmd == "procs":
        for pid, name in sorted(d.procs()):
            print(f"{pid:6d}  {name}")
    elif cmd == "pinfo":
        pid = d.find_pid(args[0])
        print(d.proc_info(pid))
    elif cmd == "maps":
        pid = d.find_pid(args[0])
        for m in d.maps(pid):
            print(f"{m['start']:016x}-{m['end']:016x} {prot_str(m['prot'])} "
                  f"{(m['end'] - m['start']) // 1024:9d}K  off={m['offset']:x}  {m['name']}")
    elif cmd == "read":
        pid = d.find_pid(args[0])
        addr, n = int(args[1], 0), int(args[2], 0)
        data = d.read(pid, addr, n)
        for i in range(0, len(data), 16):
            row = data[i:i + 16]
            print(f"{addr + i:016x}  {row.hex(' '):<47}  "
                  + "".join(chr(c) if 32 <= c < 127 else "." for c in row))
    elif cmd == "dump":
        pid = d.find_pid(args[0])
        addr, n, out = int(args[1], 0), int(args[2], 0), args[3]
        with open(out, "wb") as f:
            off = 0
            while off < n:
                k = min(0x100000, n - off)
                f.write(d.read(pid, addr + off, k))
                off += k
        print(f"wrote {n:#x} bytes to {out}")
    elif cmd == "notify":
        d.notify(" ".join(args))
    else:
        print("unknown command", cmd)
    d.close()


if __name__ == "__main__":
    main(sys.argv[1:])
