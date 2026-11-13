/* Shared helpers: the wh.log writer, notifications, byte helpers. */
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
#include "util.h"

void wh_flog(const char* tag, const char* fmt, ...) {
  char msg[600]; va_list ap; va_start(ap, fmt); vsnprintf(msg, sizeof msg, fmt, ap); va_end(ap);
  size_t n = strlen(msg); while (n && (msg[n-1] == '\n' || msg[n-1] == '\r')) msg[--n] = 0;
  for (size_t i = 0; i < n; i++) if ((unsigned char)msg[i] < 32) msg[i] = ' ';   /* one line per entry */
  struct stat st;
  if (!stat(WH_LOG_FILE, &st) && st.st_size > WH_LOG_MAX) rename(WH_LOG_FILE, WH_LOG_OLD);
  int fd = open(WH_LOG_FILE, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0644);
  if (fd < 0) return;
  char ts[32] = "(no clock)"; time_t t = time(0); struct tm tmv;
  if (localtime_r(&t, &tmv)) strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", &tmv);
  char line[720]; int l = snprintf(line, sizeof line, "%s [%s] %s\n", ts, tag, msg);
  if (l > 0) { ssize_t w = write(fd, line, (size_t)(l < (int)sizeof line ? l : (int)sizeof line - 1)); (void)w; }
  close(fd);
}

void put64(uint8_t *b, uint64_t v) { memcpy(b, &v, 8); }
uint64_t get64(const uint8_t *b) { uint64_t v; memcpy(&v, b, 8); return v; }
uint64_t fnv1a64(const uint8_t *p, size_t n) {
  uint64_t h = 0xcbf29ce484222325ull;
  while (n--) { h ^= *p++; h *= 0x100000001b3ull; }
  return h;
}

typedef struct notify_request { char u[45]; char message[3075]; } notify_request_t;
int sceKernelSendNotificationRequest(int, notify_request_t*, size_t, int);
void notify(const char *fmt, ...) {
  notify_request_t req; va_list ap; bzero(&req, sizeof req);
  va_start(ap, fmt); vsnprintf(req.message, sizeof req.message, fmt, ap); va_end(ap);
  sceKernelSendNotificationRequest(0, &req, sizeof req, 0);
}
