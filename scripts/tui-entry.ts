/// <reference path="../tui/emulator/wasm.d.ts" />

/**
 * The compiled binary's entry `tui` (server/main.ts): Ovis's terminal screen, tui/main.ts. server/main.ts reaches it
 * through this file because no string under server/ may hold a path with `/tui/` in it (server/catalog.conventions.test.ts
 * keeps OpenCode's `/tui/...` routes out of the server), and the binary carries only what a literal import names.
 */
import "../tui/main.ts";
