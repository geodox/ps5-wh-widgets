/* Runtime discovery of the hook point: evaluateJavaScript and its JSI vtable
 * slot in libhermes, found by content so no firmware-specific offsets are needed.
 *
 * Validated on FW 13.20 (matches 0xe890 / 0x26c358). Steps: walk the module's
 * page protections to bound .text and the read-only image; signature-scan .text
 * for evaluateJavaScript / prepareJavaScript / evaluatePreparedJavaScript (each
 * must be unique); locate the vtable by the (prepare, evalPrepared) pointer pair
 * in rodata -> slot 2 = pair - 8 (works even while slot 2 is already hooked,
 * since those two neighbours are never touched). */
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <ps5/kernel.h>
#include "hookpoint.h"
#include "cave.h"
#include "remote.h"
#include "util.h"
#include "wh_sigs.h"

/* FW 13.20 reference offsets: used only to label a match in the log; the real
 * addresses are discovered at runtime by signature (see wh_discover). */
#define OFF_EVALUATE_JS  0x0000e890u
#define OFF_VTABLE_SLOT2 0x0026c358u
#define WH_MOD_CAP       0x00800000u   /* hard cap when walking the module image */

const uint8_t EXPECTED_PROLOGUE[11] =
    {0x55,0x48,0x89,0xe5,0x41,0x56,0x53,0x48,0x83,0xec,0x20};

static intptr_t wh_find_unique(const uint8_t* buf, size_t n, const uint8_t* pat, const uint8_t* msk, size_t plen){
  intptr_t found = -1;
  if (plen == 0 || n < plen) return -1;
  for (size_t i = 0; i + plen <= n; i++){
    size_t k = 0;
    for (; k < plen; k++) if (msk[k] && buf[i+k] != pat[k]) break;
    if (k == plen){ if (found >= 0) return -2; found = (intptr_t)i; }
  }
  return found;   /* -1 none, -2 ambiguous, else offset */
}

/* unique 16-byte little-endian pair (a,b) within [buf,buf+n): offset, or -1/-2 */
static intptr_t wh_find_pair(const uint8_t* buf, size_t n, uint64_t a, uint64_t b){
  uint8_t pair[16]; memcpy(pair, &a, 8); memcpy(pair+8, &b, 8);
  intptr_t found = -1;
  if (n < 16) return -1;
  for (size_t i = 0; i + 16 <= n; i++){
    if (!memcmp(buf + i, pair, 16)){ if (found >= 0) return -2; found = (intptr_t)i; }
  }
  return found;
}

int wh_discover(pid_t pid, uintptr_t base, uintptr_t* eval_out, uintptr_t* slot_out){
  /* bound the module: walk pages while mapped (protection query >= 0). PS5 maps
   * code execute-only (XOM: EXEC set, READ clear) and the kernel still copies it,
   * so bound on the unmapped gap, not the READ bit. text_end = first non-exec page. */
  uintptr_t p = base, text_end = 0;
  while (p - base < WH_MOD_CAP){
    int pr = kernel_get_vmem_protection(pid, p, 1);
    if (pr < 0) break;                             /* unmapped: end of the module image */
    if (!text_end && !(pr & PROT_EXEC)) text_end = p;
    p += 0x1000;
  }
  uintptr_t img_end = p;
  if (!text_end) text_end = img_end;
  size_t imglen = img_end - base, textlen = text_end - base;
  if (imglen < 0x10000 || textlen < 0x1000){ LOG("discover: module too small (img %#zx text %#zx)\n", imglen, textlen); return WH_RC_SCAN_SMALL; }
  uint8_t* mod = (uint8_t*)malloc(imglen);
  if (!mod){ LOG("discover: oom %#zx\n", imglen); return WH_RC_SCAN_NOMEM; }
  for (size_t o = 0; o < imglen; ){ size_t n = imglen - o; if (n > 0x40000) n = 0x40000;
    if (remote_read(pid, base + o, mod + o, n)){ LOG("discover: read fail at +%#zx\n", o); free(mod); return WH_RC_SCAN_READ; } o += n; }
  LOG("discover: module +0..%#zx text +0..%#zx\n", imglen, textlen);
  /* signature-scan .text */
  intptr_t ev = wh_find_unique(mod, textlen, WH_SIG_EVAL_P, WH_SIG_EVAL_M, sizeof WH_SIG_EVAL_P);
  intptr_t pr_ = wh_find_unique(mod, textlen, WH_SIG_PREPARE_P, WH_SIG_PREPARE_M, sizeof WH_SIG_PREPARE_P);
  intptr_t ep = wh_find_unique(mod, textlen, WH_SIG_EVALPREP_P, WH_SIG_EVALPREP_M, sizeof WH_SIG_EVALPREP_P);
  if (ev < 0 || pr_ < 0 || ep < 0){
    LOG("discover: signature match eval=%ld prepare=%ld evalPrepared=%ld (<0: -1 none, -2 ambiguous)\n",(long)ev,(long)pr_,(long)ep);
    free(mod); return WH_RC_SCAN_SIG;
  }
  uintptr_t evalA = base + ev, prepA = base + pr_, eprepA = base + ep;
  /* vtable slot via the (prepare, evalPrepared) pair in the data region */
  intptr_t pr_off = wh_find_pair(mod + textlen, imglen - textlen, (uint64_t)prepA, (uint64_t)eprepA);
  if (pr_off < 0){ LOG("discover: vtable pair %s\n", pr_off==-2?"ambiguous":"not found"); free(mod); return WH_RC_SCAN_VTABLE; }
  uintptr_t slot3 = text_end + (uintptr_t)pr_off, slot2 = slot3 - 8;
  free(mod);
  LOG("discover: eval +%#lx prepare +%#lx evalPrepared +%#lx slot2 +%#lx%s\n",
      (long)(evalA-base),(long)(prepA-base),(long)(eprepA-base),(long)(slot2-base),
      (evalA-base==OFF_EVALUATE_JS && slot2-base==OFF_VTABLE_SLOT2) ? " (matches FW 13.20)" : " (non-13.20 layout)");
  *eval_out = evalA; *slot_out = slot2;
  return WH_OK;
}
