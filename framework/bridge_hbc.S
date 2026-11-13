/* Bridge delta (tools/make_delta.js): the detour rebuilds the bridge HBC inside
 * ShellUI from the hub's own bytecode, so only this small blob is embedded. */
.section .rodata
.align 16
.global wh_delta_start
.global wh_delta_end
wh_delta_start:
.incbin "bridge.delta"
wh_delta_end:
