/* Data embedded in wh_bridge.elf (paths are the names build.sh copies them to).
 *
 * wh_loader: minified widget loader (tools/build_loader.js from loader.js),
 *            NUL-terminated so prelude.c can treat it as a C string.
 *
 * The bridge deltas (one per firmware) are in the generated deltas.S
 * (tools/build_deltas.js); see bridge.c. */
.section .rodata
.align 16
.global wh_loader
wh_loader:
.incbin "loader.min.js"
.byte 0
