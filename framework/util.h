/* Shared helpers: version, paths, the log file, notifications, byte helpers. */
#ifndef WH_UTIL_H
#define WH_UTIL_H
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <ps5/klog.h>

/* ---- payload version (YY.MM.DD.x; bumped only for a release) ---- */
#define WH_VERSION "26.11.12 beta"

/* Drop folder: one sub-folder per widget (config.json + widget.js + assets). */
#define WH_WIDGETS_DIR "/data/wh-widgets"

/* ---- log file: /data/wh-widgets/wh.log (rotates to wh.log.1 at 256 KB) ---- */
#define WH_LOG_FILE  "/data/wh-widgets/wh.log"
#define WH_LOG_OLD   "/data/wh-widgets/wh.log.1"
#define WH_LOG_MAX   (256*1024)

/* Append one "<time> [tag] message" line to wh.log. */
void wh_flog(const char* tag, const char* fmt, ...);

/* Log to klog, stdout and wh.log (tag "installer"). */
#define LOG(...) do { char _lb[600]; snprintf(_lb, sizeof _lb, __VA_ARGS__); \
  klog_printf("[wc] %s", _lb); printf("[wc] %s", _lb); wh_flog("installer", "%s", _lb); } while (0)

/* Show a system notification on the console. */
void notify(const char *fmt, ...);

void put64(uint8_t *b, uint64_t v);
uint64_t get64(const uint8_t *b);
uint64_t fnv1a64(const uint8_t *p, size_t n);

#endif
