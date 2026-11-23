/* Widget asset server.
 *
 * The hub's Image component only loads http:// (data:/file: URIs fail), so the
 * installer stays resident and serves widget images to ShellUI over loopback.
 * Deliberately minimal and locked down:
 *   - binds 127.0.0.1 only (unreachable from the LAN); one request at a time
 *   - GET only; request line capped at 1 KB; 2 s read/write timeouts
 *   - path must be exactly /<dir>/<file>, each [A-Za-z0-9._-]{1,64}, no leading
 *     '.', no ".."; served from WH_WIDGETS_DIR only, O_NOFOLLOW, regular files
 *   - image types only (.png .jpg .jpeg), <= 1 MB; no listings, no other methods
 *
 * It also carries the loader's log/settings endpoints (/__log, /__wget, /__wset),
 * app launch (/__launch), widget notifications (/__notify), console stats (/__stats) and keeps the hook alive: if ShellUI respawns,
 * it reinstalls before the next focus, it rebuilds the prelude when the widget
 * sources change, and it retires when a newer install bumps the generation file. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/param.h>
#include <sys/mount.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <poll.h>
#include <ps5/kernel.h>
#include <ps5/klog.h>
#include "server.h"
#include "install.h"
#include "prelude.h"
#include "remote.h"
#include "util.h"

/* System services for app launch (see wh_launch_action). */
extern const char wh_store_html[];
int sceKernelLoadStartModule(const char*, size_t, const void*, uint32_t, void*, uint32_t*);
int sceUserServiceInitialize(void*);
int sceUserServiceGetForegroundUser(uint32_t*);
/* Console sensors (see wh_stats_action). Each writes an int; the out buffers are
 * oversized in case a firmware writes more. */
int sceKernelGetCpuTemperature(int*);
int sceKernelGetSocSensorTemperature(int, int*);
int sceKernelGetCurrentFanDuty(uint16_t*, uint64_t*);
int sceKernelIccIsThermalAlert(int*);
int sceKernelGetSocPowerConsumption(void*);
int sceKernelGetSocClock(void*);
uint64_t sceKernelGetCpuFrequency(void);

#define WH_ASSET_PORT 8098
#define WH_ASSET_MAX  (1024*1024)
#define WH_BG_DIR     "/data/wh-backgrounds"
#define WH_BG_IMG_MAX (4*1024*1024)
#define WH_GEN_FILE   WH_WIDGETS_DIR "/.wh_gen"
#define WH_SAMPLE_MS  1000u        /* widget fingerprint sampling period */
#define WH_STABLE_MS  5000u        /* how long a change must hold before rebuilding */

/* Monotonic milliseconds. The refresh check must be timed by the clock, not by
 * poll iterations: serving a request or the rebuild itself (ptrace attach) can
 * take far longer than the 250 ms poll timeout, which would stretch a counted
 * "five samples" window unpredictably. */
static uint64_t wh_now_ms(void){
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts)) return (uint64_t)time(0) * 1000u;   /* fallback */
  return (uint64_t)ts.tv_sec * 1000u + (uint64_t)(ts.tv_nsec / 1000000);
}

