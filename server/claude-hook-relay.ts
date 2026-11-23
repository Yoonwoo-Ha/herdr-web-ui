/**
 * `ovis-server claude-hook --socket <path> --launch <id>`: the command Claude Code runs for its PermissionRequest
 * hook (server/claude-permission-hook.ts). It posts the event on stdin to the server's socket and prints the answer.
 * No socket, a refusal, or any other failure prints nothing and exits 0, which Claude reads as no decision: its own
 * dialog stands. It has no time limit of its own; Claude's hook timeout ends it.
 */

export function relayOptions(argv: readonly string[]): { socket: string; launch: string } | null {
  const value = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 && typeof argv[at + 1] === "string" && argv[at + 1] !== "" ? argv[at + 1]! : null;
  };
  const socket = value("--socket"), launch = value("--launch");
  return socket === null || launch === null ? null : { socket, launch };
}

/**
 * Whether Bun was told to load a module before this one (its flags, or BUN_OPTIONS): code from wherever Claude runs the
 * hook. Such a run answers nothing. A bunfig.toml's preload does not show here; the hook's command keeps Bun from
 * reading the working folder's (relayCommand in server/claude-permission-hook.ts).
 */
export const preloaded = (execArgv: readonly string[]): boolean => execArgv.some((arg) => /^(?:-r|--preload|--require|--import)(?:=|$)/.test(arg));

export async function runClaudeHookRelay(): Promise<void> {
  if (preloaded(process.execArgv)) return;
  const options = relayOptions(process.argv.slice(2));
  if (options === null) {
    console.error("usage: ovis-server claude-hook --socket <path> --launch <id>");
    process.exit(2);
  }
  try {
    const response = await fetch("http://localhost/claude/permission", {
      unix: options.socket,
      // Bun's default idle cut (5 minutes) would end a request the card still holds
      timeout: false,
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.launch}` },
      body: await Bun.stdin.text(),
    });
    if (response.ok) process.stdout.write(await response.text());
  } catch {}
}

if (import.meta.main) await runClaudeHookRelay();
