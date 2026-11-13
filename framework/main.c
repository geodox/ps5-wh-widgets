/* Welcome Hub custom-widget payload (wh_bridge.elf).
 *
 * Hooks evaluateJavaScript in SceShellUI with a detour that runs the widget
 * prelude in every runtime, and swaps the hub's own bytecode for a bridge HBC
 * rebuilt in place from the embedded delta (tools/make_delta.js). It then stays
 * resident as the widget asset server (images, settings, log lines) and
 * reinstalls the hook if ShellUI respawns.
 *
 * Sources:
 *   util.c       log file, notifications, byte/path helpers
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
#include "cave.h"
#include "install.h"
#include "prelude.h"
#include "remote.h"
#include "server.h"
#include "util.h"

/* embedded by embed.S (paths are the names build.sh copies them to) */
extern const uint8_t wh_delta_start[];
extern const uint8_t wh_delta_end[];

int main(void){
  size_t dlen = (size_t)(wh_delta_end - wh_delta_start);
  uint64_t dops = dlen >= 96 ? get64(wh_delta_start + 16) : 0;
  size_t blen = dlen >= 96 ? (size_t)get64(wh_delta_start + 56) : 0;   /* rebuilt bridge size */
  uint64_t bhash = fnv1a64(wh_delta_start, dlen);
  wh_flog("installer", "---- WHBridge %s start ----", WH_VERSION);
  LOG("start fw=%08x delta=%zuB ops=%llu -> bridge %zuB for hub %lluB\n", kernel_get_fw_version(), dlen,
      (unsigned long long)dops, blen, (unsigned long long)(dlen >= 96 ? get64(wh_delta_start) : 0));
  if (dlen < 96 || blen < 0x100000 || 96 + dops * 16 > dlen) { notify("WHBridge failed: embed missing"); return 1; }
  pid_t pid = find_pid("SceShellUI");
  if (pid < 0) { notify("WHBridge failed: ShellUI not found"); return 1; }
  int reload = 0;
  int rc = wh_install_once(pid, dlen, blen, bhash, &reload);
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
    wh_asset_loop(as, gen, pid, dlen, blen, bhash);   /* does not return */
  }
  if (plain) notify("%s  v%s%s\nAsset server: not running (%s)", hook, WH_VERSION, wsum, why);
  else notify("%s (rc=%d)  v%s\nAsset server: not running (%s)", hook, rc, WH_VERSION, why);
  return rc;
}
