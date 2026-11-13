/* Installing the detour + prelude into SceShellUI (see install.c). */
#ifndef WH_INSTALL_H
#define WH_INSTALL_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

/* One full install into SceShellUI `pid`. Returns a WH_RC_* code (WH_OK =
 * installed) and sets *reload_out when an earlier hook of ours was replaced. */
int wh_install_once(pid_t pid, size_t dlen, size_t blen, uint64_t bhash, int *reload_out);

/* Install into a freshly respawned SceShellUI: wait for libhermes, then run the
 * install (retrying only transient allocation/write failures). Returns the rc,
 * or -1 if a newer resident install took over while we waited. */
int wh_rehook(pid_t np, unsigned my, size_t dlen, size_t blen, uint64_t bhash);

#endif
