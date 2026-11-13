#!/usr/bin/env python3
"""whctl - Welcome Hub SDK control CLI.

Usage:  python whctl.py [--host <ip>] <command> [args]

The console address comes from --host or WH_HOST; there is no built-in default.
Ports: FTP :2121, elfldr :9021, ps5debug via ps5dbg.PS5Dbg.

Subcommands:
  check                         Show slot-2 (evaluateJavaScript) hook state.
  restore                       Restore vtable slots 2/3/4 to originals (unhook).
  install <elf> [--race]        send ELF to elfldr -> verify hooked. The payload
                                replaces its own previous hook in place (reusing
                                the bridge already in ShellUI), so no restore is
                                needed. The hub runtime persists across refocus:
                                sign out/in (or --race) to load the new build.
                                --race: SIGKILL ShellUI first and install the
                                moment the respawned process maps libhermes
                                (the proven solo reload loop).
  reload                        SIGKILL SceShellUI (out/wh_kill.elf) and wait for
                                the respawn. Jailbreak survives; reloads the hub.
  send <elf>                    Just stream an ELF to elfldr (no restore/verify).
  deploy [local_dir] [--only ID..] [--force]
                                Mirror a sample-widgets tree to /data/wh-widgets
                                (FTP). Checks each widget first (config.json valid
                                JSON with an id, widget.js syntax via `node --check`,
                                glyph file present) and skips broken ones: one
                                syntax error would stop EVERY widget loading.
  log [lines]                   Show the end of /data/wh-widgets/wh.log (installer,
                                hub loader, widgets and asset server).
  pull <out_dir>                Download every user's hub asi_sqlite.db.
  layout-get                    Print each user's widget:customTemplates.
  place <user> <json>           Write widget:customTemplates for a user (DELE+STOR).
  ls <remote_dir>               List a console directory over FTP.
  get <remote> <local>          Download a file, or a directory tree, over FTP.
  put <local> <remote>          Upload one file over FTP (replaces an existing file).
"""
import argparse, ftplib, os, socket, struct, sys, sqlite3, io, time

HOST = os.environ.get("WH_HOST")   # --host or $WH_HOST; no default
FTP_PORT, ELF_PORT = 2121, 9021
HUB_TITLE = "NPXS40063"
HOME_ROOT = "/system_data/priv/home"
DB_REL = f"nobackup/rnps/{HUB_TITLE}/asi_sqlite.db"
LAYOUT_KEY = "widget:customTemplates"

# libhermes-0.11 (SceShellUI, FW 13.20): (vtable-slot offset, original fn offset)
SLOTS = [(0x26C358, 0xE890, "slot2"), (0x26C360, 0xE6F0, "slot3"), (0x26C368, 0xCEB0, "slot4")]
EVAL_OFF, VSLOT_OFF = 0xE890, 0x26C358
EXPECT_PROLOGUE = "55 48 89 e5 41 56 53 48 83 ec 20"
SDK_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KILL_ELF = os.path.join(SDK_ROOT, "out", "wh_kill.elf")


def _host():
    if not HOST:
        raise SystemExit("whctl: set WH_HOST or pass --host <ip>")
    return HOST


def _dbg(timeout=30):
    from ps5dbg import PS5Dbg
    return PS5Dbg(host=HOST, timeout=timeout)


def _hermes(d):
    pid = d.find_pid("SceShellUI")
    base = d.module_base(pid, "libhermes-0.11")
    return pid, base


# ---- hook state ----
def cmd_check(_):
    d = _dbg()
    pid, base = _hermes(d)
    vslot, orig = base + VSLOT_OFF, base + EVAL_OFF
    cur = struct.unpack("<Q", d.read(pid, vslot, 8))[0]
    pro = d.read(pid, orig, 11).hex(" ")
    print(f"pid={pid} base={base:#x}")
    print(f"slot2 {vslot:#x} -> {cur:#x}  orig {orig:#x}  {'PRISTINE' if cur == orig else 'STILL HOOKED'}")
    print(f"prologue: {pro}  {'ok' if pro == EXPECT_PROLOGUE else 'UNEXPECTED'}")
    return 0 if cur == orig else 1


def cmd_restore(_):
    d = _dbg()
    pid, base = _hermes(d)
    print(f"pid={pid} base={base:#x}")
    for off_slot, off_fn, name in SLOTS:
        vs, orig = base + off_slot, base + off_fn
        before = struct.unpack("<Q", d.read(pid, vs, 8))[0]
        if before == orig:
            print(f"{name} {vs:#x}: already pristine")
            continue
        d.write(pid, vs, struct.pack("<Q", orig))
        after = struct.unpack("<Q", d.read(pid, vs, 8))[0]
        print(f"{name} {vs:#x}: {before:#x} -> {after:#x}  {'OK' if after == orig else 'FAILED'}")
    return 0