static int wh_send_all(int c, const void* b, size_t n){
  const char* p = (const char*)b;
  while (n){ ssize_t w = write(c, p, n); if (w <= 0) return -1; p += w; n -= (size_t)w; }
  return 0;
}
static void wh_reply(int c, const char* status){
  klog_printf("[wc] assets: %s\n", status);
  char h[160]; int n = snprintf(h, sizeof h, "HTTP/1.0 %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status);
  wh_send_all(c, h, (size_t)n);
}
static int wh_hexv(char c){ return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1; }
static void wh_urldecode(const char* in, char* out, size_t cap){
  size_t o = 0;
  for (; *in && *in != '&' && o + 1 < cap; in++) {
    char c = *in;
    if (c == '+') c = ' ';
    else if (c == '%' && wh_hexv(in[1]) >= 0 && wh_hexv(in[2]) >= 0) { c = (char)(wh_hexv(in[1])*16 + wh_hexv(in[2])); in += 2; }
    out[o++] = ((unsigned char)c < 32 || c == 127) ? ' ' : c;
  }
  out[o] = 0;
}
static void wh_hexdecode(const char* in, char* out, size_t cap){
  size_t o = 0;
  while (in[0] && in[0] != '&' && in[1] && in[1] != '&' && o + 1 < cap) {
    int hi = wh_hexv(in[0]), lo = wh_hexv(in[1]);
    if (hi < 0 || lo < 0) break;
    char ch = (char)(hi * 16 + lo); in += 2;
    out[o++] = ((unsigned char)ch < 32 || ch == 127) ? ' ' : ch;
  }
  out[o] = 0;
}
/* ---- App launch: ShellUI URI launch (loopback only) ----------------------
 * Lets widgets launch apps (wh.launch). Any URI is accepted: the user decides
 * which widgets to trust. The URI must decode completely, have a scheme and
 * contain no spaces or control characters; anything else is refused unlaunched. */
static void wh_reply_json(int c, int status, const char* body){
  const char* phrase = status == 200 ? "OK" : status == 400 ? "Bad Request"
    : status == 429 ? "Too Many Requests" : "Bad Gateway";
  size_t n = strlen(body);
  char h[200]; int m = snprintf(h, sizeof h,
    "HTTP/1.0 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
    status, phrase, n);
  wh_send_all(c, h, (size_t)m); wh_send_all(c, body, n);
}
typedef struct { uint32_t size; uint32_t userId; } WHLaunchUriParam;
typedef int (*WHUriInitFn)(void);
typedef int (*WHUriLaunchFn)(const char*, WHLaunchUriParam*);
static int g_shellui_handle = -1;
static WHUriLaunchFn g_shellui_launch = 0;
static int g_shellui_state = 0;            /* 0 = unknown, 1 = ready, -1 = unusable */
static int wh_user_service(void){
  static int tried = 0, ready = 0;
  if (!tried) { tried = 1; ready = (sceUserServiceInitialize(0) == 0); if (!ready) wh_flog("assets", "user service init failed"); }
  return ready;
}
static int wh_shellui_resolve(void){
  if (g_shellui_state) return g_shellui_state > 0 ? 0 : -1;
  g_shellui_state = -1;                    /* do not retry a failed resolve */
  g_shellui_handle = sceKernelLoadStartModule("/system_ex/common_ex/lib/libSceShellUIUtil.sprx", 0, 0, 0, 0, 0);
  if (g_shellui_handle < 0) { wh_flog("assets", "ShellUIUtil load failed (%d)", (int)g_shellui_handle); return -1; }
  intptr_t init = kernel_dynlib_dlsym(-1, (uint32_t)g_shellui_handle, "sceShellUIUtilInitialize");
  intptr_t launch = kernel_dynlib_dlsym(-1, (uint32_t)g_shellui_handle, "sceShellUIUtilLaunchByUri");
  if (init <= 0 || launch <= 0) { wh_flog("assets", "ShellUIUtil symbols not found"); return -1; }
  int rc = ((WHUriInitFn)init)();
  if (rc) { wh_flog("assets", "ShellUIUtil initialize rc=%d", rc); return -1; }
  g_shellui_launch = (WHUriLaunchFn)launch;
  g_shellui_state = 1;
  return 0;
}
static int wh_native_launch(const char* uri){
  if (wh_shellui_resolve()) return -1;
  WHLaunchUriParam param = { sizeof(WHLaunchUriParam), 0 };
  if (wh_user_service()) {
    uint32_t user = 0;
    if (sceUserServiceGetForegroundUser(&user)) { wh_flog("assets", "no foreground user"); return -2; }
    param.userId = user;
  }
  return g_shellui_launch(uri, &param);
}
/* GET /__launch?uri=<url-encoded URI> -> sceShellUIUtilLaunchByUri(uri). */
#define WH_URI_MAX 512
static int wh_uri_decode(const char* in, char* out, size_t cap){
  size_t o = 0;
  for (; *in && *in != '&'; in++) {
    int c = (unsigned char)*in;
    if (c == '%') {
      if (wh_hexv(in[1]) < 0 || wh_hexv(in[2]) < 0) return -1;
      c = wh_hexv(in[1]) * 16 + wh_hexv(in[2]); in += 2;
    }
    if (c <= ' ' || c >= 127 || o + 1 >= cap) return -1;   /* no spaces/controls; no truncation */
    out[o++] = (char)c;
  }
  out[o] = 0;
  size_t k = 0;                              /* scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":" */
  if (!((out[0] >= 'a' && out[0] <= 'z') || (out[0] >= 'A' && out[0] <= 'Z'))) return -1;
  while (out[k] && out[k] != ':') {
    char ch = out[k++];
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '+' || ch == '-' || ch == '.')) return -1;
  }
  return out[k] == ':' ? 0 : -1;
}
static void wh_launch_action(int c, char* q){
  static time_t win = 0; static int cnt = 0;
  time_t now = time(0);
  if (now - win >= 60) { win = now; cnt = 0; }
  if (++cnt > 6) { wh_reply_json(c, 429, "{\"ok\":false,\"error\":\"rate-limited\"}"); return; }
  char uri[WH_URI_MAX] = "";
  int bad = 1;
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "uri=", 4)) bad = wh_uri_decode(t + 4, uri, sizeof uri);
    t = strchr(t, '&'); if (t) t++;
  }
  if (bad) { wh_flog("assets", "launch refused: bad uri"); wh_reply_json(c, 400, "{\"ok\":false,\"error\":\"bad uri\"}"); return; }
  int rc = wh_native_launch(uri);
  wh_flog("assets", "launch: %s rc=%d", uri, rc);
  if (rc) { wh_reply_json(c, 502, "{\"ok\":false,\"error\":\"launch failed\"}"); return; }
  wh_reply_json(c, 200, "{\"ok\":true}");
}
/* ---- Clean embedded Welcome Hub reload (no ShellUI kill, no sign-out) ----
 * Unfocuses the embedded Welcome Hub (media space), opens Control Center so
 * Home UI's AppState transitions to 'inactive' and useHubPooling evicts the
 * unfocused hub runtime, then navigates back to NPXS40063 to mount a fresh
 * embedded hub (re-triggering our evaluateJavaScript hook). Runs on a detached
 * thread so the asset server keeps serving 127.0.0.1:8098 during the reload. */
static volatile int g_reloading = 0;
static volatile int g_manual_reload = 0;
static time_t g_reload_last = 0;
static time_t g_store_active = 0;
static void* wh_reload_thread(void* arg){
  const char* why = (const char*)arg;
  int r1 = wh_native_launch("pshomeui:navigateToHome?spaceId=media");
  usleep(700000);
  int r2 = wh_native_launch("pscontrolcenter:main");
  usleep(700000);
  int r3 = wh_native_launch("pshomeui:navigateToHome?titleId=NPXS40063");
  wh_flog("assets", "hub reload (%s): rc=%d,%d,%d", why ? why : "?", r1, r2, r3);
  g_reloading = 0;
  return 0;
}
static int wh_reload_hub_async(const char* why){
  time_t now = time(0);
  if (g_reloading || (now - g_reload_last) < 4) return -1;
  if (wh_shellui_resolve()) return -2;
  if (wh_user_service()) {
    uint32_t user = 0;
    if (sceUserServiceGetForegroundUser(&user)) return -2;
  }
  g_reloading = 1;
  g_reload_last = now;
  pthread_attr_t attr; pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  pthread_t th;
  int rc = pthread_create(&th, &attr, wh_reload_thread, (void*)why);
  pthread_attr_destroy(&attr);
  if (rc) { g_reloading = 0; wh_flog("assets", "hub reload pthread failed rc=%d", rc); return -3; }
  return 0;
}
static void wh_reload_action(int c){
  time_t now = time(0);
  if (g_reloading || (now - g_reload_last) < 4) {
    wh_reply_json(c, 429, "{\"ok\":false,\"error\":\"rate-limited\"}"); return;
  }
  g_store_active = 0;
  g_manual_reload = 1;
  wh_reply_json(c, 200, "{\"ok\":true}");
}
/* GET /__notify?text=<url-encoded UTF-8> -> a system notification. Control characters
 * other than newline are refused; at most WH_NOTIFY_MAX bytes after decoding. */
