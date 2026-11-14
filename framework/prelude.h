/* The prelude: the loader plus one section per widget folder in the drop folder. */
#ifndef WH_PRELUDE_H
#define WH_PRELUDE_H
#include <stddef.h>
#include <stdint.h>

/* Splice wh_loader + one section per widget folder into a new buffer. Never
 * fails to return a buffer; widgets that cannot load are counted as failed. */
void build_prelude(char **outbuf, size_t *outlen);

/* FNV-1a64 over every widget folder's config.json + widget.js (sorted). Images
 * are served live by the asset server and are not hashed; 0 = folder unreadable. */
uint64_t wh_widget_fingerprint(void);

/* Fingerprint baked into the prelude returned by the last build_prelude(). */
extern uint64_t wh_prelude_sig;

/* Summary of the last build_prelude(), used by the install notification. */
extern int wh_wok;      /* widgets spliced in */
extern int wh_wbad;     /* folders that could not be used */
extern int wh_wmore;    /* failures not listed in wh_wfail (buffer full) */
extern char wh_wfail[200];   /* comma-separated names of the failed folders */

#endif
