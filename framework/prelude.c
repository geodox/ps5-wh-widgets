/* Build the prelude from /data/wh-widgets/.
 *
 * Generic loader head + one spliced section per widget folder:
 *   __wh.__begin({id,title,iconId,description,size}); <widget.js verbatim>; __wh.__end();
 * widget.js is compiled as part of the prelude (Hermes release blocks in-JS
 * eval), so a syntax error in one widget breaks the set -- validate offline. */
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include "bridge.h"
#include "prelude.h"
#include "util.h"

extern const char wh_loader[];   /* framework/loader.js, minified (embed.S) */

int wh_wok = 0, wh_wbad = 0, wh_wmore = 0;
char wh_wfail[200] = "";
uint64_t wh_prelude_sig = 0;

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
/* install-time widget summary for the notification */
static void wh_fail_add(const char* name){
  wh_wbad++;
  size_t l = strlen(wh_wfail), n = strlen(name);
  if (l + n + 3 >= sizeof wh_wfail) { wh_wmore++; return; }
  if (l) strcat(wh_wfail, ", ");
  strcat(wh_wfail, name);
}
/* ---- widget source fingerprint ---------------------------------------------
 * Hash only the executable widget inputs: every folder's config.json and
 * widget.js, in sorted order. Images are served live, so a glyph-only edit must
 * not trigger a rebuild. 0 means the drop folder could not be read (or could not
 * be enumerated), which the asset loop treats as "no observation", not a change.
 *
 * The scan mirrors build_prelude(): every non-dot directory under WH_WIDGETS_DIR,
 * with no name-length or folder-count limit, so a change to any widget the
 * prelude loads also moves the fingerprint. */
static uint64_t wh_hash_step(uint64_t h, const void* data, size_t n){
  const uint8_t* p = (const uint8_t*)data;
  while (n--){ h ^= *p++; h *= 0x100000001b3ull; }
  return h;
}
static int wh_cmp_name(const void* a, const void* b){
  return strcmp(*(const char* const*)a, *(const char* const*)b);
}
uint64_t wh_widget_fingerprint(void){
  DIR* d = opendir(WH_WIDGETS_DIR);
  if (!d) return 0;
  char** names = 0; size_t count = 0, cap = 0;
  int oom = 0;
  struct dirent* e;
  while ((e = readdir(d))){
    if (e->d_name[0] == '.') continue;
    char path[600]; struct stat st;
    snprintf(path, sizeof path, "%s/%s", WH_WIDGETS_DIR, e->d_name);
    if (stat(path, &st) || !S_ISDIR(st.st_mode)) continue;
    if (count == cap){
      size_t ncap = cap ? cap * 2 : 32;
      char** grown = (char**)realloc(names, ncap * sizeof *names);
      if (!grown){ oom = 1; break; }
      names = grown; cap = ncap;
    }
    size_t nl = strlen(e->d_name);
    char* copy = (char*)malloc(nl + 1);
    if (!copy){ oom = 1; break; }
    memcpy(copy, e->d_name, nl + 1);
    names[count++] = copy;
  }
  closedir(d);
  if (oom){                                  /* partial list: report "unreadable" */
    for (size_t i = 0; i < count; i++) free(names[i]);
    free(names);
    return 0;
  }
  if (count > 1) qsort(names, count, sizeof *names, wh_cmp_name);
  uint64_t h = 0xcbf29ce484222325ull;
  for (size_t i = 0; i < count; i++){
    h = wh_hash_step(h, names[i], strlen(names[i]) + 1);
    const char* files[] = {"config.json", "widget.js"};
    for (size_t j = 0; j < 2; j++){
      char path[600]; char* buf = 0; size_t len = 0;
      snprintf(path, sizeof path, "%s/%s/%s", WH_WIDGETS_DIR, names[i], files[j]);
      h = wh_hash_step(h, files[j], strlen(files[j]) + 1);
      if (!wh_read_file(path, &buf, &len)){
        h = wh_hash_step(h, &len, sizeof len);
        h = wh_hash_step(h, buf, len);
        free(buf);
      } else {
        const uint8_t missing = 0xff;
        h = wh_hash_step(h, &missing, sizeof missing);
      }
    }
  }
  for (size_t i = 0; i < count; i++) free(names[i]);
  free(names);
  return wh_hash_step(h, &count, sizeof count);
}

void build_prelude(char** outbuf, size_t* outlen, const struct wh_bridge* br){
  size_t cap = 16384, len = 0;
  char* out = (char*)malloc(cap); out[0] = 0;
  wh_prelude_sig = wh_widget_fingerprint();
  /* Hub module ids move between firmware builds (tools/fid_match.js); the loader
   * requires hub modules (stock frame/header, MINI registry) by these ids, keyed
   * by the map's module names. A module the matcher could not resolve is absent. */
  WHAPP("globalThis.__wh_hubmods=");
  WHAPP(br->hubmods);
  WHAPP(";\n");
  WHAPP(wh_loader);
  /* Revision stamp. The hub re-evaluates its bundle every time Explore Hub is
   * entered, so this prelude runs again on each hub load. Same revision -> stop,
   * the widget sections below are already live. New revision -> forget every id
   * this loader registered and let the sections below register afresh. Without
   * it the loader's `__loaded` guard would keep the first eval's widget set. */
  {
    char rev[24]; snprintf(rev, sizeof rev, "%016llx", (unsigned long long)wh_prelude_sig);
    char js[1024]; int n = snprintf(js, sizeof js,
      "\n(function(){var G=globalThis,W=G.__wh,R='%s';if(!W||W.__sourceRevision===R)return;"
      "var o=G.__wh_order||[],k=W.__metaKeys||[],m=W.__meta||{};"
      "for(var i=0;i<o.length;i++){var id=o[i];"
      "try{if(W.__map)delete W.__map[id];}catch(e){}"
      "try{if(W.__editable)delete W.__editable['__wh_'+id];}catch(e){}"
      "for(var j=0;j<k.length;j++){try{if(m[k[j][0]])delete m[k[j][0]][id];}catch(e){}}}"
      "try{if(W.__miniReset)W.__miniReset();}catch(e){}"
      "G.__wh_widgets={};G.__wh_cfgs={};G.__wh_order=[];"
      "W.__sourceRevision=R;W.__loaded=0;W.__regLogged=0;})();\n", rev);
    if (n > 0 && (size_t)n < sizeof js) wh_app(&out, &len, &cap, js, (size_t)n);
  }
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
  wh_wok = count;
  LOG("build_prelude: widgets=%d failed=%d total=%zuB\n", count, wh_wbad, len);
  *outbuf = out; *outlen = len;
}
#undef WHAPP