#define WH_NOTIFY_MAX 256
static int wh_text_decode(const char* in, char* out, size_t cap){
  size_t o = 0;
  for (; *in && *in != '&'; in++) {
    int c = (unsigned char)*in;
    if (c == '%') {
      if (wh_hexv(in[1]) < 0 || wh_hexv(in[2]) < 0) return -1;
      c = wh_hexv(in[1]) * 16 + wh_hexv(in[2]); in += 2;
    }
    if ((c < ' ' && c != '\n') || c == 127 || o + 1 >= cap) return -1;
    out[o++] = (char)c;
  }
  out[o] = 0;
  return o ? 0 : -1;
}
static void wh_notify_action(int c, char* q){
  static time_t win = 0; static int cnt = 0;
  time_t now = time(0);
  if (now - win >= 60) { win = now; cnt = 0; }
  if (++cnt > 6) { wh_reply_json(c, 429, "{\"ok\":false,\"error\":\"rate-limited\"}"); return; }
  char text[WH_NOTIFY_MAX + 1] = "";
  int bad = 1;
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "text=", 5)) bad = wh_text_decode(t + 5, text, sizeof text);
    t = strchr(t, '&'); if (t) t++;
  }
  if (bad) { wh_flog("assets", "notify refused: bad text"); wh_reply_json(c, 400, "{\"ok\":false,\"error\":\"bad text\"}"); return; }
  notify("%s", text);
  wh_flog("assets", "notify: %.80s", text);
  wh_reply_json(c, 200, "{\"ok\":true}");
}
/* GET /__stats -> {cpuTemp, socTemp, fan, thermalAlert, uptime, storage[]} for the
 * Console Stats widget. Read-only; a field the console does not report is null.
 * fan is the fan duty in percent: sceKernelGetCurrentFanDuty(u16 *duty, u64 *chassis)
 * gives duty out of 1024 (both pointers are required). Memory is not reported: the
 * FreeBSD memory sysctls do not exist for the payload, and Sony's own OIDs give only
 * per-process budgets. */
static void wh_json_int(char* b, size_t cap, size_t* o, const char* key, int ok, long long v){
  if (*o >= cap) return;
  int n = ok ? snprintf(b + *o, cap - *o, "\"%s\":%lld,", key, v) : snprintf(b + *o, cap - *o, "\"%s\":null,", key);
  if (n > 0) *o += (size_t)n;
}
static void wh_stats_action(int c){
  static int logged = 0;
  char b[1536]; size_t o = 0;
  int t[16];                                   /* oversized: one int is expected */
  b[o++] = '{';
  memset(t, 0, sizeof t); int ok = sceKernelGetCpuTemperature(t) == 0;
  wh_json_int(b, sizeof b, &o, "cpuTemp", ok, t[0]);
  memset(t, 0, sizeof t); ok = sceKernelGetSocSensorTemperature(0, t) == 0;
  wh_json_int(b, sizeof b, &o, "socTemp", ok, t[0]);
  uint16_t duty = 0; uint64_t chassis = 0;
  ok = sceKernelGetCurrentFanDuty(&duty, &chassis) == 0 && duty <= 1024;
  wh_json_int(b, sizeof b, &o, "fan", ok, ok ? (duty * 100 + 512) / 1024 : 0);
  int alert = 0;
  ok = sceKernelIccIsThermalAlert(&alert) == 0;
  wh_json_int(b, sizeof b, &o, "thermalAlert", ok, alert ? 1 : 0);
  uint32_t sp[28];                             /* 112B SocPower: +0x00 gfx_mW, +0x0c cpu_mW */
  memset(sp, 0, sizeof sp);
  ok = sceKernelGetSocPowerConsumption(sp) == 0;
  wh_json_int(b, sizeof b, &o, "gfxPowerMw", ok, sp[0]);
  wh_json_int(b, sizeof b, &o, "cpuPowerMw", ok, sp[3]);
  wh_json_int(b, sizeof b, &o, "socPowerMw", ok, (long long)sp[0] + (long long)sp[3]);
  uint32_t clk[26];                            /* 0x68B SocClock: +0x50 (clk[20]) GFX MHz */
  memset(clk, 0, sizeof clk);
  ok = sceKernelGetSocClock(clk) == 0 && clk[20] > 0;
  wh_json_int(b, sizeof b, &o, "gfxClockMhz", ok, clk[20]);
  uint64_t cpuHz = sceKernelGetCpuFrequency();
  ok = cpuHz > 0;
  wh_json_int(b, sizeof b, &o, "cpuClockMhz", ok, ok ? (long long)(cpuHz / 1000000ULL) : 0);
  struct timespec up;
  ok = clock_gettime(CLOCK_UPTIME, &up) == 0;
  wh_json_int(b, sizeof b, &o, "uptime", ok, ok ? (long long)up.tv_sec : 0);
  /* Drives: the internal user partition and any extended / USB storage mounted. */
  static const char* const drives[][2] = {
    {"internal", "/user"}, {"m2", "/mnt/ext1"}, {"extended", "/mnt/ext0"},
    {"usb0", "/mnt/usb0"}, {"usb1", "/mnt/usb1"}, {"usb2", "/mnt/usb2"}, {"usb3", "/mnt/usb3"},
  };
  o += (size_t)snprintf(b + o, sizeof b - o, "\"storage\":[");
  int first = 1;
  for (size_t i = 0; i < sizeof drives / sizeof drives[0] && o < sizeof b - 160; i++) {
    struct statfs fs;
    if (statfs(drives[i][1], &fs) || strcmp(fs.f_mntonname, drives[i][1]) || !fs.f_blocks) continue;  /* not its own mount */
    o += (size_t)snprintf(b + o, sizeof b - o, "%s{\"name\":\"%s\",\"total\":%llu,\"free\":%llu}", first ? "" : ",",
                          drives[i][0], (unsigned long long)fs.f_blocks * fs.f_bsize, (unsigned long long)fs.f_bavail * fs.f_bsize);
    first = 0;
  }
  if (o < sizeof b - 3) { b[o++] = ']'; b[o++] = '}'; }
  b[o < sizeof b ? o : sizeof b - 1] = 0;
  if (!logged) { logged = 1; wh_flog("assets", "stats: %.400s", b); }
  wh_reply_json(c, 200, b);
}
static char g_fseen[16][72]; static int g_fns = 0;   /* widgets already notified this hub load */
static void wh_fail_notify(const char* w, const char* m){
  char (*seen)[72] = g_fseen; int ns = g_fns;
  const char* key = w[0] ? w : "*";
  for (int i = 0; i < ns; i++) if (!strcmp(seen[i], key)) return;
  if (ns >= 16) return;
  snprintf(seen[ns], sizeof seen[0], "%s", key); g_fns = ns + 1;
  if (w[0]) notify("Widget failed: %s\n%.160s\nDetails: " WH_WIDGETS_DIR "/wh.log", w, m);
  else notify("Widgets failed to load\n%.160s\nDetails: " WH_WIDGETS_DIR "/wh.log", m);
}
/* GET /__log?w=<widget>&m=<msg> from the hub loader -> one line in wh.log.
 * Append-only, 400-char cap, control chars stripped, <=120 lines/minute. */