# ---- ELF loading ----
def send_elf(path):
    data = open(path, "rb").read()
    s = socket.create_connection((_host(), ELF_PORT), timeout=20)
    s.sendall(data)
    try: s.shutdown(socket.SHUT_WR)
    except OSError: pass
    s.settimeout(8)
    buf = b""
    try:
        while True:
            b = s.recv(4096)
            if not b: break
            buf += b
    except socket.timeout:
        pass
    s.close()
    return len(data), buf.decode("utf-8", "replace")


def cmd_send(a):
    n, reply = send_elf(a.elf)
    print(f"sent {n} bytes to {_host()}:{ELF_PORT}")
    print(reply)
    return 0


def _reload(timeout=30):
    """SIGKILL SceShellUI and wait until the respawned process has libhermes
    mapped. Returns the new pid (or None)."""
    old = _dbg(20).find_pid("SceShellUI")
    print(f"old ShellUI pid={old}")
    _, reply = send_elf(KILL_ELF)
    for ln in reply.splitlines():
        if "[whk]" in ln: print(" ", ln.strip())
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            d = _dbg(5)
            p = d.find_pid("SceShellUI")
            if p and p != old:
                try:
                    d.module_base(p, "libhermes-0.11")
                    print(f"respawned pid={p} at +{time.time() - t0:.1f}s")
                    d.close(); return p
                except Exception:
                    pass
            d.close()
        except Exception:
            pass
        time.sleep(0.2)
    print("FAIL: ShellUI did not respawn", file=sys.stderr)
    return None


def cmd_reload(_):
    return 0 if _reload() else 1


def cmd_install(a):
    if getattr(a, "race", False):
        # Fresh process: slots are pristine, so skip restore and race the hub load.
        if not _reload(): return 1
        n, reply = send_elf(a.elf)
        print(f"sent {n} bytes (race)")
        for ln in reply.splitlines():
            if any(k in ln for k in ("INSTALLED", "widget:", "build_prelude", "done rc", "failed", "assets:")):
                print(" ", ln)
        return 0 if cmd_check(a) == 1 else 1      # check() returns 1 == hooked == success here
    # No restore: the payload swaps out its own previous hook (and refuses to touch
    # a hook that isn't ours), reusing the identical bridge already in ShellUI.
    print("== send ELF ==")
    n, reply = send_elf(a.elf)
    print(f"sent {n} bytes")
    for ln in reply.splitlines():
        if any(k in ln for k in ("INSTALLED", "widget:", "build_prelude", "done rc", "failed", "assets:")):
            print(" ", ln)
    print("== verify hooked ==")
    hooked = cmd_check(a) == 1
    print("installed: sign out/in (or install --race) so a new hub runtime loads it" if hooked else "NOT hooked - see output above")
    return 0 if hooked else 1


# ---- FTP helpers ----
def _ftp():
    f = ftplib.FTP()
    f.connect(_host(), FTP_PORT, timeout=60)
    f.login()
    return f


def _mkd(f, path):
    try:
        f.mkd(path)
    except ftplib.error_perm as e:
        if not str(e).startswith("550"):
            print(f"MKD {path} -> {e}")


def _put(f, local, remote):
    try: f.delete(remote)          # existing read-only files 550 on bare STOR
    except Exception: pass
    with open(local, "rb") as fh:
        f.storbinary(f"STOR {remote}", fh)
    try: return f.size(remote)
    except Exception: return "?"


def _check_widget(wdir):
    """Return a list of problems that would stop this widget folder loading."""
    import json, shutil, subprocess
    probs = []
    cfgp, jsp = os.path.join(wdir, "config.json"), os.path.join(wdir, "widget.js")
    cfg = {}
    if not os.path.isfile(cfgp):
        probs.append("config.json missing")
    else:
        try:
            cfg = json.load(open(cfgp, encoding="utf-8"))
            if not isinstance(cfg, dict): probs.append("config.json is not a JSON object"); cfg = {}
            elif not cfg.get("id"): probs.append('config.json has no "id"')
        except ValueError as e:
            probs.append(f"config.json is not valid JSON ({e})")
    if not os.path.isfile(jsp):
        probs.append("widget.js missing")
    elif shutil.which("node"):
        r = subprocess.run(["node", "--check", jsp], capture_output=True, text=True)
        if r.returncode:
            lines = [l.strip() for l in (r.stderr or "").splitlines()
                     if l.strip() and not l.strip().startswith("at ") and not l.startswith("Node.js")]
            loc = next((l.rsplit(":", 1)[-1] for l in lines if l.endswith(tuple("0123456789")) and "widget.js" in l), "?")
            msg = next((l for l in lines if "Error" in l), lines[-1] if lines else "unknown")
            probs.append(f"widget.js syntax error (line {loc}): {msg}")
    else:
        print("  (node not found: widget.js syntax not checked)")
    g = cfg.get("glyph")
    if g and not os.path.isfile(os.path.join(wdir, g)):
        probs.append(f'glyph "{g}" not found in the folder')
    return probs


