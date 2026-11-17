/* Installing the detour + prelude into SceShellUI (see install.c). */
#ifndef WH_INSTALL_H
#define WH_INSTALL_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

struct wh_bridge;

/* One full install into SceShellUI `pid`. Returns a WH_RC_* code (WH_OK =
 * installed) and sets *reload_out when an earlier hook of ours was replaced. */
int wh_install_once(pid_t pid, const struct wh_bridge *br, int *reload_out);

/* Install into a freshly respawned SceShellUI: wait for libhermes, then run the
 * install (retrying only transient allocation/write failures). Returns the rc,
 * or -1 if a newer resident install took over while we waited. */
int wh_rehook(pid_t np, unsigned my, const struct wh_bridge *br);

/* Rebuild the prelude and swap the hook in place, without restarting SceShellUI
 * or reloading the payload: the old cave stays mapped for in-flight calls and
 * one 8-byte slot write moves the detour to the new prelude. The revision stamp
 * makes the hub adopt the new widget set the next time it evaluates its bundle. */
int wh_refresh_in_place(pid_t pid, const struct wh_bridge *br);

#endif
