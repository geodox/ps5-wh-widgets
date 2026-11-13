/* One install into SceShellUI: attach, build the cave image, map it in the
 * target, write and verify it, then point the JSI vtable slot at the detour. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <ps5/kernel.h>
#include "install.h"
#include "cave.h"
#include "hookpoint.h"
#include "prelude.h"
#include "remote.h"
#include "server.h"
#include "util.h"
#include "wh_detour.h"

/* bridge delta (tools/make_delta.js): the detour rebuilds the bridge from the
 * hub's own bytecode, so the payload never carries the full bridge HBC */
extern const uint8_t wh_delta_start[];

int wh_install_once(pid_t pid, size_t dlen, size_t blen, uint64_t bhash, int* reload_out){
  wh_wok = 0; wh_wbad = 0; wh_wmore = 0; wh_wfail[0] = 0;
  *reload_out = 0;
  char* prelude = 0; size_t plen = 0;
  build_prelude(&prelude, &plen);
  if (!prelude || !plen) { free(prelude); return WH_RC_PRELUDE; }
  size_t imgcap = CV_PRELUDE + plen + 1;
  size_t cavesz = (imgcap + 0xfff) & ~((size_t)0xfff);
  uint8_t* img = (uint8_t*)calloc(1, imgcap);
  uint8_t* back = (uint8_t*)malloc(imgcap);
  if (!img || !back) { free(img); free(back); free(prelude); return WH_RC_NOMEM; }
  LOG("prelude %zuB cave %zuB\n", plen, cavesz);
  LOG("pid=%d\n", pid);
  if (sys_ptrace(PT_ATTACH, pid, 0, 0)) { free(img); free(back); free(prelude); return WH_RC_ATTACH; }
  if (waitpid(pid, 0, 0) == -1) { sys_ptrace(PT_DETACH,pid,0,0); free(img); free(back); free(prelude); return WH_RC_ATTACH_WAIT; }
  LOG("attached\n");
  int rc = 0, reload = 0; uint32_t handle = 0; uintptr_t base = 0, scave = 0, hcave = 0, counter = 0, old_h = 0, fn2 = 0, vslot = 0, xcave = 0;
  if (kernel_dynlib_handle(pid, "libhermes-0.11.sprx", &handle)) rc = WH_RC_NO_HERMES;
  else if (!(base = kernel_dynlib_mapbase_addr(pid, handle))) rc = WH_RC_NO_BASE;
  else {
    uint64_t slotv=0; uint8_t pro[11]={0};
    int drc = wh_discover(pid, base, &fn2, &vslot);
    if (drc) rc = (drc == WH_RC_SCAN_SIG || drc == WH_RC_SCAN_VTABLE) ? WH_RC_NO_HOOKPOINT : drc;   /* can't find hook point (unsupported FW) */
    else if (remote_read(pid,vslot,&slotv,8)||remote_read(pid,fn2,pro,11)) rc = WH_RC_READ;
    else if (memcmp(pro,EXPECTED_PROLOGUE,11)) rc = WH_RC_NO_HOOKPOINT;
    if (rc==0 && slotv != fn2) {
      /* Already hooked. Replace it only if the slot points at OUR cave: our detour
       * prologue (first 8 bytes, stable across detour versions) + the "WHBRIDGE"
       * signature at the fixed offset CV_SIG. This recognises our own earlier
       * builds even when the detour's internal layout changed. Anything else: refuse. */
      uint8_t oc[CV_PRELUDE];
      if (remote_read(pid,(uintptr_t)slotv,oc,sizeof oc)) rc=WH_RC_FOREIGN_HOOK;
      else if (memcmp(oc+CV_DET, WH_C_DET, 8) || memcmp(oc+CV_SIG, "WHBRIDGE", 8)) rc=WH_RC_FOREIGN_HOOK;
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
      if (!g) rc=WH_RC_NO_GADGET;
      else if (!(scave = remote_mmap(pid,g,cavesz,1))) rc=WH_RC_CAVE_MMAP;
      else if (old_h) hcave = old_h;
      else if (!(hcave = remote_mmap(pid,g,hpg,0))) rc=WH_RC_BRIDGE_MMAP;   /* bridge is rebuilt here on hub load */
      if (rc==0) {
        /* delta blob, with the bridge buffer address filled in; "built" starts at 0 so the
         * next hub load rebuilds (identical bytes when an old buffer is reused) */
        size_t xpg = (dlen + 0xfff) & ~((size_t)0xfff);
        uint8_t* xb = (uint8_t*)malloc(dlen);
        if (!xb) rc=WH_RC_DELTA_MMAP;
        else if (!(xcave = remote_mmap(pid,g,xpg,0))) rc=WH_RC_DELTA_MMAP;
        else {
          memcpy(xb, wh_delta_start, dlen);
          put64(xb+8, hcave); put64(xb+24, 0); put64(xb+64, 0);
          if (remote_write_chunked(pid,xcave,xb,dlen)) rc=WH_RC_DELTA_WRITE;
        }
        free(xb);
      }
      if (rc==0) {
        uintptr_t S = scave; counter = S + CV_CTR;
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
        if (remote_write_d(pid, scave, img, imglen)) rc=WH_RC_CAVE_WRITE;
        else {
          if (remote_read(pid,scave,back,imglen)||memcmp(back,img,imglen)) rc=WH_RC_CAVE_VERIFY;
          else {
            int prot = kernel_get_vmem_protection(pid,vslot,8);
            kernel_set_vmem_protection(pid,vslot,8,prot|PROT_READ|PROT_WRITE);
            uint64_t ns = S+CV_DET;
            if (remote_write_d(pid,vslot,&ns,8)) rc=WH_RC_SLOT_WRITE;
            else { uint64_t c=0; remote_read(pid,vslot,&c,8); if(c!=ns) rc=WH_RC_SLOT_VERIFY; else LOG("INSTALLED slot2->%#lx bridge %zuB @ %#lx (delta @ %#lx)%s\n",(long)ns,blen,(long)hcave,(long)xcave,reload ? (old_h ? " (reload, bridge reused)" : " (reload)") : ""); }
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
    const char* why = rc==WH_RC_NO_HERMES ? "libhermes not loaded in ShellUI" : rc==WH_RC_NO_BASE ? "libhermes base not found"
      : rc==WH_RC_READ ? "could not read ShellUI memory" : rc==WH_RC_NO_HOOKPOINT ? "could not locate evaluateJavaScript (unsupported firmware?)"
      : rc==WH_RC_FOREIGN_HOOK ? "evaluateJavaScript is hooked by something else; left untouched"
      : rc>=WH_RC_SCAN_SMALL && rc<=WH_RC_SCAN_READ ? "could not scan libhermes to find the hook point"
      : rc>=WH_RC_NO_GADGET && rc<=WH_RC_DELTA_WRITE ? "could not allocate/write memory in ShellUI" : rc>=WH_RC_CAVE_WRITE && rc<=WH_RC_CAVE_VERIFY ? "code cave write/verify failed"
      : rc>=WH_RC_SLOT_WRITE ? "could not update the hook pointer" : "unknown";
    LOG("install failed (rc=%d): %s\n", rc, why);
  }
  free(img); free(back); free(prelude);
  *reload_out = reload;
  return rc;
}

int wh_rehook(pid_t np, unsigned my, size_t dlen, size_t blen, uint64_t bhash){
  uint32_t h = 0; int ready = 0;
  for (int t = 0; t < 150; t++) {            /* up to ~15 s for libhermes to map */
    if (my && wh_gen_read() > my) return -1;
    if (!kernel_dynlib_handle(np, "libhermes-0.11.sprx", &h)) { ready = 1; break; }
    usleep(100000);
  }
  if (!ready) return WH_RC_NO_HERMES;
  int rc = 0, reload = 0;
  for (int a = 0; a < 5; a++) {
    if (my && wh_gen_read() > my) return -1;
    rc = wh_install_once(np, dlen, blen, bhash, &reload);
    if (!(rc >= WH_RC_NO_GADGET && rc <= WH_RC_CAVE_VERIFY)) break;   /* retry only allocation/write hiccups */
    usleep(300000);
  }
  return rc;
}