def _is_widget_dir(d):
    """A widget folder has a config.json or a widget.js; anything else (docs/, img/,
    out/, ...) is not a widget and is ignored without comment."""
    return os.path.isfile(os.path.join(d, "config.json")) or os.path.isfile(os.path.join(d, "widget.js"))


def cmd_deploy(a):
    local = a.dir or os.path.join(SDK_ROOT, "sample-widgets")
    base = "/data/wh-widgets"
    only = set(a.only or [])
    widgets = [n for n in sorted(os.listdir(local))
               if os.path.isdir(os.path.join(local, n)) and _is_widget_dir(os.path.join(local, n))
               and (not only or n in only)]
    if not widgets:
        print(f"no widget folders in {os.path.abspath(local)} (a widget folder holds config.json + widget.js)")
        return 1
    bad = set()
    for name in widgets:
        probs = _check_widget(os.path.join(local, name))
        if probs:
            print(f"!! {name}: " + "; ".join(probs))
            if not a.force:
                bad.add(name)
    if bad:
        print(f"skipping {', '.join(sorted(bad))} (fix it, or --force to upload anyway)")
    f = _ftp()
    _mkd(f, "/data"); _mkd(f, base)
    for root, dirs, files in os.walk(local):
        rel = os.path.relpath(root, local).replace("\\", "/")
        top = rel.split("/")[0]
        if rel == "." or top not in widgets or top in bad:
            continue                      # only widget folders; never loose root files
        rdir = f"{base}/{rel}"
        _mkd(f, rdir)
        for name in files:
            lp = os.path.join(root, name)
            rp = f"{rdir}/{name}"
            sz = _put(f, lp, rp)
            print(f"PUT {rp}  ({os.path.getsize(lp)} -> {sz})")
    f.quit()
    return 0


def _user_dbs(f):
    homes = []
    lines = []
    f.retrlines(f"LIST {HOME_ROOT}", lines.append)
    for ln in lines:
        p = ln.split(None, 8)
        if len(p) >= 9 and p[0].startswith("d") and p[8] not in (".", ".."):
            homes.append(p[8])
    return homes


def cmd_pull(a):
    os.makedirs(a.out, exist_ok=True)
    f = _ftp()
    for h in _user_dbs(f):
        remote = f"{HOME_ROOT}/{h}/{DB_REL}"
        local = os.path.join(a.out, f"hub_{h}.db")
        try:
            with open(local, "wb") as fh:
                f.retrbinary(f"RETR {remote}", fh.write)
            print(f"OK  {h}  {os.path.getsize(local)} bytes")
        except Exception as e:
            try: os.remove(local)
            except OSError: pass
            print(f"--  {h}  ({e})")
    f.quit()
    return 0


def _read_layout_bytes(f, user):
    remote = f"{HOME_ROOT}/{user}/{DB_REL}"
    bio = io.BytesIO()
    f.retrbinary(f"RETR {remote}", bio.write)
    return bio.getvalue()


def cmd_layout_get(a):
    f = _ftp()
    for h in _user_dbs(f):
        try:
            data = _read_layout_bytes(f, h)
        except Exception as e:
            print(f"{h}: (no db: {e})"); continue
        tmp = os.path.join(os.environ.get("TEMP", "."), f"_whlay_{h}.db")
        open(tmp, "wb").write(data)
        try:
            c = sqlite3.connect(tmp); cur = c.cursor()
            cur.execute("SELECT value FROM table_key_value WHERE key=?", (LAYOUT_KEY,))
            row = cur.fetchone(); c.close()
            print(f"{h}: {row[0] if row else '<none>'}")
        finally:
            try: os.remove(tmp)
            except OSError: pass
    f.quit()
    return 0


def _write_layout(user, value):
    f = _ftp()
    remote = f"{HOME_ROOT}/{user}/{DB_REL}"
    tmp = os.path.join(os.environ.get("TEMP", "."), f"_whset_{user}.db")
    f.retrbinary(f"RETR {remote}", open(tmp, "wb").write)
    c = sqlite3.connect(tmp); cur = c.cursor()
    cur.execute("SELECT value FROM table_key_value WHERE key=?", (LAYOUT_KEY,))
    old = cur.fetchone()
    print("BEFORE:", old[0] if old else "<none>")
    cur.execute("UPDATE table_key_value SET value=? WHERE key=?", (value, LAYOUT_KEY))
    c.commit(); c.close()
    print("AFTER :", value)
    try: f.delete(remote)
    except Exception: pass
    with open(tmp, "rb") as fh:
        f.storbinary(f"STOR {remote}", fh)
    sz = f.size(remote); f.quit()
    try: os.remove(tmp)
    except OSError: pass
    print(f"UPLOADED {remote} ({sz} bytes). Write only while signed OUT.")


