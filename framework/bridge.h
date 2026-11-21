/* The bridge for this console's hub: which embedded delta to use (one per
 * supported firmware, built by tools/build_deltas.js) and the hub facts that go
 * with it. The detour still verifies the hub's size and source hash against the
 * delta before swapping, so a hub that differs from the dump stays untouched. */
#ifndef WH_BRIDGE_H
#define WH_BRIDGE_H
#include <stddef.h>
#include <stdint.h>

struct wh_bridge {
  unsigned fw;              /* firmware the delta was built for (0x1360 = FW 13.60) */
  const uint8_t *delta;     /* tools/make_delta.js blob */
  size_t dlen;
  size_t blen;              /* size of the bridge the delta rebuilds */
  uint64_t bhash;           /* FNV-1a64 of the delta: spots an identical bridge on reload */
  const char *hubmods;      /* hub module ids by name: a JS object literal the prelude
                             * sets as globalThis.__wh_hubmods (tools/fid_match.js) */
};

/* The bridge for kernel firmware version `fw` (kernel_get_fw_version()), or NULL
 * when this payload has no delta for it. */
const struct wh_bridge *wh_bridge_for_fw(uint32_t fw);

/* Supported firmwares, for messages: "11.20, 11.40, 13.20, 13.40, 13.60". */
extern const char wh_bridge_fws[];

#endif
