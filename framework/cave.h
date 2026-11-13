/* Code-cave layout inside SceShellUI, and the install return codes.
 *
 * install.c maps one RWX "cave" in ShellUI and writes this image into it:
 *
 *   CV_DET      detour that replaces evaluateJavaScript (JSI vtable slot 2):
 *               evaluates the prelude, then the original source -- or the bridge
 *               when choose_buffer says the source is the hub (wh_detour.h)
 *   CV_P*       a fake jsi::Buffer (vtable, size/data/dtor stubs, shared_ptr)
 *               wrapping the prelude text at CV_PRELUDE
 *   CV_URL      source URL for the prelude eval ("wh")
 *   CV_B*       the same fake Buffer for the bridge HBC (rebuilt in its own
 *               mapping from the hub's bytecode + the delta, see make_delta.js)
 *   CV_CTR      counters the detour bumps (entered, prelude, swapped, bundle)
 *   CV_SIG      "WHBRIDGE" + bridge length + bridge hash + WH_SIG_VER: lets a
 *               later install recognise (and replace) our own hook
 *   CV_NEEDLE   hub signature string the match helper scans for
 *   CV_MATCH    choose_buffer helper (content-detects the hub)
 *   CV_PRELUDE  loader + widget sections (NUL-terminated), to the end */
#ifndef WH_CAVE_H
#define WH_CAVE_H

#define CV_DET     0x000
#define CV_PSIZE   0x100
#define CV_PDATA   0x120
#define CV_DTOR    0x140
#define CV_PVT     0x160
#define CV_PBUF    0x1a0
#define CV_PCTRL   0x1c0
#define CV_PSHARED 0x1e0
#define CV_URL     0x200
#define CV_BSIZE   0x220
#define CV_BDATA   0x240
#define CV_BVT     0x260
#define CV_BBUF    0x2a0
#define CV_BCTRL   0x2c0
#define CV_BSHARED 0x2e0
#define CV_CTR     0x300
#define CV_SIG     0x320   /* "WHBRIDGE", bridge len, bridge FNV-1a64, version */
#define CV_NEEDLE  0x340   /* hub signature string ("widget:customTemplates") */
#define CV_MATCH   0x360   /* choose_buffer helper (content-detects the hub) */
#define CV_PRELUDE 0x500   /* spliced loader + widget JS */
#define WH_SIG_VER 1

/* Install return codes. The numbers are shown to users ("rc=NN" in the
 * notification and wh.log) and documented in docs/sdk/troubleshooting.md, so
 * they never change. */
enum wh_rc {
  WH_OK                = 0,
  WH_RC_ATTACH         = 2,    /* PT_ATTACH to ShellUI failed */
  WH_RC_ATTACH_WAIT    = 3,    /* waiting for the attach stop failed */
  WH_RC_NO_HERMES      = 10,   /* libhermes not loaded in ShellUI */
  WH_RC_NO_BASE        = 11,   /* libhermes base address not found */
  WH_RC_READ           = 12,   /* could not read ShellUI memory */
  WH_RC_NO_HOOKPOINT   = 13,   /* evaluateJavaScript not found / unexpected prologue */
  WH_RC_FOREIGN_HOOK   = 15,   /* slot 2 already hooked by something that is not us */
  WH_RC_NO_GADGET      = 20,   /* syscall gadget not found */
  WH_RC_CAVE_MMAP      = 21,   /* mapping the code cave failed */
  WH_RC_BRIDGE_MMAP    = 22,   /* mapping the bridge buffer failed */
  WH_RC_DELTA_MMAP     = 23,   /* allocating/mapping the delta failed */
  WH_RC_DELTA_WRITE    = 24,   /* writing the delta failed */
  WH_RC_CAVE_WRITE     = 25,   /* writing the cave failed */
  WH_RC_CAVE_VERIFY    = 26,   /* cave read-back differs */
  WH_RC_SLOT_WRITE     = 27,   /* writing the vtable slot failed */
  WH_RC_SLOT_VERIFY    = 28,   /* vtable slot read-back differs */
  WH_RC_PRELUDE        = 30,   /* building the prelude failed */
  WH_RC_NOMEM          = 31,   /* out of memory in the payload */
  WH_RC_SCAN_SMALL     = 40,   /* libhermes image implausibly small */
  WH_RC_SCAN_NOMEM     = 41,   /* no memory for the libhermes copy */
  WH_RC_SCAN_READ      = 42,   /* reading libhermes failed */
  WH_RC_SCAN_SIG       = 43,   /* function signatures missing or ambiguous */
  WH_RC_SCAN_VTABLE    = 44,   /* vtable pair missing or ambiguous */
};

#endif
