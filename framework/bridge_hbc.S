/* Full bridge HBC: swapped in for the hub at slot-2 evaluateJavaScript on any
 * firmware. The matcher detects the hub by its "widget:customTemplates" needle,
 * so the bridge does not depend on the hub's exact bytes (FW-specific deltas did
 * and silently failed on other firmwares). */
.section .rodata
.align 16
.global bridge_hbc_start
.global bridge_hbc_end
bridge_hbc_start:
.incbin "bridge.hbc"
bridge_hbc_end:
