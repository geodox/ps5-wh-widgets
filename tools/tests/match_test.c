/* Native check of the generated choose_buffer helper (WH_C_MATCH) with delta rebuild.
 * Runs the real bytes from wh_detour.h against the real hub + bridge files.
 *   match_test <wh_detour.h dir is on -I> <original.hbc> <bridge.hbc> <bridge.delta> */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <sys/mman.h>
#include "wh_detour.h"

typedef struct Buf { void** vt; uint8_t* data; size_t size; } Buf;
static size_t b_size(Buf* b) { return b->size; }
static uint8_t* b_data(Buf* b) { return b->data; }
static void* VT[8];

static uint8_t* slurp(const char* p, size_t* n) {
  FILE* f = fopen(p, "rb"); if (!f) { perror(p); exit(2); }
  fseek(f, 0, SEEK_END); *n = ftell(f); fseek(f, 0, SEEK_SET);
  uint8_t* b = malloc(*n); if (fread(b, 1, *n, f) != *n) { perror("read"); exit(2); } fclose(f); return b;
}
static void put64(uint8_t* p, uint64_t v) { memcpy(p, &v, 8); }

int main(int argc, char** argv) {
  if (argc < 4) { fprintf(stderr, "usage: %s <orig.hbc> <bridge.hbc> <bridge.delta>\n", argv[0]); return 2; }
  size_t sn, bn, dn;
  uint8_t* src = slurp(argv[1], &sn); uint8_t* br = slurp(argv[2], &bn); uint8_t* delta = slurp(argv[3], &dn);
  VT[2] = (void*)b_size; VT[3] = (void*)b_data;       /* vtable[16]=size, [24]=data */

  uint8_t* code = mmap(0, 0x1000, PROT_READ|PROT_WRITE|PROT_EXEC, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
  memcpy(code, WH_C_MATCH, sizeof WH_C_MATCH);
  char needle[] = WH_NEEDLE;
  put64(code + WH_M_NEEDLE, (uint64_t)needle);
  uint8_t* blob = malloc(dn); memcpy(blob, delta, dn);
  uint64_t dsz; memcpy(&dsz, blob + 56, 8);
  uint8_t* dst = calloc(1, dsz);
  put64(blob + 8, (uint64_t)dst);
  put64(code + WH_M_DELTA, (uint64_t)blob);
  void* (*match)(void*, void*) = (void* (*)(void*, void*))code;

  Buf bsrc = { VT, src, sn }, bbr = { VT, dst, dsz }, bsmall = { VT, src, 1000 };
  Buf* hsrc = &bsrc; Buf* hbr = &bbr; Buf* hsmall = &bsmall;
  int fails = 0;

  /* 1: small buffer -> source unchanged */
  void* r = match(&hsmall, &hbr);
  printf("small buffer   -> %s\n", r == &hsmall ? "source (ok)" : "WRONG"); fails += r != &hsmall;

  /* 2: hub buffer -> bridge, rebuilt byte-exact */
  r = match(&hsrc, &hbr);
  int same = (dsz == bn) && !memcmp(dst, br, bn);
  uint64_t built; memcpy(&built, blob + 24, 8);
  printf("hub buffer     -> %s, rebuilt %s, built=%llu\n", r == &hbr ? "bridge (ok)" : "WRONG",
         same ? "byte-exact (ok)" : "MISMATCH", (unsigned long long)built);
  fails += (r != &hbr) + !same + (built != 1);

  /* 3: second time -> bridge, no rebuild (scribble dst first to prove it) */
  dst[100] ^= 0xff; r = match(&hsrc, &hbr);
  printf("hub again      -> %s, %s\n", r == &hbr ? "bridge (ok)" : "WRONG", dst[100] != br[100] ? "not rebuilt (ok)" : "REBUILT");
  fails += (r != &hbr) + (dst[100] == br[100]); dst[100] ^= 0xff;

  /* 4: other hub (source hash differs) -> source, mismatch counted */
  src[20] ^= 0x55; r = match(&hsrc, &hbr);
  uint64_t mm; memcpy(&mm, blob + 64, 8);
  printf("hash mismatch  -> %s, mismatch=%llu\n", r == &hsrc ? "source (ok)" : "WRONG", (unsigned long long)mm);
  fails += (r != &hsrc) + (mm != 1); src[20] ^= 0x55;

  /* 5: size differs -> source */
  bsrc.size = sn - 1; r = match(&hsrc, &hbr); bsrc.size = sn;
  memcpy(&mm, blob + 64, 8);
  printf("size mismatch  -> %s, mismatch=%llu\n", r == &hsrc ? "source (ok)" : "WRONG", (unsigned long long)mm);
  fails += (r != &hsrc) + (mm != 2);

  printf(fails ? "FAILED (%d)\n" : "ALL OK\n", fails);
  return fails != 0;
}
