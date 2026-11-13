/* Combined installer: swap bridge579.hbc in for the hub AND run a probe prelude.
 * Verifies the module-579 bridge exposes WIDGET_MAP to globalThis.__wh_map.
 * One slot-2 detour: runs WH_PRELUDE in each runtime (via the original
 * evaluateJavaScript), then swaps the hub buffer (exact size) for our embedded
 * bridge HBC, then runs it. Prelude writes globalThis.__wh_probe when it sees
 * __wh_map; read with heap_find.py WHBRIDGE. */
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <sys/mman.h>
#include <machine/reg.h>
#include <ps5/kernel.h>
#include <ps5/klog.h>
#include <ps5/mdbg.h>
#include <signal.h>
#include <sys/time.h>
#include <sys/socket.h>
#include <poll.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <time.h>
#include "wh_detour.h"
#include "wh_sigs.h"

/* ---- payload version ---- */
#define WH_VERSION "26.11.12 beta"

/* bridge delta (tools/make_delta.js): the detour rebuilds the bridge from the hub's
 * own bytecode, so the payload never carries the full bridge HBC */
extern const uint8_t wh_delta_start[];
extern const uint8_t wh_delta_end[];

#define WH_WIDGETS_DIR "/data/wh-widgets"
extern const char wh_loader[];   /* framework/loader.js, minified (embed.S) */

/* FW 13.20 reference offsets: used only to label a match in the log; the real
 * addresses are discovered at runtime by signature (see wh_discover). */
#define OFF_EVALUATE_JS  0x0000e890u
#define OFF_VTABLE_SLOT2 0x0026c358u
/* hub is now detected by content (WH_NEEDLE in wh_detour.h), not by exact size */
#define WH_MOD_CAP       0x00800000u   /* hard cap when walking the module image */
static const uint8_t EXPECTED_PROLOGUE[11] =
    {0x55,0x48,0x89,0xe5,0x41,0x56,0x53,0x48,0x83,0xec,0x20};

/* cave layout */
#define CV_DET     0x000
#define CV_PSIZE   0x100
#define CV_PDATA   0x120
#define CV_DTOR    0x140
#define CV_PVT     0x160
#define CV_PBUF    0x1a0
#define CV_PCTRL   0x1c0
#define CV_PSHARED 0x1e0
#define CV_URL     0x200
#define CV_BSIZE   0x220
#define CV_BDATA   0x240
#define CV_BVT     0x260
#define CV_BBUF    0x2a0
#define CV_BCTRL   0x2c0
#define CV_BSHARED 0x2e0
#define CV_CTR     0x300
#define CV_SIG     0x320   /* "WHBRIDGE", bridge len, bridge FNV-1a64, version */
#define CV_NEEDLE  0x340   /* hub signature string ("widget:customTemplates") */
#define CV_MATCH   0x360   /* choose_buffer helper (content-detects the hub) */
#define CV_PRELUDE 0x500   /* spliced loader + widget JS */
#define WH_SIG_VER 1
/* diagnostic dump staging (opt-in via /data/wh-widgets/.wh_dump) */
#define WH_DUMP_FLAG "/data/wh-widgets/.wh_dump"
#define WH_DUMP_CAP  8
#define WH_DUMP_SLOT ((size_t)1 << WH_DUMP_SHIFT)
#define WH_DCAVE_SZ  (WH_DUMP_HDR + (size_t)WH_DUMP_CAP * WH_DUMP_SLOT)

/* ---- log file: /data/wh-widgets/wh.log (rotates to wh.log.1 at 256 KB) ---- */
#define WH_LOG_FILE  "/data/wh-widgets/wh.log"
#define WH_LOG_OLD   "/data/wh-widgets/wh.log.1"
#define WH_LOG_MAX   (256*1024)
static void wh_flog(const char* tag, const char* fmt, ...) {
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
#define LOG(...) do { char _lb[600]; snprintf(_lb, sizeof _lb, __VA_ARGS__); \
  klog_printf("[wc] %s", _lb); printf("[wc] %s", _lb); wh_flog("installer", "%s", _lb); } while (0)
static void put64(uint8_t *b, uint64_t v) { memcpy(b, &v, 8); }
static uint64_t get64(const uint8_t *b) { uint64_t v; memcpy(&v, b, 8); return v; }
static uint64_t fnv1a64(const uint8_t *p, size_t n) {
  uint64_t h = 0xcbf29ce484222325ull;
  while (n--) { h ^= *p++; h *= 0x100000001b3ull; }
  return h;
}

typedef struct notify_request { char u[45]; char message[3075]; } notify_request_t;
int sceKernelSendNotificationRequest(int, notify_request_t*, size_t, int);
static void notify(const char *fmt, ...) {
  notify_request_t req; va_list ap; bzero(&req, sizeof req);
  va_start(ap, fmt); vsnprintf(req.message, sizeof req.message, fmt, ap); va_end(ap);
  sceKernelSendNotificationRequest(0, &req, sizeof req, 0);
}