static void wh_log_endpoint(int c, char* q){
  static time_t win = 0; static int cnt = 0, dropped = 0;
  time_t now = time(0);
  if (now - win >= 60) { if (dropped) wh_flog("assets", "log rate limit: dropped %d lines", dropped); win = now; cnt = 0; dropped = 0; }
  if (++cnt > 120) { dropped++; wh_reply(c, "204 No Content"); return; }
  char w[72] = "", m[401] = ""; int fatal = 0;
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "f=1", 3)) fatal = 1;
    if (!strncmp(t, "w=", 2)) wh_hexdecode(t + 2, w, sizeof w);      /* hex (loader) */
    else if (!strncmp(t, "h=", 2)) wh_hexdecode(t + 2, m, sizeof m);  /* hex (loader) */
    else if (!strncmp(t, "m=", 2)) wh_urldecode(t + 2, m, sizeof m);  /* url-encoded (manual) */
    t = strchr(t, '&'); if (t) t++;
  }
  char tag[96] = "hub";
  if (w[0] && wh_name_ok(w, strlen(w))) snprintf(tag, sizeof tag, "widget:%s", w);
  if (m[0]) wh_flog(tag, "%s", m);
  if (!strncmp(m, "loader ready in the hub runtime", 31)) g_fns = 0;   /* new hub load: notify again */
  if (fatal && m[0]) wh_fail_notify(w[0] && wh_name_ok(w, strlen(w)) ? w : "", m);
  wh_reply(c, "204 No Content");
}
#define WH_SET_MAX 2048
#define WH_SET_FILE ".settings.json"
/* The settings file for w: <dir>/<id>/.settings.json for a widget, or <dir>/.hub.json
 * for ".hub", the loader's own (Welcome Hub Settings rows). No widget id starts with
 * a dot, so the two never meet. */
