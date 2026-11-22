/* Welcome Hub custom-widget payload (wh_bridge.elf).
 *
 * Hooks evaluateJavaScript in SceShellUI with a detour that runs the widget
 * prelude in every runtime, and swaps the hub's own bytecode for a bridge HBC
 * rebuilt in place from the embedded delta for this firmware (tools/make_delta.js,
 * one per firmware via tools/build_deltas.js). It then stays resident as the
 * widget asset server (images, settings, log lines) and reinstalls the hook if
 * ShellUI respawns.
 *
 * Sources:
 *   util.c       log file, notifications, byte/path helpers
 *   bridge.c     per-firmware delta table
 *   remote.c     find/attach/read/write/map in another process
 *   hookpoint.c  find evaluateJavaScript + its JSI vtable slot in libhermes
 *   prelude.c    loader + one section per widget folder (/data/wh-widgets)
 *   install.c    build the code cave, write it, point the vtable slot at it
 *   server.c     HTTP asset/log/settings server + rehook watch
 *   main.c       this file: startup and the user-facing summary */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <ps5/kernel.h>
#include "bridge.h"
#include "cave.h"
#include "install.h"
#include "prelude.h"
#include "remote.h"
#include "server.h"
#include "util.h"

int main(void){
  uint32_t fw = kernel_get_fw_version();
  wh_flog("installer", "---- WHBridge %s start ----", WH_VERSION);
  const struct wh_bridge* br = wh_bridge_for_fw(fw);
  if (!br) {
    /* No delta for this hub: the hook would only run the stock hub. Say so
     * instead of installing one that silently does nothing. */
    LOG("start fw=%08x: no hub delta for FW %x.%02x in this build (supported: %s); not installing\n",
        fw, fw >> 24, (fw >> 16) & 0xff, wh_bridge_fws);
    notify("WHBridge failed: FW %x.%02x not supported yet\nSupported: %s", fw >> 24, (fw >> 16) & 0xff, wh_bridge_fws);
    return 1;
  }
  LOG("start fw=%08x delta=%zuB -> bridge %zuB for hub %lluB\n", fw, br->dlen, br->blen,
      (unsigned long long)get64(br->delta));
  pid_t pid = find_pid("SceShellUI");
  if (pid < 0) { notify("WHBridge failed: ShellUI not found"); return 1; }
  int reload = 0;
  int rc = wh_install_once(pid, br, &reload);
  if (rc == WH_RC_PRELUDE) { notify("WHBridge failed: widget code"); return 1; }
  if (rc == WH_RC_NOMEM) { notify("WHBridge failed: out of memory"); return 1; }
  if (rc == WH_RC_ATTACH || rc == WH_RC_ATTACH_WAIT) { notify("WHBridge failed: attach"); return rc; }
  /* Stay resident as the widget asset server (the hub's Image only loads http://). */
  unsigned gen = 0; const char* why = "";
  int as = wh_asset_open(&gen, &why);
  const char* hook = rc == WH_OK ? (reload ? "WHBridge reloaded" : "WHBridge loaded")
                  : rc == WH_RC_FOREIGN_HOOK ? "WHBridge failed: hook owned by something else" : "WHBridge failed";
  int plain = (rc == WH_OK || rc == WH_RC_FOREIGN_HOOK);   /* message already says it all */
  char wsum[300] = "";
  if (rc == WH_OK) {
    if (wh_wbad) snprintf(wsum, sizeof wsum, "\nWidgets: %d loaded, %d failed (%s%s)", wh_wok, wh_wbad, wh_wfail, wh_wmore ? ", ..." : "");
    else snprintf(wsum, sizeof wsum, "\nWidgets: %d loaded", wh_wok);
  }
  if (as >= 0) {
    if (plain) notify("%s  v%s%s\nAsset server: running", hook, WH_VERSION, wsum);
    else notify("%s (rc=%d)  v%s\nAsset server: running", hook, rc, WH_VERSION);
    wh_asset_loop(as, gen, pid, br, rc == WH_OK);   /* does not return */
  }
  if (plain) notify("%s  v%s%s\nAsset server: not running (%s)", hook, WH_VERSION, wsum, why);
  else notify("%s (rc=%d)  v%s\nAsset server: not running (%s)", hook, rc, WH_VERSION, why);
  return rc;
}
