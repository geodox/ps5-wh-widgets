/* Access to another process (SceShellUI): find it, ptrace it, read/write its
 * memory and map new memory inside it. */
#ifndef WH_REMOTE_H
#define WH_REMOTE_H
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

/* pid of the process named `comm` (not this one), or -1. */
pid_t find_pid(const char *comm);

/* ptrace with debugger credentials (authid/caps raised for the call only). */
int sys_ptrace(int req, pid_t pid, caddr_t addr, int data);

int remote_read(pid_t pid, uintptr_t a, void *o, size_t l);
int remote_write_d(pid_t pid, uintptr_t a, const void *s, size_t l);   /* needs PT_ATTACH */
int remote_write_chunked(pid_t pid, uintptr_t a, const uint8_t *s, size_t l);

/* Address of a `syscall; ret` gadget in the target (for remote_mmap), or 0. */
uintptr_t gadget_of(pid_t pid);
/* mmap `len` bytes RW (RWX if `exec`) in the attached target; 0 on failure. */
uintptr_t remote_mmap(pid_t pid, uintptr_t g, size_t len, int exec);

#endif
