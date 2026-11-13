#!/usr/bin/env bash
# One-shot WSL setup for building PS5 payload ELFs (no sudo needed).
# Consolidates the original sdk_setup / sdk_reextract / sdk_fixperms /
# toolchain_shim / llvmcfg_shim steps.
#
#   bash scripts/setup_toolchain.sh            # idempotent; re-run to repair
#
# Requires a system LLVM (clang + ld.lld), e.g. apt's llvm-NN. Produces:
#   ~/ps5-payload-sdk      binary SDK (symlinks + exec bits preserved)
#   ~/llvmbin              tool dir the SDK dispatcher resolves clang/ld.lld from
#   ~/bin/llvm-config      shim that reports ~/llvmbin
# framework/build.sh picks these up via PS5_PAYLOAD_SDK / LLVM_CONFIG defaults.
set -eu
SDK="$HOME/ps5-payload-sdk"
ZIP="$HOME/ps5-payload-sdk.zip"
BINDIR="$HOME/llvmbin"

# --- locate system LLVM (newest /usr/lib/llvm-NN) -------------------------
LLVM_PREFIX="${LLVM_PREFIX:-$(ls -d /usr/lib/llvm-* 2>/dev/null | sort -V | tail -1)}"
[ -x "$LLVM_PREFIX/bin/clang" ] || { echo "No system LLVM found (set LLVM_PREFIX=/usr/lib/llvm-NN)"; exit 1; }
echo "LLVM: $LLVM_PREFIX ($("$LLVM_PREFIX/bin/clang" --version | head -1))"

# --- download + extract SDK preserving symlinks and modes -------------------
if [ ! -x "$SDK/bin/prospero-clang" ]; then
  [ -f "$ZIP" ] || wget -q https://github.com/ps5-payload-dev/sdk/releases/latest/download/ps5-payload-sdk.zip -O "$ZIP"
  rm -rf "$SDK"; mkdir -p "$SDK"
  python3 - "$ZIP" "$SDK" <<'PY'
import os, sys, stat, zipfile
zpath, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zpath) as z:
    names = z.namelist()
    tops = {n.split('/', 1)[0] for n in names}
    strip = (tops.pop() + '/') if len(tops) == 1 else ''
    for info in z.infolist():
        rel = info.filename[len(strip):] if strip and info.filename.startswith(strip) else info.filename
        if not rel: continue
        out = os.path.join(dest, rel)
        mode = (info.external_attr >> 16) & 0xFFFF
        os.makedirs(os.path.dirname(out) or dest, exist_ok=True)
        if stat.S_ISLNK(mode):
            if os.path.lexists(out): os.remove(out)
            os.symlink(z.read(info).decode(), out)
        elif info.is_dir():
            os.makedirs(out, exist_ok=True)
        else:
            with z.open(info) as s, open(out, 'wb') as d: d.write(s.read())
            if mode: os.chmod(out, mode & 0o7777)
print("extracted SDK")
PY
fi
chmod -R u+rwX "$SDK"
find "$SDK/bin" -type f -exec chmod +x {} \; 2>/dev/null || true

# --- tool dir for the SDK dispatcher (prospero-llvm) ------------------------
mkdir -p "$BINDIR"
ln -sf "$LLVM_PREFIX/bin/clang"  "$BINDIR/clang"
ln -sf "$LLVM_PREFIX/bin/clang"  "$BINDIR/clang++"
ln -sf "$LLVM_PREFIX/bin/clang"  "$BINDIR/clang-cpp"
ln -sf "$LLVM_PREFIX/bin/ld.lld" "$BINDIR/ld.lld"
for t in ar objcopy nm strip ranlib as; do ln -sf "/usr/bin/$t" "$BINDIR/$t"; done

# --- llvm-config shim -------------------------------------------------------
mkdir -p "$HOME/bin"
cat > "$HOME/bin/llvm-config" <<SH
#!/usr/bin/env bash
P="$LLVM_PREFIX"; B="$BINDIR"
for a in "\$@"; do case "\$a" in
  --bindir) echo "\$B";;
  --libdir) echo "\$P/lib";;
  --includedir) echo "\$P/include";;
  --prefix) echo "\$P";;
  --cmakedir) echo "\$P/lib/cmake/llvm";;
  --version) "\$P/bin/clang" --version | sed -n 's/.*version \([0-9.]*\).*/\1/p' | head -1;;
  --host-target) echo x86_64-pc-linux-gnu;;
esac; done
SH
chmod +x "$HOME/bin/llvm-config"

# --- SDK bin dispatcher symlinks (release zip may ship copies) --------------
( cd "$SDK/bin"
  for t in clang clang++ clang-cpp ld.lld llvm-ar llvm-nm llvm-objcopy llvm-ranlib llvm-strip; do
    [ -f prospero-llvm ] && ln -sf prospero-llvm "$t"
  done )

echo "sanity: $(LLVM_CONFIG="$HOME/bin/llvm-config" "$SDK/bin/clang" --version | head -1)"
echo "OK. Build with: bash framework/build.sh"
