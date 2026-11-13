/* Runtime discovery of the hook point: evaluateJavaScript and its JSI vtable
 * slot in libhermes, found by content so no firmware-specific offsets are needed. */
#ifndef WH_HOOKPOINT_H
#define WH_HOOKPOINT_H
#include <stdint.h>
#include <sys/types.h>

/* First bytes of evaluateJavaScript; checked again before hooking. */
extern const uint8_t EXPECTED_PROLOGUE[11];

/* Find evaluateJavaScript (*eval_out) and its vtable slot (*slot_out) in the
 * libhermes image at `base` in `pid`. Returns WH_OK or a WH_RC_SCAN_* code. */
int wh_discover(pid_t pid, uintptr_t base, uintptr_t* eval_out, uintptr_t* slot_out);

#endif