static int wh_settings_path(const char* w, char* fp, size_t n){
  if (!strcmp(w, ".hub")) { snprintf(fp, n, "%s/.hub.json", WH_WIDGETS_DIR); return 1; }
  if (!w[0] || !wh_name_ok(w, strlen(w))) return 0;
  snprintf(fp, n, "%s/%s/%s", WH_WIDGETS_DIR, w, WH_SET_FILE);
  return 1;
}
/* GET /__wget?w=<id> -> that widget's saved settings JSON (loopback only). */
static void wh_settings_get(int c, char* q){
  char w[72] = "";
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "w=", 2)) { size_t o = 0; for (char* u = t + 2; *u && *u != '&' && o + 1 < sizeof w; u++) w[o++] = *u; w[o] = 0; }
    t = strchr(t, '&'); if (t) t++;
  }
  char body[WH_SET_MAX + 1] = "{}"; long blen = 2;
  char fp[256];
  if (wh_settings_path(w, fp, sizeof fp)) {
    int fd = open(fp, O_RDONLY | O_NOFOLLOW);
    if (fd >= 0) {
      struct stat st;
      if (!fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_size > 0 && st.st_size <= WH_SET_MAX) {
        ssize_t r = read(fd, body, (size_t)st.st_size); if (r > 0) { body[r] = 0; blen = r; }
      }
      close(fd);
    }
  }
  char h[200]; int n = snprintf(h, sizeof h,
    "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: %ld\r\nConnection: close\r\n\r\n", blen);
  wh_send_all(c, h, (size_t)n); wh_send_all(c, body, (size_t)blen);
}
/* GET /__wset?w=<id>&h=<hex json> -> write the widget's settings (atomic, <=2 KB, 120/min). */
static void wh_settings_set(int c, char* q){
  static time_t win = 0; static int cnt = 0;
  time_t now = time(0);
  if (now - win >= 60) { win = now; cnt = 0; }
  if (++cnt > 120) { wh_reply(c, "204 No Content"); return; }
  char w[72] = ""; char body[WH_SET_MAX + 1] = "";
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "w=", 2)) { size_t o = 0; for (char* u = t + 2; *u && *u != '&' && o + 1 < sizeof w; u++) w[o++] = *u; w[o] = 0; }
    else if (!strncmp(t, "h=", 2)) wh_hexdecode(t + 2, body, sizeof body);
    t = strchr(t, '&'); if (t) t++;
  }
  char fp[256], tp[300];
  if (!wh_settings_path(w, fp, sizeof fp) || !body[0] || body[0] != '{') { wh_reply(c, "204 No Content"); return; }
  snprintf(tp, sizeof tp, "%s.tmp", fp);
  int fd = open(tp, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
  if (fd >= 0) {
    size_t bl = strlen(body); int ok = (write(fd, body, bl) == (ssize_t)bl);
    close(fd);
    if (ok && rename(tp, fp) == 0) wh_flog("assets", "saved settings for %s (%zuB)", w, bl);
    else { unlink(tp); wh_flog("assets", "settings save failed for %s", w); }
  }
  wh_reply(c, "204 No Content");
}
/* GET /__backgrounds -> JSON array of custom animated (.mp4) backgrounds in WH_BG_DIR. */
static void wh_bg_img_pick(const char* stem, const char* suffix, char* out, size_t cap){
  static const char* const exts[] = { ".jpg", ".jpeg", ".png" };
  char fp[256]; struct stat st;
  for (size_t i = 0; i < sizeof exts / sizeof exts[0]; i++) {
    snprintf(fp, sizeof fp, "%s/%s%s%s", WH_BG_DIR, stem, suffix, exts[i]);
    if (!lstat(fp, &st) && S_ISREG(st.st_mode) && st.st_size > 0 && st.st_size <= WH_BG_IMG_MAX) {
      snprintf(out, cap, "http://127.0.0.1:%d/__bg/%s%s%s", WH_ASSET_PORT, stem, suffix, exts[i]);
      return;
    }
  }
  out[0] = 0;
}
static void wh_backgrounds_list(int c){
  char body[8192]; size_t blen = 0;
  body[blen++] = '[';
  DIR* d = opendir(WH_BG_DIR);
  if (d) {
    struct dirent* e; int count = 0;
    while ((e = readdir(d)) != 0 && count < 32) {
      const char* n = e->d_name;
      size_t nl = strlen(n);
      if (nl < 5 || nl > 64 || strcasecmp(n + nl - 4, ".mp4")) continue;
      if (!wh_name_ok(n, nl)) continue;
      char fp[256]; struct stat st;
      snprintf(fp, sizeof fp, "%s/%s", WH_BG_DIR, n);
      if (lstat(fp, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0) continue;
      char stem[68]; size_t sl = nl - 4;
      memcpy(stem, n, sl); stem[sl] = 0;
      char thumb[192], ph[192];
      wh_bg_img_pick(stem, "-thumbnail", thumb, sizeof thumb);
      if (!thumb[0]) wh_bg_img_pick(stem, "", thumb, sizeof thumb);
      wh_bg_img_pick(stem, "-placeholder", ph, sizeof ph);
      if (!ph[0]) snprintf(ph, sizeof ph, "%s", thumb);
      if (!thumb[0]) snprintf(thumb, sizeof thumb, "%s", ph);
      snprintf(fp, sizeof fp, "%s/%s.audio", WH_BG_DIR, stem);
      int audio = (!lstat(fp, &st) && S_ISREG(st.st_mode));
      char row[640];
      int rl = snprintf(row, sizeof row,
        "%s{\"id\":\"%s\",\"video\":\"http://127.0.0.1:%d/__bg/%s\",\"thumb\":\"%s\",\"placeholder\":\"%s\",\"audio\":%s}",
        count ? "," : "", stem, WH_ASSET_PORT, n, thumb, ph, audio ? "true" : "false");
      if (rl <= 0 || blen + (size_t)rl + 2 >= sizeof body) break;
      memcpy(body + blen, row, (size_t)rl); blen += (size_t)rl; count++;
    }
    closedir(d);
  }
  body[blen++] = ']'; body[blen] = 0;
  char h[200]; int hn = snprintf(h, sizeof h,
    "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n", blen);
  wh_send_all(c, h, (size_t)hn); wh_send_all(c, body, blen);
}
/* GET /__bg/<file> -> serve custom background image or .mp4 (with HTTP Range) from WH_BG_DIR. */
static void wh_bg_asset(int c, char* name, const char* range_hdr){
  char* q = strchr(name, '?'); if (q) *q = 0;
  size_t fl = strlen(name);
  if (!wh_name_ok(name, fl) || strchr(name, '/')) { wh_reply(c, "404 Not Found"); return; }
  int is_mp4 = (fl >= 5 && !strcasecmp(name + fl - 4, ".mp4"));
  const char* type = is_mp4 ? "video/mp4" : wh_img_type(name);
  if (!type) { wh_reply(c, "404 Not Found"); return; }
  char fp[256]; snprintf(fp, sizeof fp, "%s/%s", WH_BG_DIR, name);
  int fd = open(fp, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) { wh_flog("assets", "bg 404 %s", name); wh_reply(c, "404 Not Found"); return; }
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0 || (!is_mp4 && st.st_size > WH_BG_IMG_MAX)) {
    close(fd); wh_reply(c, "404 Not Found"); return;
  }
  long total = (long)st.st_size, start = 0, end = total - 1;
  int partial = 0;
  if (range_hdr && !strncmp(range_hdr, "bytes=", 6)) {
    const char* r = range_hdr + 6;
    char* dash = strchr(r, '-');
    if (dash) {
      int valid = 0;
      if (dash == r) {
        /* Suffix range: bytes=-N requests the last N bytes. */
        if (dash[1] >= '0' && dash[1] <= '9') {
          long suffix = strtol(dash + 1, 0, 10);
          if (suffix > 0) {
            start = suffix >= total ? 0 : total - suffix;
            end = total - 1;
            valid = 1;
          }
        }
      } else if (r[0] >= '0' && r[0] <= '9') {
        start = strtol(r, 0, 10);
        end = (dash[1] >= '0' && dash[1] <= '9') ? strtol(dash + 1, 0, 10) : total - 1;
        valid = 1;
      }
      if (!valid || start < 0 || start >= total || end < start) {
        char rh[160];
        int rn = snprintf(rh, sizeof rh,
          "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */%ld\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
          total);
        wh_send_all(c, rh, (size_t)rn);
        close(fd);
        return;
      }
      if (end >= total) end = total - 1;
      partial = 1;
    }
  }
  long clen = end - start + 1;
  char h[256]; int hn;
  if (partial) {
    hn = snprintf(h, sizeof h,
      "HTTP/1.1 206 Partial Content\r\nContent-Type: %s\r\nAccept-Ranges: bytes\r\nContent-Range: bytes %ld-%ld/%ld\r\nContent-Length: %ld\r\nConnection: close\r\n\r\n",
      type, start, end, total, clen);
    lseek(fd, start, SEEK_SET);
  } else {
    hn = snprintf(h, sizeof h,
      "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nAccept-Ranges: bytes\r\nContent-Length: %ld\r\nCache-Control: max-age=60\r\nConnection: close\r\n\r\n",
      type, total);
  }
  if (is_mp4) wh_flog("assets", "bg %s %s %ld-%ld/%ld", partial ? "206" : "200", name, start, end, total);
  if (wh_send_all(c, h, (size_t)hn) < 0) { close(fd); return; }
  char buf[16384]; long rem = clen;
  while (rem > 0) {
    ssize_t r = read(fd, buf, rem > (long)sizeof buf ? sizeof buf : (size_t)rem);
    if (r <= 0) break;
    if (wh_send_all(c, buf, (size_t)r) < 0) break;
    rem -= (long)r;
  }
  close(fd);
}
/* ---- Built-in Widget Store (/__store, LAN + loopback) -------------------- */
#define WH_STORE_SOURCES WH_WIDGETS_DIR "/.store.json"
#define WH_STORE_SRC_MAX 4096
#define WH_STORE_QUIET_S 120   /* suppress auto-reload while user is in the Store */
static int wh_store_ext_ok(const char* f){
  const char* d = strrchr(f, '.');
  if (!d) return 0;
  return !strcasecmp(d, ".json") || !strcasecmp(d, ".js") || !strcasecmp(d, ".png") ||
         !strcasecmp(d, ".jpg") || !strcasecmp(d, ".jpeg") || !strcasecmp(d, ".md") || !strcasecmp(d, ".txt");
}
static void wh_json_esc(char* out, size_t cap, const char* in){
  size_t o = 0;
  for (; in && *in && o + 2 < cap; in++) {
    unsigned char ch = (unsigned char)*in;
    if (ch == '"' || ch == '\\') { out[o++] = '\\'; out[o++] = (char)ch; }
    else if (ch >= 32 && ch != 127) out[o++] = (char)ch;
  }
  out[o] = 0;
}
static void wh_json_str_field(const char* fp, const char* key, char* out, size_t cap){
  out[0] = 0;
  int fd = open(fp, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return;
  char buf[2048]; ssize_t r = read(fd, buf, sizeof buf - 1); close(fd);
  if (r <= 0) return;
  buf[r] = 0;
  char pat[64]; snprintf(pat, sizeof pat, "\"%s\"", key);
  char* p = strstr(buf, pat);
  if (!p) return;
  p += strlen(pat);
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
  if (*p != ':') return;
  p++;
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
  if (*p != '"') return;
  p++;
  size_t o = 0;
  while (*p && *p != '"' && o + 1 < cap) {
    if (*p == '\\' && p[1]) p++;
    out[o++] = *p++;
  }
  out[o] = 0;
}
static void wh_store_page(int c){
  size_t len = strlen(wh_store_html);
  char h[200];
  int hn = snprintf(h, sizeof h,
    "HTTP/1.0 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %zu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
    len);
  if (wh_send_all(c, h, (size_t)hn) == 0) wh_send_all(c, wh_store_html, len);
}
static void wh_store_state(int c){
  char* out = (char*)malloc(32768);
  if (!out) { wh_reply(c, "500 Internal Server Error"); return; }
  size_t cap = 32768, o = 0;
  struct stat bst;
  int has_bps5 = (stat("/data/homebrew/PPSA97024/eboot.bin", &bst) == 0);
  o += (size_t)snprintf(out + o, cap - o, "{\"version\":\"%s\",\"browserPS5\":%s,\"installed\":[",
                        WH_VERSION, has_bps5 ? "true" : "false");
  DIR* d = opendir(WH_WIDGETS_DIR);
  int first = 1;
  if (d) {
    struct dirent* e;
    while ((e = readdir(d)) && o + 512 < cap) {
      size_t nl = strlen(e->d_name);
      if (!wh_name_ok(e->d_name, nl)) continue;
      char cfg[256], meta[256];
      snprintf(cfg, sizeof cfg, "%s/%s/config.json", WH_WIDGETS_DIR, e->d_name);
      struct stat st;
      if (stat(cfg, &st) || !S_ISREG(st.st_mode)) continue;
      snprintf(meta, sizeof meta, "%s/%s/.meta.json", WH_WIDGETS_DIR, e->d_name);
      char title[128], ver[64], et[256], ev[128];
      wh_json_str_field(cfg, "title", title, sizeof title);
      wh_json_str_field(meta, "version", ver, sizeof ver);
      if (!ver[0]) wh_json_str_field(cfg, "version", ver, sizeof ver);
      wh_json_esc(et, sizeof et, title[0] ? title : e->d_name);
      wh_json_esc(ev, sizeof ev, ver);
      o += (size_t)snprintf(out + o, cap - o, "%s{\"id\":\"%s\",\"title\":\"%s\",\"version\":\"%s\"}",
                            first ? "" : ",", e->d_name, et, ev);
      first = 0;
    }
    closedir(d);
  }
  char srcs[WH_STORE_SRC_MAX + 1] = "[]";
  int sfd = open(WH_STORE_SOURCES, O_RDONLY | O_NOFOLLOW);
  if (sfd >= 0) {
    ssize_t sr = read(sfd, srcs, WH_STORE_SRC_MAX);
    close(sfd);
    if (sr > 0 && srcs[0] == '[') srcs[sr] = 0;
    else strcpy(srcs, "[]");
  }
  o += (size_t)snprintf(out + o, cap - o, "],\"sources\":%s}", srcs);
  wh_reply_json(c, 200, out);
  free(out);
}
static void wh_store_file(int c, char* q, const char* body, size_t blen){
  char id[72] = "", name[72] = "";
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "id=", 3)) wh_urldecode(t + 3, id, sizeof id);
    else if (!strncmp(t, "name=", 5)) wh_urldecode(t + 5, name, sizeof name);
    t = strchr(t, '&'); if (t) t++;
  }
  int name_ok = !strcmp(name, ".meta.json") || (wh_name_ok(name, strlen(name)) && wh_store_ext_ok(name));
  if (!wh_name_ok(id, strlen(id)) || !name_ok) {
    wh_reply_json(c, 400, "{\"ok\":false,\"error\":\"bad id or filename\"}"); return;
  }
  char dir[256], fp[320];
  snprintf(dir, sizeof dir, "%s/%s", WH_WIDGETS_DIR, id);
  mkdir(dir, 0755);
  snprintf(fp, sizeof fp, "%s/%s", dir, name);
  int fd = open(fp, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
  if (fd < 0) { wh_reply_json(c, 502, "{\"ok\":false,\"error\":\"open failed\"}"); return; }
  size_t off = 0; int ok = 1;
  while (off < blen) {
    ssize_t w = write(fd, body + off, blen - off);
    if (w <= 0) { ok = 0; break; }
    off += (size_t)w;
  }
  close(fd);
  if (!ok) { wh_reply_json(c, 502, "{\"ok\":false,\"error\":\"write failed\"}"); return; }
  wh_flog("assets", "store: wrote %s/%s (%zuB)", id, name, blen);
  wh_reply_json(c, 200, "{\"ok\":true}");
}
static void wh_store_uninstall(int c, char* q){
  char id[72] = "";
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "id=", 3)) wh_urldecode(t + 3, id, sizeof id);
    t = strchr(t, '&'); if (t) t++;
  }
  if (!wh_name_ok(id, strlen(id))) { wh_reply_json(c, 400, "{\"ok\":false,\"error\":\"bad id\"}"); return; }
  char dir[256]; snprintf(dir, sizeof dir, "%s/%s", WH_WIDGETS_DIR, id);
  DIR* d = opendir(dir);
  if (!d) { wh_reply_json(c, 400, "{\"ok\":false,\"error\":\"not found\"}"); return; }
  struct dirent* e;
  while ((e = readdir(d))) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    char fp[384]; snprintf(fp, sizeof fp, "%s/%s", dir, e->d_name);
    unlink(fp);
  }
  closedir(d);
  if (rmdir(dir) != 0) { wh_reply_json(c, 502, "{\"ok\":false,\"error\":\"rmdir failed\"}"); return; }
  wh_flog("assets", "store: uninstalled %s", id);
  wh_reply_json(c, 200, "{\"ok\":true}");
}
static void wh_store_sources(int c, const char* body, size_t blen){
  if (blen < 2 || blen > WH_STORE_SRC_MAX || body[0] != '[') {
    wh_reply_json(c, 400, "{\"ok\":false,\"error\":\"bad sources\"}"); return;
  }
  int fd = open(WH_STORE_SOURCES, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
  if (fd < 0) { wh_reply_json(c, 502, "{\"ok\":false,\"error\":\"open failed\"}"); return; }
  ssize_t w = write(fd, body, blen); close(fd);
  if (w != (ssize_t)blen) { wh_reply_json(c, 502, "{\"ok\":false,\"error\":\"write failed\"}"); return; }
  wh_flog("assets", "store: saved sources (%zuB)", blen);
  wh_reply_json(c, 200, "{\"ok\":true}");
}
static void wh_asset_conn(int c, int is_local){
  char req[2048]; size_t got = 0; char* hdr_end = 0;
  while (got < sizeof req - 1){
    ssize_t r = read(c, req + got, sizeof req - 1 - got);
    if (r <= 0) break;
    got += (size_t)r; req[got] = 0;
    hdr_end = strstr(req, "\r\n\r\n");
    if (hdr_end) break;
  }
  req[got] = 0;
  if (!hdr_end) { wh_reply(c, "400 Bad Request"); return; }
  char* eol = strstr(req, "\r\n");
  if (!eol) { wh_reply(c, "400 Bad Request"); return; }
  char range[64] = ""; long clen_hdr = 0;
  for (char* p = eol + 2; p && p < hdr_end; ) {
    char* nl = strstr(p, "\r\n");
    if (!nl || nl == p) break;
    if (!strncasecmp(p, "Range:", 6)) {
      char* v = p + 6; while (v < nl && (*v == ' ' || *v == '\t')) v++;
      size_t rl = (size_t)(nl - v); if (rl >= sizeof range) rl = sizeof range - 1;
      memcpy(range, v, rl); range[rl] = 0;
    } else if (!strncasecmp(p, "Content-Length:", 15)) {
      clen_hdr = strtol(p + 15, 0, 10);
    }
    p = nl + 2;
  }
  *eol = 0;
  if (!strncmp(req, "POST /__store/", 14)) {
    g_store_active = time(0);
    if (clen_hdr < 0 || clen_hdr > WH_ASSET_MAX) { wh_reply(c, "413 Payload Too Large"); return; }
    char* path = req + 6;                    /* after "POST /" */
    char* sp = strchr(path, ' '); if (sp) *sp = 0;
    size_t need = (size_t)clen_hdr;
    char* body = (char*)malloc(need + 1);
    if (!body) { wh_reply(c, "500 Internal Server Error"); return; }
    size_t hdr_len = (size_t)((hdr_end + 4) - req);
    size_t have = got > hdr_len ? got - hdr_len : 0;
    if (have > need) have = need;
    if (have) memcpy(body, hdr_end + 4, have);
    while (have < need) {
      ssize_t r = read(c, body + have, need - have);
      if (r <= 0) break;
      have += (size_t)r;
    }
    body[have] = 0;
    if (have != need) { free(body); wh_reply(c, "400 Bad Request"); return; }
    if (!strncmp(path, "__store/file?", 13)) wh_store_file(c, path + 13, body, have);
    else if (!strncmp(path, "__store/uninstall?", 18)) wh_store_uninstall(c, path + 18);
    else if (!strcmp(path, "__store/sources")) wh_store_sources(c, body, have);
    else wh_reply(c, "404 Not Found");
    free(body);
    return;
  }
  if (strncmp(req, "GET /", 5)) { wh_reply(c, "405 Method Not Allowed"); return; }
  char* path = req + 5;                      /* after "GET /" */
  char* sp = strchr(path, ' '); if (sp) *sp = 0;
  if (!path[0] || !strcmp(path, "__store") || !strcmp(path, "__store/")) { g_store_active = time(0); wh_store_page(c); return; }
  if (!strcmp(path, "__store/state") || !strncmp(path, "__store/state?", 14)) { g_store_active = time(0); wh_store_state(c); return; }
  if (!strcmp(path, "__reload") || !strncmp(path, "__reload?", 9)) { wh_reload_action(c); return; }
  if (!is_local) { wh_reply(c, "403 Forbidden"); return; }
  if (!strncmp(path, "__log?", 6)) { wh_log_endpoint(c, path + 6); return; }
  if (!strncmp(path, "__wget?", 7)) { wh_settings_get(c, path + 7); return; }
  if (!strncmp(path, "__wset?", 7)) { wh_settings_set(c, path + 7); return; }
  if (!strncmp(path, "__launch?", 9)) { wh_launch_action(c, path + 9); return; }
  if (!strncmp(path, "__notify?", 9)) { wh_notify_action(c, path + 9); return; }
  if (!strcmp(path, "__stats") || !strncmp(path, "__stats?", 8)) { wh_stats_action(c); return; }
  if (!strcmp(path, "__backgrounds") || !strncmp(path, "__backgrounds?", 14)) { wh_backgrounds_list(c); return; }
  if (!strncmp(path, "__bg/", 5)) { wh_bg_asset(c, path + 5, range[0] ? range : 0); return; }
  char shown[100]; snprintf(shown, sizeof shown, "%s", path);   /* for refused-request log lines */
  char* q = strchr(path, '?');  if (q) *q = 0;
  char* sl = strchr(path, '/');
  if (!sl || strchr(sl + 1, '/')) { wh_flog("assets", "refused /%s: path is not /<widget>/<file>", shown); wh_reply(c, "404 Not Found"); return; }
  size_t dl = (size_t)(sl - path), fl = strlen(sl + 1);
  if (!wh_name_ok(path, dl) || !wh_name_ok(sl + 1, fl)) { wh_flog("assets", "refused /%s: invalid characters in name", shown); wh_reply(c, "404 Not Found"); return; }
  const char* type = wh_img_type(sl + 1);
  if (!type) { wh_flog("assets", "refused /%s: not a .png/.jpg image", shown); wh_reply(c, "404 Not Found"); return; }
  *sl = 0;
  char fp[256]; snprintf(fp, sizeof fp, "%s/%s/%s", WH_WIDGETS_DIR, path, sl + 1);
  int fd = open(fp, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) { wh_flog("assets", "refused /%s: file not found", shown); wh_reply(c, "404 Not Found"); return; }
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > WH_ASSET_MAX) {
    close(fd); wh_flog("assets", "refused /%s: not a regular file or over 1 MB", shown); wh_reply(c, "404 Not Found"); return;
  }
  char h[200]; int n = snprintf(h, sizeof h,
    "HTTP/1.0 200 OK\r\nContent-Type: %s\r\nContent-Length: %ld\r\nCache-Control: max-age=60\r\nConnection: close\r\n\r\n",
    type, (long)st.st_size);
  klog_printf("[wc] assets: 200 /%s/%s %ldB\n", path, sl + 1, (long)st.st_size);
  if (wh_send_all(c, h, (size_t)n) < 0) { close(fd); return; }
  char buf[8192]; ssize_t r;
  while ((r = read(fd, buf, sizeof buf)) > 0) { if (wh_send_all(c, buf, (size_t)r) < 0) break; }
  close(fd);
}
unsigned wh_gen_read(void){
  char b[32] = {0}; int fd = open(WH_GEN_FILE, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return 0;
  ssize_t r = read(fd, b, sizeof b - 1); close(fd);
  return r > 0 ? (unsigned)strtoul(b, 0, 10) : 0;
}
static unsigned wh_gen_bump(void){
  unsigned g = wh_gen_read() + 1;
  int fd = open(WH_GEN_FILE, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
  if (fd < 0) return 0;                      /* can't write: never retire on a read */
  char b[32]; int n = snprintf(b, sizeof b, "%u\n", g);
  ssize_t w = write(fd, b, (size_t)n); close(fd);
  return w == n ? g : 0;
}
int wh_asset_open(unsigned* gen, const char** why){
  *gen = 0; *why = "failed";
  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (s < 0) { klog_printf("[wc] assets: socket failed\n"); return -1; }
  int one = 1; setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a; memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_port = htons(WH_ASSET_PORT); a.sin_addr.s_addr = htonl(INADDR_ANY);
  unsigned my = wh_gen_bump();               /* tells an older server to retire */
  *gen = my;
  int bound = 0;
  for (int t = 0; t < 30 && !bound; t++) {   /* ~6 s for it to notice (it polls 1/s) */
    if (!bind(s, (struct sockaddr*)&a, sizeof a) && !listen(s, 8)) bound = 1;
    else usleep(200000);
  }
  if (!bound) {
    LOG("assets: 0.0.0.0:%d still busy, not serving\n", WH_ASSET_PORT);
    close(s); *why = "port busy"; return -1;
  }
  LOG("assets: serving %s on 0.0.0.0:%d (gen %u)\n", WH_WIDGETS_DIR, WH_ASSET_PORT, my);
  return s;
}
void wh_asset_loop(int s, unsigned my, pid_t shell, const struct wh_bridge* br, int auto_reload){
  signal(SIGPIPE, SIG_IGN);
  fflush(stdout); fflush(stderr);
  int dn = open("/dev/null", O_RDWR);        /* detach stdio so the loader connection ends */
  if (dn >= 0) { dup2(dn, 0); dup2(dn, 1); dup2(dn, 2); if (dn > 2) close(dn); }
  if (auto_reload) wh_reload_hub_async("install");
  struct timeval tv = { 5, 0 };
  /* In-place widget refresh: sample the source fingerprint at ~1 Hz and rebuild
   * the prelude once a change has been identical for WH_STABLE_MS. Sampling is
   * clock-driven, so a served request or the rebuild itself cannot stretch the
   * stability window. SceShellUI keeps running; only the hook slot moves. */
  uint64_t applied = wh_prelude_sig;         /* fingerprint live in SceShellUI */
  uint64_t candidate = wh_prelude_sig;
  uint64_t candidate_since = 0, next_sample = wh_now_ms() + WH_SAMPLE_MS;
  int attempts = 0, pending_reload = 0;
  for (;;) {
    struct pollfd pf = { s, POLLIN, 0 };
    int pr = poll(&pf, 1, 250);
    if (my && wh_gen_read() > my) {          /* a newer install took over */
      klog_printf("[wc] assets: gen %u superseded, retiring\n", my);
      wh_flog("assets", "server gen %u handed over to a newer install, exiting", my);
      close(s); _exit(0);
    }
    if (g_manual_reload) {
      g_manual_reload = 0;
      uint64_t sig = wh_widget_fingerprint();
      if (sig && sig != applied) {
        wh_flog("assets", "manual reload: refreshing pending widget changes first");
        if (wh_refresh_in_place(shell, br) == 0) { applied = candidate = wh_prelude_sig; candidate_since = 0; attempts = 0; }
      }
      wh_reload_hub_async("manual");
    }
    if (pending_reload) {
      int rrc = wh_reload_hub_async("widget-refresh");
      if (rrc == 0 || rrc < -1) pending_reload = 0;   /* started or non-cooldown failure */
    }
    uint64_t t = wh_now_ms();
    if (t >= next_sample) {                  /* ~1 Hz by deadline, not by iterations */
      next_sample = t + WH_SAMPLE_MS;
      uint64_t sig = wh_widget_fingerprint();
      if (sig && sig != applied) {
        if (sig != candidate) { candidate = sig; candidate_since = t; }   /* changed: restart the window */
        else if (t - candidate_since >= WH_STABLE_MS) {
          candidate_since = t;               /* a retry waits another full window */
          wh_flog("assets", "widget sources stable for %us (sig %016llx); refreshing prelude in place",
                  (unsigned)(WH_STABLE_MS / 1000u), (unsigned long long)candidate);
          int rr = wh_refresh_in_place(shell, br);
          if (rr == 0) {
            applied = candidate = wh_prelude_sig; attempts = 0;
            if (g_store_active && (time(0) - g_store_active) < WH_STORE_QUIET_S) {
              wh_flog("assets", "in-place refresh ready (auto-reload paused while Widget Store is active)");
            } else if (wh_reload_hub_async("widget-refresh") == -1) {
              pending_reload = 1;
            }
          }
          else if (++attempts >= 3) {
            wh_flog("assets", "in-place refresh failed 3x (rc=%d); waiting for the next change", rr);
            applied = candidate = wh_prelude_sig; attempts = 0;
          } else wh_flog("assets", "in-place refresh failed rc=%d; will retry", rr);
        }
      } else { candidate = applied; candidate_since = 0; }
    }
    pid_t np = find_pid("SceShellUI");
    if (np > 0 && np != shell) {             /* ShellUI respawned: our hook is gone with it */
      wh_flog("installer", "SceShellUI pid %d -> %d, reinstalling", (int)shell, (int)np);
      int rr = wh_rehook(np, my, br);
      if (rr < 0) { wh_flog("assets", "server gen %u handed over to a newer install, exiting", my); close(s); _exit(0); }
      shell = np;
      applied = candidate = wh_prelude_sig; candidate_since = 0; attempts = 0;
      if (rr == 0) { wh_flog("installer", "reinstalled into SceShellUI pid %d", (int)np); notify("WHBridge reinstalled after ShellUI restart  v%s", WH_VERSION); }
      else { wh_flog("installer", "reinstall into pid %d failed rc=%d", (int)np, rr); notify("WHBridge: ShellUI restarted, reinstall failed (rc=%d)", rr); }
      continue;
    }
    if (pr <= 0) continue;
    struct sockaddr_in peer; socklen_t plen = sizeof peer;
    memset(&peer, 0, sizeof peer);
    int c = accept(s, (struct sockaddr*)&peer, &plen);
    if (c < 0) { if (errno == EINTR) continue; usleep(100000); continue; }
    int is_local = (peer.sin_addr.s_addr == htonl(INADDR_LOOPBACK));
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    wh_asset_conn(c, is_local);
    close(c);
  }
}