#define KP_PID_OFF 72
static int scan_needle(const uint8_t *p, int size, const char *n, size_t nl) {
  for (int i = 0; i + (int)nl + 1 <= size; i++)
    if (p[i] == n[0] && !memcmp(p + i, n, nl) && p[i + nl] == '\0') return i;
  return -1;
}
static pid_t find_pid(const char *comm) {
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PROC, 0};
  pid_t me = getpid(), found = -1; size_t sz, nl = strlen(comm); uint8_t *buf;
  if (sysctl(mib, 4, NULL, &sz, NULL, 0)) return -1;
  if (!(buf = malloc(sz))) return -1;
  if (sysctl(mib, 4, buf, &sz, NULL, 0)) { free(buf); return -1; }
  for (uint8_t *p = buf; p < buf + sz; ) {
    int ss = *(int *)p; if (ss <= 0 || p + ss > buf + sz) break;
    pid_t pid = *(pid_t *)(p + KP_PID_OFF);
    if (scan_needle(p, ss, comm, nl) >= 0 && pid != me) found = pid;
    p += ss;
  }
  free(buf); return found;
}
static int sys_ptrace(int req, pid_t pid, caddr_t addr, int data) {
  uint8_t pc[16]; memset(pc, 0xff, sizeof pc);
  pid_t me = getpid(); uint8_t caps[16]; uint64_t authid; int ret;
  if (!(authid = kernel_get_ucred_authid(me))) return -1;
  if (kernel_get_ucred_caps(me, caps)) return -1;
  if (kernel_set_ucred_authid(me, 0x4800000000010003l)) return -1;
  if (kernel_set_ucred_caps(me, pc)) return -1;
  ret = (int)__syscall(SYS_ptrace, req, pid, addr, data);
  kernel_set_ucred_authid(me, authid); kernel_set_ucred_caps(me, caps);
  return ret;
}
static int ptg(pid_t pid, struct reg *r){ return sys_ptrace(PT_GETREGS, pid,(caddr_t)r,0); }
static int pts(pid_t pid, struct reg *r){ return sys_ptrace(PT_SETREGS, pid,(caddr_t)r,0); }
static int remote_read(pid_t pid, uintptr_t a, void *o, size_t l) { return mdbg_copyout(pid, (intptr_t)a, o, l); }
/* ---- runtime discovery of the hook point (no hardcoded offsets) -------------
 * Find evaluateJavaScript and its JSI vtable slot in libhermes by content, so the
 * same payload works across firmwares. Validated on FW 13.20 (matches 0xe890 /
 * 0x26c358). Steps: walk the module's page protections to bound .text and the
 * read-only image; signature-scan .text for evaluateJavaScript / prepareJavaScript
 * / evaluatePreparedJavaScript (each must be unique); locate the vtable by the
 * (prepare, evalPrepared) pointer pair in rodata -> slot 2 = pair - 8 (works even
 * while slot 2 is already hooked, since those two neighbours are never touched). */
