/* Widget asset server interface (see server.c). */
#ifndef WH_SERVER_H
#define WH_SERVER_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

/* Bind the asset port. Returns the listening socket, or -1 with *why set. */
int wh_asset_open(unsigned *gen, const char **why);

/* Current generation in /data/wh-widgets/.wh_gen (0 when unreadable). A newer
 * install bumps it; an older resident server exits when it sees a higher one. */
unsigned wh_gen_read(void);

/* Serve until a newer install bumps the generation; never returns. Also watches
 * SceShellUI: if it respawns (losing our hook), reinstall before the next focus. */
void wh_asset_loop(int s, unsigned my, pid_t shell, size_t dlen, size_t blen, uint64_t bhash);

#endif