def cmd_place(a):
    _write_layout(a.user, a.json)
    return 0


def cmd_put(a):
    f = _ftp()
    sz = _put(f, a.local, a.remote)
    f.quit()
    print(f"PUT {a.remote}  ({os.path.getsize(a.local)} -> {sz})")
    return 0 if str(sz) == str(os.path.getsize(a.local)) else 1


def cmd_log(a):
    f = _ftp()
    bio = io.BytesIO()
    try:
        f.retrbinary("RETR /data/wh-widgets/wh.log", bio.write)
    except ftplib.error_perm:
        print("no wh.log yet (it is created the first time the payload runs)")
        f.quit(); return 1
    f.quit()
    lines = bio.getvalue().decode("utf-8", "replace").splitlines()
    for ln in lines[-a.lines:]:
        print(ln)
    return 0


def _entries(f, path):
    lines, out = [], []
    f.retrlines(f"LIST {path}", lines.append)
    for ln in lines:
        p = ln.split(None, 8)
        if len(p) >= 9 and p[8] not in (".", ".."):
            out.append((p[0].startswith("d"), int(p[4]) if p[4].isdigit() else 0, p[8]))
    return out


def cmd_ls(a):
    f = _ftp()
    for is_dir, size, name in _entries(f, a.remote):
        print(f"{'d' if is_dir else '-'} {size:10d}  {name}")
    f.quit()
    return 0


def _get_tree(f, rpath, lpath, depth=0):
    os.makedirs(lpath, exist_ok=True)
    for is_dir, size, name in _entries(f, rpath):
        r, l = rpath.rstrip("/") + "/" + name, os.path.join(lpath, name)
        if is_dir:
            if depth < 8: _get_tree(f, r, l, depth + 1)
        else:
            with open(l, "wb") as fh: f.retrbinary(f"RETR {r}", fh.write)
            print(f"{size:10d}  {r}")


def cmd_get(a):
    f = _ftp()
    try:
        f.cwd(a.remote); is_dir = True        # ftpsrv reports a SIZE for dirs too
        f.cwd("/")
    except ftplib.error_perm:
        is_dir = False
    if is_dir:
        _get_tree(f, a.remote, a.local)
    else:
        with open(a.local, "wb") as fh: f.retrbinary(f"RETR {a.remote}", fh.write)
        print(f"{os.path.getsize(a.local):10d}  {a.remote}")
    f.quit()
    return 0


def main():
    global HOST
    argv = sys.argv[1:]
    if "--host" in argv:
        i = argv.index("--host")
        HOST = argv[i + 1]
        del argv[i:i + 2]
    ap = argparse.ArgumentParser(prog="whctl", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check").set_defaults(fn=cmd_check)
    sub.add_parser("restore").set_defaults(fn=cmd_restore)
    p = sub.add_parser("install"); p.add_argument("elf"); p.add_argument("--race", action="store_true"); p.set_defaults(fn=cmd_install)
    sub.add_parser("reload").set_defaults(fn=cmd_reload)
    p = sub.add_parser("send"); p.add_argument("elf"); p.set_defaults(fn=cmd_send)
    p = sub.add_parser("deploy"); p.add_argument("dir", nargs="?", default=None, help="folder of widget folders (default: <sdk>/sample-widgets)"); p.add_argument("--only", nargs="+", metavar="ID"); p.add_argument("--force", action="store_true"); p.set_defaults(fn=cmd_deploy)
    p = sub.add_parser("log"); p.add_argument("lines", nargs="?", type=int, default=40); p.set_defaults(fn=cmd_log)
    p = sub.add_parser("pull"); p.add_argument("out"); p.set_defaults(fn=cmd_pull)
    sub.add_parser("layout-get").set_defaults(fn=cmd_layout_get)
    p = sub.add_parser("place"); p.add_argument("user"); p.add_argument("json"); p.set_defaults(fn=cmd_place)
    p = sub.add_parser("ls"); p.add_argument("remote"); p.set_defaults(fn=cmd_ls)
    p = sub.add_parser("get"); p.add_argument("remote"); p.add_argument("local"); p.set_defaults(fn=cmd_get)
    p = sub.add_parser("put"); p.add_argument("local"); p.add_argument("remote"); p.set_defaults(fn=cmd_put)
    a = ap.parse_args(argv)
    sys.exit(a.fn(a))


if __name__ == "__main__":
    main()