static intptr_t wh_find_unique(const uint8_t* buf, size_t n, const uint8_t* pat, const uint8_t* msk, size_t plen){
  intptr_t found = -1;
  if (plen == 0 || n < plen) return -1;
  for (size_t i = 0; i + plen <= n; i++){
    size_t k = 0;
    for (; k < plen; k++) if (msk[k] && buf[i+k] != pat[k]) break;
    if (k == plen){ if (found >= 0) return -2; found = (intptr_t)i; }
  }
  return found;   /* -1 none, -2 ambiguous, else offset */
}
/* unique 16-byte little-endian pair (a,b) within [buf,buf+n): offset, or -1/-2 */
static intptr_t wh_find_pair(const uint8_t* buf, size_t n, uint64_t a, uint64_t b){
  uint8_t pair[16]; memcpy(pair, &a, 8); memcpy(pair+8, &b, 8);
  intptr_t found = -1;
  if (n < 16) return -1;
  for (size_t i = 0; i + 16 <= n; i++){
    if (!memcmp(buf + i, pair, 16)){ if (found >= 0) return -2; found = (intptr_t)i; }
  }
  return found;
}
/* discover eval fn + vtable slot; 0 on success, else an rc code */
static int wh_discover(pid_t pid, uintptr_t base, uintptr_t* eval_out, uintptr_t* slot_out){
  /* bound the module: walk pages while mapped (protection query >= 0). PS5 maps
   * code execute-only (XOM: EXEC set, READ clear) and the kernel still copies it,
   * so bound on the unmapped gap, not the READ bit. text_end = first non-exec page. */
  uintptr_t p = base, text_end = 0;
  while (p - base < WH_MOD_CAP){
    int pr = kernel_get_vmem_protection(pid, p, 1);
    if (pr < 0) break;                             /* unmapped: end of the module image */
    if (!text_end && !(pr & PROT_EXEC)) text_end = p;
    p += 0x1000;
  }
  uintptr_t img_end = p;
  if (!text_end) text_end = img_end;
  size_t imglen = img_end - base, textlen = text_end - base;
  if (imglen < 0x10000 || textlen < 0x1000){ LOG("discover: module too small (img %#zx text %#zx)\n", imglen, textlen); return 40; }
  uint8_t* mod = (uint8_t*)malloc(imglen);
  if (!mod){ LOG("discover: oom %#zx\n", imglen); return 41; }
  for (size_t o = 0; o < imglen; ){ size_t n = imglen - o; if (n > 0x40000) n = 0x40000;
    if (remote_read(pid, base + o, mod + o, n)){ LOG("discover: read fail at +%#zx\n", o); free(mod); return 42; } o += n; }
  LOG("discover: module +0..%#zx text +0..%#zx\n", imglen, textlen);
  /* signature-scan .text */
  intptr_t ev = wh_find_unique(mod, textlen, WH_SIG_EVAL_P, WH_SIG_EVAL_M, sizeof WH_SIG_EVAL_P);
  intptr_t pr_ = wh_find_unique(mod, textlen, WH_SIG_PREPARE_P, WH_SIG_PREPARE_M, sizeof WH_SIG_PREPARE_P);
  intptr_t ep = wh_find_unique(mod, textlen, WH_SIG_EVALPREP_P, WH_SIG_EVALPREP_M, sizeof WH_SIG_EVALPREP_P);
  if (ev < 0 || pr_ < 0 || ep < 0){
    LOG("discover: signature match eval=%ld prepare=%ld evalPrepared=%ld (<0: -1 none, -2 ambiguous)\n",(long)ev,(long)pr_,(long)ep);
    free(mod); return 43;
  }
  uintptr_t evalA = base + ev, prepA = base + pr_, eprepA = base + ep;
  /* vtable slot via the (prepare, evalPrepared) pair in the data region */
  intptr_t pr_off = wh_find_pair(mod + textlen, imglen - textlen, (uint64_t)prepA, (uint64_t)eprepA);
  if (pr_off < 0){ LOG("discover: vtable pair %s\n", pr_off==-2?"ambiguous":"not found"); free(mod); return 44; }
  uintptr_t slot3 = text_end + (uintptr_t)pr_off, slot2 = slot3 - 8;
  free(mod);
  LOG("discover: eval +%#lx prepare +%#lx evalPrepared +%#lx slot2 +%#lx%s\n",
      (long)(evalA-base),(long)(prepA-base),(long)(eprepA-base),(long)(slot2-base),
      (evalA-base==OFF_EVALUATE_JS && slot2-base==OFF_VTABLE_SLOT2) ? " (matches FW 13.20)" : " (non-13.20 layout)");
  *eval_out = evalA; *slot_out = slot2;
  return 0;
}
static int remote_write_d(pid_t pid, uintptr_t a, const void *s, size_t l) {
  struct ptrace_io_desc iod = {0}; iod.piod_op = PIOD_WRITE_D; iod.piod_offs=(void*)a; iod.piod_addr=(void*)s; iod.piod_len=l;
  return sys_ptrace(PT_IO, pid, (caddr_t)&iod, 0);
}
static int remote_write_chunked(pid_t pid, uintptr_t a, const uint8_t *s, size_t l) {
  const size_t CH=0x10000;
  for (size_t o=0;o<l;o+=CH){ size_t n=l-o; if(n>CH)n=CH; if(remote_write_d(pid,a+o,s+o,n)){LOG("chunk @%#zx fail\n",o);return -1;} }
  return 0;
}
#define SYS_mmap 477
static uintptr_t gadget_of(pid_t pid){ intptr_t a=kernel_dynlib_resolve(pid,0x1,"HoLVWNanBBc"); if(!a)a=kernel_dynlib_resolve(pid,0x2001,"HoLVWNanBBc"); return a?(uintptr_t)a+0xa:0; }
static int remote_syscall(pid_t pid, uintptr_t g, uint64_t sn, uint64_t a0,uint64_t a1,uint64_t a2,uint64_t a3,uint64_t a4,uint64_t a5, uint64_t *ret){
  struct reg bak,jmp; if(ptg(pid,&bak))return -1; jmp=bak;
  jmp.r_rax=(int64_t)sn; jmp.r_rdi=a0;jmp.r_rsi=a1;jmp.r_rdx=a2;jmp.r_r10=a3;jmp.r_r8=a4;jmp.r_r9=a5; jmp.r_rip=(int64_t)g;
  if(pts(pid,&jmp))return -1; int rc=-1;
  for(int i=0;i<1000;i++){ if(sys_ptrace(PT_STEP,pid,(caddr_t)1,0))break; if(waitpid(pid,0,0)==-1)break; if(ptg(pid,&jmp))break; if((uint64_t)jmp.r_rsp>(uint64_t)bak.r_rsp){*ret=(uint64_t)jmp.r_rax;rc=0;break;} }
  if(pts(pid,&bak))rc=-1; return rc;
}
static uintptr_t remote_mmap(pid_t pid, uintptr_t g, size_t len, int exec){
  uint64_t ret=0; if(remote_syscall(pid,g,SYS_mmap,0,len,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,(uint64_t)-1,0,&ret))return 0;
  if(ret==(uint64_t)MAP_FAILED||!ret)return 0;
  if(exec&&kernel_mprotect(pid,(intptr_t)ret,len,PROT_READ|PROT_WRITE|PROT_EXEC))return 0;
  return (uintptr_t)ret;
}

/* ---- drop-folder loader: build the prelude from /data/wh-widgets/ ----
 * Generic loader head + one spliced section per widget folder:
 *   __wh.__begin({id,title,iconId,description,size}); <widget.js verbatim>; __wh.__end();
 * widget.js is compiled as part of the prelude (Hermes release blocks in-JS
 * eval), so a syntax error in one widget breaks the set -- validate offline. */
