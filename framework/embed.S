/* Data embedded in wh_bridge.elf (paths are the names build.sh copies them to).
 *
 * wh_delta:  bridge delta (tools/make_delta.js). The detour rebuilds the bridge
 *            HBC inside ShellUI from the hub's own bytecode plus this blob, so no
 *            Sony bytecode is shipped.
 * wh_loader: minified widget loader (tools/build_loader.js from loader.js),
 *            NUL-terminated so prelude.c can treat it as a C string. */
.section .rodata
.align 16
.global wh_delta_start
.global wh_delta_end
wh_delta_start:
.incbin "bridge.delta"
wh_delta_end:

.global wh_loader
wh_loader:
.incbin "loader.min.js"
.byte 0
