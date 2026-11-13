/* The prelude: the loader plus one section per widget folder in the drop folder. */
#ifndef WH_PRELUDE_H
#define WH_PRELUDE_H
#include <stddef.h>

/* Splice wh_loader + one section per widget folder into a new buffer. Never
 * fails to return a buffer; widgets that cannot load are counted as failed. */
void build_prelude(char **outbuf, size_t *outlen);

/* Summary of the last build_prelude(), used by the install notification. */
extern int wh_wok;      /* widgets spliced in */
extern int wh_wbad;     /* folders that could not be used */
extern int wh_wmore;    /* failures not listed in wh_wfail (buffer full) */
extern char wh_wfail[200];   /* comma-separated names of the failed folders */

#endif