static int wh_read_file(const char* path, char** buf, size_t* len){
  int fd = open(path, O_RDONLY);
  if (fd < 0) return -1;
  struct stat st;
  if (fstat(fd, &st) || st.st_size <= 0) { close(fd); return -1; }
  size_t n = (size_t)st.st_size;
  char* b = (char*)malloc(n + 1);
  if (!b) { close(fd); return -1; }
  size_t got = 0; ssize_t r;
  while (got < n && (r = read(fd, b + got, n - got)) > 0) got += (size_t)r;
  close(fd);
  b[got] = 0; *buf = b; *len = got; return 0;
}
static int wh_json_str(const char* j, const char* key, char* out, size_t cap){
  char pat[80]; snprintf(pat, sizeof pat, "\"%s\"", key);
  const char* p = strstr(j, pat); if (!p) return -1;
  p += strlen(pat);
  while (*p && *p != ':') p++;
  if (*p != ':') return -1; p++;
  while (*p==' '||*p=='\t'||*p=='\n'||*p=='\r') p++;
  if (*p != '"') return -1; p++;
  size_t i = 0;
  while (*p && *p != '"' && i < cap-1) { if (*p=='\\' && p[1]) p++; out[i++] = *p++; }
  out[i] = 0; return 0;
}
static double wh_json_num(const char* j, const char* key, double def){
  char pat[80]; snprintf(pat, sizeof pat, "\"%s\"", key);
  const char* p = strstr(j, pat); if (!p) return def;
  p += strlen(pat);
  while (*p && *p != ':') p++;
  if (*p != ':') return def; p++;
  return strtod(p, 0);
}
static void wh_app(char** buf, size_t* len, size_t* cap, const char* s, size_t n){
  if (*len + n + 1 > *cap) { while (*len + n + 1 > *cap) *cap *= 2; *buf = (char*)realloc(*buf, *cap); }
  memcpy(*buf + *len, s, n); *len += n; (*buf)[*len] = 0;
}
#define WHAPP(s) wh_app(&out,&len,&cap,(s),strlen(s))
static void wh_app_esc(char** buf, size_t* len, size_t* cap, const char* s){
  for (; *s; s++){ char c=*s; if (c=='\''||c=='\\'){ char e[2]={'\\',c}; wh_app(buf,len,cap,e,2); } else if (c=='\n'||c=='\r'){ } else wh_app(buf,len,cap,&c,1); }
}
/* ---- widget asset server ------------------------------------------------
 * The hub's Image component only loads http:// (data:/file: URIs fail), so the
 * installer stays resident and serves widget images to ShellUI over loopback.
 * Deliberately minimal and locked down:
 *   - binds 127.0.0.1 only (unreachable from the LAN); one request at a time
 *   - GET only; request line capped at 1 KB; 2 s read/write timeouts
 *   - path must be exactly /<dir>/<file>, each [A-Za-z0-9._-]{1,64}, no leading
 *     '.', no ".."; served from WH_WIDGETS_DIR only, O_NOFOLLOW, regular files
 *   - image types only (.png .jpg .jpeg), <= 1 MB; no listings, no other methods */
