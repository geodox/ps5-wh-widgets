"""Generate framework/wh_detour.h: the slot-2 evaluateJavaScript detour.

The detour runs our probe PRELUDE (via the original eval, guarded), then asks a
helper whether the buffer being evaluated is the hub, swapping it for our bridge
HBC if so. Hub detection is by CONTENT (a signature string in the bytecode), not
by exact byte size, so it is firmware-independent.

Layout of markers patched by the installer (main.c):
  DET:   0xAAAA=&prelude_shared 0xBBBB=&prelude_url 0xCCCC=orig fn
         0xEEEE=&bridge_shared  0x9999=&choose_buffer helper  0xF000=&counters
  MATCH: 0x4E4E=&needle (signature string, in the cave)
         0xDE1D=&delta blob (tools/make_delta.js layout); the bridge is rebuilt from
                the hub's own bytecode + the delta the first time the hub is seen
  SIZE/DATA buffer descriptors: 0xDDDD=size imm  0xEEEE=data ptr
Counters [+0]=entered [+8]=prelude_ret [+16]=swapped [+24]=bundle_ret
"""
import sys
from keystone import Ks, KS_ARCH_X86, KS_MODE_64
ks = Ks(KS_ARCH_X86, KS_MODE_64)

# --- the detour (slot-2 replacement) ---------------------------------------
# 6 pushes -> rsp%16==8; sub 0x18 -> %16==0 before the inner calls.
DET = "\n".join([
  "push rbp","mov rbp, rsp","push r12","push r13","push r14","push r15","push rbx","sub rsp, 0x18",
  "mov rax, 0xF000000000000000","lock inc qword ptr [rax]",          # entered
  "mov r12, rdi","mov r13, rsi","mov r14, rdx","mov r15, rcx",
  "mov rbx, 0xEEEEEEEEEEEEEEEE",                                     # &bridge_shared
  # prelude eval via original (guarded by __wh_c inside the JS)
  "mov rdi, rsp","mov rsi, r13","mov rdx, 0xAAAAAAAAAAAAAAAA","mov rcx, 0xBBBBBBBBBBBBBBBB",
  "mov rax, 0xCCCCCCCCCCCCCCCC","call rax",
  "mov rax, 0xF000000000000000","lock inc qword ptr [rax + 8]",      # prelude_ret
  # choose the buffer: helper returns the rdx to pass (bridge if hub, else source)
  "mov rdi, r14","mov rsi, rbx",
  "mov rax, 0x9999999999999999","call rax",                          # choose_buffer(source_holder, bridge)
  "mov rdx, rax",
  "cmp rax, rbx","jne skipswp",
  "mov rax, 0xF000000000000000","lock inc qword ptr [rax + 16]",     # swapped
  "skipswp:",
  "mov rdi, r12","mov rsi, r13","mov rcx, r15",
  "mov rax, 0xCCCCCCCCCCCCCCCC","call rax",
  "mov r11, rax","mov rax, 0xF000000000000000","lock inc qword ptr [rax + 24]",  # bundle_ret
  "mov rax, r11","add rsp, 0x18","pop rbx","pop r15","pop r14","pop r13","pop r12","pop rbp","ret",
])

# --- choose_buffer(rdi=&shared_ptr source, rsi=&bridge_shared) -> rax -------
# Returns rsi (bridge) if the buffer is the hub, else rdi (unchanged source).
# A jsi::Buffer has vtable[16]=size(), vtable[24]=data(). We take size() as a
# cheap lower-bound pre-filter, then scan data()[0..size-NLEN] for the needle.
MIN_SIZE   = 0x200000      # 2 MB: skip small evals without scanning
NEEDLE_LEN = 22            # strlen("widget:customTemplates")
MATCH = "\n".join([
  "push rbp","mov rbp, rsp","sub rsp, 0x20",
  "mov [rbp - 8], rdi","mov [rbp - 16], rsi",                        # holder, bridge
  "mov rax, [rdi]","test rax, rax","jz retsrc",                      # Buffer*
  "mov r10, [rax]","mov r11, [r10 + 16]","mov rdi, rax","call r11",  # rax = size()
  "mov rcx, %d" % MIN_SIZE,"cmp rax, rcx","jb retsrc",
  "mov [rbp - 24], rax",                                             # size
  "mov rax, [rbp - 8]","mov rax, [rax]","mov r10, [rax]",
  "mov r11, [r10 + 24]","mov rdi, rax","call r11",                   # rax = data()
  "mov r8, rax","mov r9, [rbp - 24]","sub r9, %d" % NEEDLE_LEN,      # r8=data, r9=last start index
  "mov rsi, 0x4E4E4E4E4E4E4E4E",                                     # &needle
  "xor rdx, rdx",                                                    # i = 0
  "scan:",
  "lea rdi, [r8 + rdx]","mov r10b, [rsi]","cmp byte ptr [rdi], r10b","jne nxt",
  "mov r11, rsi","push rcx","push rdx","mov rcx, %d" % NEEDLE_LEN,"cld","repe cmpsb",
  "pop rdx","pop rcx","mov rsi, r11","je found",
  "nxt:","inc rdx","cmp rdx, r9","jbe scan",
  "retsrc:","mov rax, [rbp - 8]","jmp done",
  # hub found: only swap if this is exactly the hub the delta was built from
  "found:",
  "mov r10, 0xDE1DDE1DDE1DDE1D",                                    # &delta blob
  "test r10, r10","jz retsrc",
  "mov rax, [rbp - 24]","cmp rax, [r10]","jne mismatch",           # size
  "lea rsi, [r8 + 12]","lea rdi, [r10 + 32]","mov rcx, 20","cld","repe cmpsb","jne mismatch",  # source hash
  "cmp qword ptr [r10 + 24], 0","jne retbr",                        # already rebuilt
  "mov rdx, [r10 + 8]","mov r9, [r10 + 16]","lea r11, [r10 + 96]",  # dst, op count, ops
  "oploop:","test r9, r9","jz built",
  "mov rsi, [r11]","mov rcx, [r11 + 8]","btr rcx, 63","jc lit",
  "add rsi, r8","jmp cpy",                                          # copy from the hub buffer
  "lit:","add rsi, r10",                                            # literal bytes in the blob
  "cpy:","mov rdi, rdx","cld","rep movsb","mov rdx, rdi",
  "add r11, 16","dec r9","jmp oploop",
  "built:","mov qword ptr [r10 + 24], 1",
  "retbr:","mov rax, [rbp - 16]","jmp done",
  "mismatch:","lock inc qword ptr [r10 + 64]","jmp retsrc",
  "done:","add rsp, 0x20","pop rbp","ret",
])

