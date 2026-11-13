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
#include "prelude.h"
#include "util.h"

extern const char wh_loader[];   /* framework/loader.js, minified (embed.S) */

int wh_wok = 0, wh_wbad = 0, wh_wmore = 0;
char wh_wfail[200] = "";

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

void build_prelude(char** outbuf, size_t* outlen){
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
  wh_wok = count;
  LOG("build_prelude: widgets=%d failed=%d total=%zuB\n", count, wh_wbad, len);
  *outbuf = out; *outlen = len;
}
#undef WHAPP