#define WH_ASSET_PORT 8098
#define WH_ASSET_MAX  (1024*1024)
#define WH_ASSET_URL  "http://127.0.0.1:8098/"
#define WH_GEN_FILE   WH_WIDGETS_DIR "/.wh_gen"
static int wh_name_ok(const char* s, size_t n){
  if (!n || n > 64 || s[0] == '.') return 0;
  for (size_t i = 0; i < n; i++){
    char c = s[i];
    if (!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='.'||c=='_'||c=='-')) return 0;
    if (c == '.' && i+1 < n && s[i+1] == '.') return 0;
  }
  return 1;
}
static const char* wh_img_type(const char* f){
  const char* e = strrchr(f, '.');
  if (!e) return 0;
  if (!strcmp(e,".png")) return "image/png";
  if (!strcmp(e,".jpg") || !strcmp(e,".jpeg")) return "image/jpeg";
  return 0;
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
/* GET /__log?w=<widget>&m=<msg> from the hub loader -> one line in wh.log.
 * Append-only, 400-char cap, control chars stripped, <=120 lines/minute. */
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
static unsigned wh_gen_read(void){
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
/* Bind the asset port. Returns the listening socket, or -1 with *why set. */
static int wh_asset_open(unsigned* gen, const char** why){
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
static int wh_install_once(pid_t pid, size_t dlen, size_t blen, uint64_t bhash, int* reload_out);
/* Install into a freshly respawned SceShellUI: wait for libhermes, then run the
 * install (retrying only transient allocation/write failures). Returns rc, or -1
 * if a newer resident install took over while we waited. */
static int wh_rehook(pid_t np, unsigned my, size_t dlen, size_t blen, uint64_t bhash){
  uint32_t h = 0; int ready = 0;
  for (int t = 0; t < 150; t++) {            /* up to ~15 s for libhermes to map */
    if (my && wh_gen_read() > my) return -1;
    if (!kernel_dynlib_handle(np, "libhermes-0.11.sprx", &h)) { ready = 1; break; }
    usleep(100000);
  }
  if (!ready) return 10;
  int rc = 0, reload = 0;
  for (int a = 0; a < 5; a++) {
    if (my && wh_gen_read() > my) return -1;
    rc = wh_install_once(np, dlen, blen, bhash, &reload);
    if (!(rc >= 20 && rc <= 26)) break;      /* retry only allocation/write hiccups */
    usleep(300000);
  }
  return rc;
}
/* Serve until a newer install bumps the generation; never returns. Also watches
 * SceShellUI: if it respawns (losing our hook), reinstall before the next focus. */
static void wh_asset_loop(int s, unsigned my, pid_t shell, size_t dlen, size_t blen, uint64_t bhash){
  signal(SIGPIPE, SIG_IGN);
  fflush(stdout); fflush(stderr);
  int dn = open("/dev/null", O_RDWR);        /* detach stdio so the loader connection ends */
  if (dn >= 0) { dup2(dn, 0); dup2(dn, 1); dup2(dn, 2); if (dn > 2) close(dn); }
  struct timeval tv = { 2, 0 };
  for (;;) {
    struct pollfd pf = { s, POLLIN, 0 };
    int pr = poll(&pf, 1, 250);
    if (my && wh_gen_read() > my) {          /* a newer install took over */
      klog_printf("[wc] assets: gen %u superseded, retiring\n", my);
      wh_flog("assets", "server gen %u handed over to a newer install, exiting", my);
      close(s); _exit(0);
    }
    pid_t np = find_pid("SceShellUI");
    if (np > 0 && np != shell) {             /* ShellUI respawned: our hook is gone with it */
      wh_flog("installer", "SceShellUI pid %d -> %d, reinstalling", (int)shell, (int)np);
      int rr = wh_rehook(np, my, dlen, blen, bhash);
      if (rr < 0) { wh_flog("assets", "server gen %u handed over to a newer install, exiting", my); close(s); _exit(0); }
      shell = np;
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
/* install-time widget summary for the notification */
static int g_wok = 0, g_wbad = 0, g_wmore = 0;
static char g_wfail[200] = "";
static void wh_fail_add(const char* name){
  g_wbad++;
  size_t l = strlen(g_wfail), n = strlen(name);
  if (l + n + 3 >= sizeof g_wfail) { g_wmore++; return; }
  if (l) strcat(g_wfail, ", ");
  strcat(g_wfail, name);
}
static void build_prelude(char** outbuf, size_t* outlen){
  size_t cap = 16384, len = 0;
  char* out = (char*)malloc(cap); out[0] = 0;
  WHAPP(wh_loader);
  int count = 0;
  DIR* d = opendir(WH_WIDGETS_DIR);
  if (d){
    struct dirent* e;
    while ((e = readdir(d))){
      if (e->d_name[0] == '.') continue;
      char cpath[600], wpath[600];
      snprintf(cpath, sizeof cpath, "%s/%s/config.json", WH_WIDGETS_DIR, e->d_name);
      snprintf(wpath, sizeof wpath, "%s/%s/widget.js", WH_WIDGETS_DIR, e->d_name);
      char* cfg=0; size_t cl=0;
      if (wh_read_file(cpath,&cfg,&cl)) {
        /* Only a folder that looks like a widget (has widget.js) is worth a
         * message; plain files (wh.log) and unrelated folders are ignored. */
        struct stat ws;
        if (!stat(wpath, &ws)) {
          LOG("skip %s: config.json missing or empty\n", e->d_name); wh_fail_add(e->d_name);
        }
        continue;
      }
      char* js=0; size_t jl=0;
      if (wh_read_file(wpath,&js,&jl)) { LOG("skip %s: widget.js missing or empty\n", e->d_name); wh_fail_add(e->d_name); free(cfg); continue; }
      if (!strchr(cfg, '{')) { LOG("skip %s: config.json is not a JSON object\n", e->d_name); wh_fail_add(e->d_name); free(cfg); free(js); continue; }
      char id[128]={0}, title[160]={0}, iconId[64]={0}, desc[400]={0};
      if (wh_json_str(cfg,"id",id,sizeof id)) { strncpy(id, e->d_name, sizeof id-1); LOG("%s: no \"id\" in config.json, using folder name\n", e->d_name); }
      if (wh_json_str(cfg,"title",title,sizeof title)) strncpy(title, id, sizeof title-1);
      /* "glyph": white PNG in the widget folder, served by the asset server and
       * registered as IconPS id "wh:<id>" (the default iconId when one is given) */
      char glyph[80]={0};
      int dir_ok = wh_name_ok(e->d_name, strlen(e->d_name));
      if (!wh_json_str(cfg,"glyph",glyph,sizeof glyph)) {
        if (!dir_ok) { LOG("%s: folder name not servable ([A-Za-z0-9._-]), glyph ignored\n", id); glyph[0]=0; }
        else if (!wh_name_ok(glyph,strlen(glyph)) || !wh_img_type(glyph)) { LOG("%s: glyph \"%s\" ignored (must be a .png/.jpg file name)\n", id, glyph); glyph[0]=0; }
        else { struct stat gs; char gp[600]; snprintf(gp, sizeof gp, "%s/%s/%s", WH_WIDGETS_DIR, e->d_name, glyph);
               if (stat(gp, &gs)) LOG("%s: glyph file %s not found (stock fallback will show)\n", id, glyph); }
      } else glyph[0]=0;
      if (wh_json_str(cfg,"iconId",iconId,sizeof iconId)) {
        if (glyph[0]) snprintf(iconId, sizeof iconId, "wh:%s", id);
        else strncpy(iconId, "app_welcome", sizeof iconId-1);
      }
      wh_json_str(cfg,"description",desc,sizeof desc);   /* optional; stays "" */
      char iconFb[64]={0};                                 /* stock id if wh: glyphs unavailable */
      wh_json_str(cfg,"iconFallback",iconFb,sizeof iconFb);
      double sz = wh_json_num(cfg,"size",1);
      char num[48]; snprintf(num, sizeof num, "',size:%g},'", sz);
      WHAPP("\nif(globalThis.__wh&&!globalThis.__wh.__loaded){globalThis.__wh.__begin({id:'");
      wh_app_esc(&out,&len,&cap, id);
      WHAPP("',title:'");
      wh_app_esc(&out,&len,&cap, title);
      WHAPP("',iconId:'");
      wh_app_esc(&out,&len,&cap, iconId);
      WHAPP("',description:'");
      wh_app_esc(&out,&len,&cap, desc);
      WHAPP("',iconFallback:'");
      wh_app_esc(&out,&len,&cap, iconFb);
      if (dir_ok) {                          /* base URL for this widget's images */
        WHAPP("',assetBase:'" WH_ASSET_URL);
        wh_app_esc(&out,&len,&cap, e->d_name);
        WHAPP("/");
      }
      if (glyph[0]) { WHAPP("',glyph:'"); wh_app_esc(&out,&len,&cap, glyph); }
      WHAPP(num);
      wh_app_esc(&out,&len,&cap, cfg);       /* raw config.json; parsed by the loader */
      WHAPP("');\n");
      WHAPP("try{\n");
      wh_app(&out,&len,&cap, js, jl);
      WHAPP("\n}catch(e){globalThis.__wh.__fail(e);}\nglobalThis.__wh.__end();}\n");
      free(cfg); free(js); count++;
      LOG("widget: id=%s size=%g js=%zuB\n", id, sz, jl);
    }
    closedir(d);
  } else {
    LOG("build_prelude: opendir(%s) failed\n", WH_WIDGETS_DIR);
  }
  /* mark loaded only after every section ran, so all widgets load in the
   * first eval where the handle exists, and never re-run on later evals */
  WHAPP("\nif(globalThis.__wh){globalThis.__wh.__loaded=1;globalThis.__wh.__flush();}\n");
  g_wok = count;
  LOG("build_prelude: widgets=%d failed=%d total=%zuB\n", count, g_wbad, len);
  *outbuf = out; *outlen = len;
}
#undef WHAPP

/* One full install into SceShellUI `pid`. Returns rc (0 = installed). Called at
 * startup and again by the resident server whenever ShellUI respawns. */
static int wh_install_once(pid_t pid, size_t dlen, size_t blen, uint64_t bhash, int* reload_out){
  g_wok = 0; g_wbad = 0; g_wmore = 0; g_wfail[0] = 0;
  *reload_out = 0;
  char* prelude = 0; size_t plen = 0;
  build_prelude(&prelude, &plen);
  if (!prelude || !plen) { free(prelude); return 30; }
  size_t imgcap = CV_PRELUDE + plen + 1;
  size_t cavesz = (imgcap + 0xfff) & ~((size_t)0xfff);
  uint8_t* img = (uint8_t*)calloc(1, imgcap);
  uint8_t* back = (uint8_t*)malloc(imgcap);
  if (!img || !back) { free(img); free(back); free(prelude); return 31; }
  LOG("prelude %zuB cave %zuB\n", plen, cavesz);
  LOG("pid=%d\n", pid);
  if (sys_ptrace(PT_ATTACH, pid, 0, 0)) { free(img); free(back); free(prelude); return 2; }
  if (waitpid(pid, 0, 0) == -1) { sys_ptrace(PT_DETACH,pid,0,0); free(img); free(back); free(prelude); return 3; }
  LOG("attached\n");
  int rc = 0, reload = 0; uint32_t handle = 0; uintptr_t base = 0, scave = 0, hcave = 0, counter = 0, old_h = 0, fn2 = 0, vslot = 0, dcave = 0, xcave = 0;
  int want_dump = (access(WH_DUMP_FLAG, F_OK) == 0);   /* opt-in HBC dump diagnostics */
  if (want_dump) LOG("dump mode ON (%s present): large non-hub bundles will be staged\n", WH_DUMP_FLAG);
  if (kernel_dynlib_handle(pid, "libhermes-0.11.sprx", &handle)) rc = 10;
  else if (!(base = kernel_dynlib_mapbase_addr(pid, handle))) rc = 11;
  else {
    uint64_t slotv=0; uint8_t pro[11]={0};
    int drc = wh_discover(pid, base, &fn2, &vslot);
    if (drc) rc = (drc == 43 || drc == 44) ? 13 : drc;   /* 43/44 = can't find hook point (unsupported FW) */
    else if (remote_read(pid,vslot,&slotv,8)||remote_read(pid,fn2,pro,11)) rc=12;
    else if (memcmp(pro,EXPECTED_PROLOGUE,11)) rc=13;
    if (rc==0 && slotv != fn2) {
      /* Already hooked. Replace it only if the slot points at OUR cave: our detour
       * prologue (first 8 bytes, stable across detour versions) + the "WHBRIDGE"
       * signature at the fixed offset CV_SIG. This recognises our own earlier
       * builds even when the detour's internal layout changed. Anything else: refuse. */
      uint8_t oc[CV_PRELUDE];
      if (remote_read(pid,(uintptr_t)slotv,oc,sizeof oc)) rc=15;
      else if (memcmp(oc+CV_DET, WH_C_DET, 8) || memcmp(oc+CV_SIG, "WHBRIDGE", 8)) rc=15;
      else {
        reload = 1;
        if (get64(oc+CV_SIG+8) == blen && get64(oc+CV_SIG+16) == bhash)
          old_h = get64(oc+CV_BDATA+WH_C_DAIMM);   /* identical bridge already in ShellUI */
        LOG("reload: replacing our hook at %#lx (bridge %s)\n", (long)slotv, old_h ? "reused" : "re-uploaded");
      }
    }
    if (rc==0) {
      uintptr_t g = gadget_of(pid);
      size_t hpg = (blen + 0xfff) & ~((size_t)0xfff);
      if (!g) rc=20;
      else if (!(scave = remote_mmap(pid,g,cavesz,1))) rc=21;
      else if (old_h) hcave = old_h;
      else if (!(hcave = remote_mmap(pid,g,hpg,0))) rc=22;   /* bridge is rebuilt here on hub load */
      if (rc==0) {
        /* delta blob, with the bridge buffer address filled in; "built" starts at 0 so the
         * next hub load rebuilds (identical bytes when an old buffer is reused) */
        size_t xpg = (dlen + 0xfff) & ~((size_t)0xfff);
        uint8_t* xb = (uint8_t*)malloc(dlen);
        if (!xb) rc=23;
        else if (!(xcave = remote_mmap(pid,g,xpg,0))) rc=23;
        else {
          memcpy(xb, wh_delta_start, dlen);
          put64(xb+8, hcave); put64(xb+24, 0); put64(xb+64, 0);
          if (remote_write_chunked(pid,xcave,xb,dlen)) rc=24;
        }
        free(xb);
      }
      if (rc==0 && want_dump) {
        /* 64 MB staging in ShellUI + a header whctl scans for ("WHDUMPH") */
        dcave = remote_mmap(pid, g, WH_DCAVE_SZ, 0);
        if (!dcave) LOG("dump: staging mmap failed (continuing without dump)\n");
        else {
          uint8_t hdr[0x40]; memset(hdr,0,sizeof hdr);
          memcpy(hdr,"WHDUMPH",8); put64(hdr+8,(uint64_t)WH_DUMP_CAP); put64(hdr+16,0);
          if (remote_write_d(pid,dcave,hdr,sizeof hdr)) { LOG("dump: header write failed\n"); dcave=0; }
          else LOG("dump: staging %zuMB @ %#lx (cap %d)\n", WH_DCAVE_SZ>>20, (long)dcave, WH_DUMP_CAP);
        }
      }
      if (rc==0) {
        uintptr_t S = scave; counter = S + CV_CTR;
        /* img: heap-allocated in main */
        memcpy(img+CV_DET, WH_C_DET, sizeof WH_C_DET);
        put64(img+CV_DET+WH_C_SHARED, S+CV_PSHARED);
        put64(img+CV_DET+WH_C_URL,    S+CV_URL);
        put64(img+CV_DET+WH_C_ORIG_A, fn2);
        put64(img+CV_DET+WH_C_ORIG_B, fn2);
        put64(img+CV_DET+WH_C_BRIDGE, S+CV_BSHARED);
        put64(img+CV_DET+WH_C_MATCHFN, S+CV_MATCH);
        /* choose_buffer helper + the hub signature it scans for (content detection) */
        memcpy(img+CV_MATCH, WH_C_MATCH, sizeof WH_C_MATCH);
        put64(img+CV_MATCH+WH_M_NEEDLE, S+CV_NEEDLE);
        put64(img+CV_MATCH+WH_M_DUMPHDR, dcave);   /* 0 => dump disabled (block skipped) */
        put64(img+CV_MATCH+WH_M_DELTA, xcave);     /* hub found -> verify + rebuild bridge */
        memcpy(img+CV_NEEDLE, WH_NEEDLE, WH_NEEDLE_LEN);
        put64(img+CV_DET+WH_C_CTR_A,  S+CV_CTR);
        put64(img+CV_DET+WH_C_CTR_B,  S+CV_CTR);
        put64(img+CV_DET+WH_C_CTR_C,  S+CV_CTR);
        put64(img+CV_DET+WH_C_CTR_D,  S+CV_CTR);
        memcpy(img+CV_PSIZE, WH_C_SIZE, sizeof WH_C_SIZE); put64(img+CV_PSIZE+WH_C_SZIMM, (uint64_t)plen);
        memcpy(img+CV_PDATA, WH_C_DATA, sizeof WH_C_DATA); put64(img+CV_PDATA+WH_C_DAIMM, S+CV_PRELUDE);
        memcpy(img+CV_DTOR,  WH_C_DTOR, sizeof WH_C_DTOR);
        put64(img+CV_PVT+0, S+CV_DTOR); put64(img+CV_PVT+8, S+CV_DTOR); put64(img+CV_PVT+16, S+CV_PSIZE); put64(img+CV_PVT+24, S+CV_PDATA);
        put64(img+CV_PBUF, S+CV_PVT);
        put64(img+CV_PCTRL+0,0); put64(img+CV_PCTRL+8,0x40000000); put64(img+CV_PCTRL+16,0x40000000);
        put64(img+CV_PSHARED+0, S+CV_PBUF); put64(img+CV_PSHARED+8, S+CV_PCTRL);
        img[CV_URL]=(uint8_t)(2u<<1); img[CV_URL+1]='w'; img[CV_URL+2]='h';
        memcpy(img+CV_BSIZE, WH_C_SIZE, sizeof WH_C_SIZE); put64(img+CV_BSIZE+WH_C_SZIMM, (uint64_t)blen);
        memcpy(img+CV_BDATA, WH_C_DATA, sizeof WH_C_DATA); put64(img+CV_BDATA+WH_C_DAIMM, hcave);
        put64(img+CV_BVT+0, S+CV_DTOR); put64(img+CV_BVT+8, S+CV_DTOR); put64(img+CV_BVT+16, S+CV_BSIZE); put64(img+CV_BVT+24, S+CV_BDATA);
        put64(img+CV_BBUF, S+CV_BVT);
        put64(img+CV_BCTRL+0,0); put64(img+CV_BCTRL+8,0x40000000); put64(img+CV_BCTRL+16,0x40000000);
        put64(img+CV_BSHARED+0, S+CV_BBUF); put64(img+CV_BSHARED+8, S+CV_BCTRL);
        memcpy(img+CV_SIG, "WHBRIDGE", 8); put64(img+CV_SIG+8, (uint64_t)blen);
        put64(img+CV_SIG+16, bhash); put64(img+CV_SIG+24, WH_SIG_VER);
        memcpy(img+CV_PRELUDE, prelude, plen+1);
        size_t imglen = CV_PRELUDE + plen + 1;
        if (remote_write_d(pid, scave, img, imglen)) rc=25;
        else {
          /* back: heap-allocated in main */
          if (remote_read(pid,scave,back,imglen)||memcmp(back,img,imglen)) rc=26;
          else {
            int prot = kernel_get_vmem_protection(pid,vslot,8);
            kernel_set_vmem_protection(pid,vslot,8,prot|PROT_READ|PROT_WRITE);
            uint64_t ns = S+CV_DET;
            if (remote_write_d(pid,vslot,&ns,8)) rc=27;
            else { uint64_t c=0; remote_read(pid,vslot,&c,8); if(c!=ns) rc=28; else LOG("INSTALLED slot2->%#lx bridge %zuB @ %#lx (delta @ %#lx)%s\n",(long)ns,blen,(long)hcave,(long)xcave,reload ? (old_h ? " (reload, bridge reused)" : " (reload)") : ""); }
            if (prot>=0) kernel_set_vmem_protection(pid,vslot,8,prot);
          }
        }
      }
    }
  }
  LOG("ADDRS base=%#lx scave=%#lx hcave=%#lx counter=%#lx vslot2=%#lx\n",
      (long)base,(long)scave,(long)hcave,(long)counter,(long)vslot);
  if (sys_ptrace(PT_DETACH,pid,0,0)) LOG("detach failed\n"); else LOG("detached\n");
  LOG("done rc=%d\n", rc);
  if (rc) {
    const char* why = rc==10 ? "libhermes not loaded in ShellUI" : rc==11 ? "libhermes base not found"
      : rc==12 ? "could not read ShellUI memory" : rc==13 ? "could not locate evaluateJavaScript (unsupported firmware?)"
      : rc==15 ? "evaluateJavaScript is hooked by something else; left untouched"
      : rc>=40 && rc<=42 ? "could not scan libhermes to find the hook point"
      : rc>=20 && rc<=24 ? "could not allocate/write memory in ShellUI" : rc>=25 && rc<=26 ? "code cave write/verify failed"
      : rc>=27 ? "could not update the hook pointer" : "unknown";
    LOG("install failed (rc=%d): %s\n", rc, why);
  }
  free(img); free(back); free(prelude);
  *reload_out = reload;
  return rc;
}

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
  if (rc == 30) { notify("WHBridge failed: widget code"); return 1; }
  if (rc == 31) { notify("WHBridge failed: out of memory"); return 1; }
  if (rc == 2 || rc == 3) { notify("WHBridge failed: attach"); return rc; }
  /* Stay resident as the widget asset server (the hub's Image only loads http://). */
  unsigned gen = 0; const char* why = "";
  int as = wh_asset_open(&gen, &why);
  const char* hook = rc == 0 ? (reload ? "WHBridge reloaded" : "WHBridge loaded")
                  : rc == 15 ? "WHBridge failed: hook owned by something else" : "WHBridge failed";
  int plain = (rc == 0 || rc == 15);         /* message already says it all */
  char wsum[300] = "";
  if (rc == 0) {
    if (g_wbad) snprintf(wsum, sizeof wsum, "\nWidgets: %d loaded, %d failed (%s%s)", g_wok, g_wbad, g_wfail, g_wmore ? ", ..." : "");
    else snprintf(wsum, sizeof wsum, "\nWidgets: %d loaded", g_wok);
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