SIZE_FN = "mov rax, 0xDDDDDDDDDDDDDDDD\nret"
DATA_FN = "mov rax, 0xEEEEEEEEEEEEEEEE\nret"
DTOR_FN = "mov rax, rdi\nret"

def asm(s): return bytes(ks.asm(s)[0])
def finds(b, p):
  o=[]; i=b.find(p)
  while i>=0: o.append(i); i=b.find(p,i+1)
  return o
def one(b, v):
  r=finds(b, v.to_bytes(8,"little")); assert len(r)==1, (hex(v),len(r)); return r[0]
def carr(n,b): return f"static const uint8_t {n}[{len(b)}] = {{{','.join(f'0x{x:02x}' for x in b)}}};"

det=asm(DET); mat=asm(MATCH); sz=asm(SIZE_FN); da=asm(DATA_FN); dt=asm(DTOR_FN)
assert len(det) <= 0x100, f"detour {len(det)} > 0x100"
assert len(mat) <= 0x1e0, f"match {len(mat)} > 0x1e0"
DET_ORIG = finds(det,(0xCCCCCCCCCCCCCCCC).to_bytes(8,"little"))
DET_CTR  = finds(det,(0xF000000000000000).to_bytes(8,"little"))
assert len(DET_ORIG)==2 and len(DET_CTR)==4, (len(DET_ORIG),len(DET_CTR))
out = sys.argv[1] if len(sys.argv)>1 else "framework/wh_detour.h"
with open(out,"w",newline="\n") as f:
  f.write("/* generated by tools/gen_detour.py -- content-signature hub detection */\n")
  f.write("#ifndef WH_DETOUR_C_H\n#define WH_DETOUR_C_H\n#include <stdint.h>\n\n")
  f.write(carr("WH_C_DET",det)+"\n"); f.write(carr("WH_C_MATCH",mat)+"\n")
  f.write(carr("WH_C_SIZE",sz)+"\n"); f.write(carr("WH_C_DATA",da)+"\n"); f.write(carr("WH_C_DTOR",dt)+"\n\n")
  f.write(f"#define WH_C_SHARED {one(det,0xAAAAAAAAAAAAAAAA)}\n")
  f.write(f"#define WH_C_URL {one(det,0xBBBBBBBBBBBBBBBB)}\n")
  f.write(f"#define WH_C_ORIG_A {DET_ORIG[0]}\n#define WH_C_ORIG_B {DET_ORIG[1]}\n")
  f.write(f"#define WH_C_BRIDGE {one(det,0xEEEEEEEEEEEEEEEE)}\n")
  f.write(f"#define WH_C_MATCHFN {one(det,0x9999999999999999)}\n")
  f.write(f"#define WH_C_CTR_A {DET_CTR[0]}\n#define WH_C_CTR_B {DET_CTR[1]}\n#define WH_C_CTR_C {DET_CTR[2]}\n#define WH_C_CTR_D {DET_CTR[3]}\n")
  f.write(f"#define WH_M_NEEDLE {one(mat,0x4E4E4E4E4E4E4E4E)}\n")
  f.write(f"#define WH_M_DELTA {one(mat,0xDE1DDE1DDE1DDE1D)}\n")
  f.write(f"#define WH_C_SZIMM {one(sz,0xDDDDDDDDDDDDDDDD)}\n")
  f.write(f"#define WH_C_DAIMM {one(da,0xEEEEEEEEEEEEEEEE)}\n")
  f.write('#define WH_NEEDLE "widget:customTemplates"\n')
  f.write(f"#define WH_NEEDLE_LEN {NEEDLE_LEN}\n")
  f.write("\n#endif\n")
print(f"wrote {out}: detour={len(det)}B match={len(mat)}B")
