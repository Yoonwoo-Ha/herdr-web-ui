/**
 * The launcher of `ovis tui` (scripts/plugin-tui.ts) with the host fixture as its screen, for
 * tui/host/restore.contract.test.ts:
 *
 *   bun tui/testing/launcher-fixture.ts <a mode of host-fixture.ts>
 *
 * The mode reaches the launcher as an argument it does not take itself, so it starts the screen at once, with no core,
 * and hands the mode on. Everything else is the launcher's own: the signals it passes on, the terminal settings it saves,
 * and what it writes back when the screen dies by a signal.
 */
import { join } from "node:path";
import { launchTui, systemParts } from "../../scripts/plugin-tui.ts";

const caller: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const parts = systemParts(caller, caller["HOME"] ?? "/");
const screen = { command: [process.execPath, join(import.meta.dir, "host-fixture.ts")], cwd: import.meta.dir, file: null };
process.exit(await launchTui([process.argv[2] ?? "wait"], { ...parts, screen }));
