/* Recovery: SIGKILL SceShellUI so the launch daemon respawns it fresh.
 * Keeps the jailbreak (kernel stays exploited). Elevates ucred for permission. */
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <ps5/kernel.h>
#include <ps5/klog.h>
#include "remote.h"

#define OUT(...) do { klog_printf("[whk] " __VA_ARGS__); printf("[whk] " __VA_ARGS__); } while (0)

int main(void) {
  pid_t pid = find_pid("SceShellUI");
  OUT("SceShellUI pid=%d\n", pid);
  if (pid < 0) { OUT("not found\n"); return 1; }
  pid_t me = getpid();
  uint8_t caps[16], priv[16]; memset(priv, 0xff, sizeof priv);
  uint64_t authid = kernel_get_ucred_authid(me);
  kernel_get_ucred_caps(me, caps);
  kernel_set_ucred_authid(me, 0x4800000000010003l);
  kernel_set_ucred_caps(me, priv);
  int r = kill(pid, SIGKILL);
  int e = errno;
  kernel_set_ucred_authid(me, authid);
  kernel_set_ucred_caps(me, caps);
  OUT("kill(%d, SIGKILL) = %d (errno=%d)\n", pid, r, e);
  return 0;
}
