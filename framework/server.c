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
 * app launch (/__launch) and keeps the hook alive: if ShellUI respawns,
 * it reinstalls before the next focus, it rebuilds the prelude when the widget
 * sources change, and it retires when a newer install bumps the generation file. */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
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
int sceKernelLoadStartModule(const char*, size_t, const void*, uint32_t, void*, uint32_t*);
int sceUserServiceInitialize(void*);
int sceUserServiceGetForegroundUser(uint32_t*);

#define WH_ASSET_PORT 8098
#define WH_ASSET_MAX  (1024*1024)
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

static void wh_send_all(int c, const void* b, size_t n){
  const char* p = (const char*)b;
  while (n){ ssize_t w = write(c, p, n); if (w <= 0) return; p += w; n -= (size_t)w; }
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
/* GET /__wget?w=<id> -> that widget's saved settings JSON (loopback only). */
static void wh_settings_get(int c, char* q){
  char w[72] = "";
  for (char* t = q; t && *t; ) {
    if (!strncmp(t, "w=", 2)) { size_t o = 0; for (char* u = t + 2; *u && *u != '&' && o + 1 < sizeof w; u++) w[o++] = *u; w[o] = 0; }
    t = strchr(t, '&'); if (t) t++;
  }
  char body[WH_SET_MAX + 1] = "{}"; long blen = 2;
  if (w[0] && wh_name_ok(w, strlen(w))) {
    char fp[256]; snprintf(fp, sizeof fp, "%s/%s/%s", WH_WIDGETS_DIR, w, WH_SET_FILE);
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
  if (!w[0] || !wh_name_ok(w, strlen(w)) || !body[0] || body[0] != '{') { wh_reply(c, "204 No Content"); return; }
  char fp[256], tp[300];
  snprintf(fp, sizeof fp, "%s/%s/%s", WH_WIDGETS_DIR, w, WH_SET_FILE);
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
static void wh_asset_conn(int c){
  char req[1024]; size_t got = 0;
  while (got < sizeof req - 1){
    ssize_t r = read(c, req + got, sizeof req - 1 - got);
    if (r <= 0) break;
    got += (size_t)r; req[got] = 0;
    if (strstr(req, "\r\n")) break;          /* only the request line matters */
  }
  req[got] = 0;
  char* eol = strstr(req, "\r\n");
  if (!eol) { wh_reply(c, "400 Bad Request"); return; }
  *eol = 0;
  if (strncmp(req, "GET /", 5)) { wh_reply(c, "405 Method Not Allowed"); return; }
  char* path = req + 5;                      /* after "GET /" */
  char* sp = strchr(path, ' '); if (sp) *sp = 0;
  if (!strncmp(path, "__log?", 6)) { wh_log_endpoint(c, path + 6); return; }
  if (!strncmp(path, "__wget?", 7)) { wh_settings_get(c, path + 7); return; }
  if (!strncmp(path, "__wset?", 7)) { wh_settings_set(c, path + 7); return; }
  if (!strncmp(path, "__launch?", 9)) { wh_launch_action(c, path + 9); return; }
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
  wh_send_all(c, h, (size_t)n);
  char buf[8192]; ssize_t r;
  while ((r = read(fd, buf, sizeof buf)) > 0) wh_send_all(c, buf, (size_t)r);
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
  a.sin_family = AF_INET; a.sin_port = htons(WH_ASSET_PORT); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  unsigned my = wh_gen_bump();               /* tells an older server to retire */
  *gen = my;
  int bound = 0;
  for (int t = 0; t < 30 && !bound; t++) {   /* ~6 s for it to notice (it polls 1/s) */
    if (!bind(s, (struct sockaddr*)&a, sizeof a) && !listen(s, 8)) bound = 1;
    else usleep(200000);
  }
  if (!bound) {
    LOG("assets: 127.0.0.1:%d still busy, not serving\n", WH_ASSET_PORT);
    close(s); *why = "port busy"; return -1;
  }
  LOG("assets: serving %s on 127.0.0.1:%d (gen %u)\n", WH_WIDGETS_DIR, WH_ASSET_PORT, my);
  return s;
}
void wh_asset_loop(int s, unsigned my, pid_t shell, const struct wh_bridge* br){
  signal(SIGPIPE, SIG_IGN);
  fflush(stdout); fflush(stderr);
  int dn = open("/dev/null", O_RDWR);        /* detach stdio so the loader connection ends */
  if (dn >= 0) { dup2(dn, 0); dup2(dn, 1); dup2(dn, 2); if (dn > 2) close(dn); }
  struct timeval tv = { 2, 0 };
  /* In-place widget refresh: sample the source fingerprint at ~1 Hz and rebuild
   * the prelude once a change has been identical for WH_STABLE_MS. Sampling is
   * clock-driven, so a served request or the rebuild itself cannot stretch the
   * stability window. SceShellUI keeps running; only the hook slot moves. */
  uint64_t applied = wh_prelude_sig;         /* fingerprint live in SceShellUI */
  uint64_t candidate = wh_prelude_sig;
  uint64_t candidate_since = 0, next_sample = wh_now_ms() + WH_SAMPLE_MS;
  int attempts = 0;
  for (;;) {
    struct pollfd pf = { s, POLLIN, 0 };
    int pr = poll(&pf, 1, 250);
    if (my && wh_gen_read() > my) {          /* a newer install took over */
      klog_printf("[wc] assets: gen %u superseded, retiring\n", my);
      wh_flog("assets", "server gen %u handed over to a newer install, exiting", my);
      close(s); _exit(0);
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
          if (rr == 0) { applied = candidate = wh_prelude_sig; attempts = 0; }
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
    int c = accept(s, 0, 0);
    if (c < 0) { if (errno == EINTR) continue; usleep(100000); continue; }
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    wh_asset_conn(c);
    close(c);
  }
}
