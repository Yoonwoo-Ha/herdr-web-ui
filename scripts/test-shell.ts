import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Match CI's runner shell, including on macOS; use POSIX sh where bash is absent.
// Windows keeps herdr's native shell selection rather than receiving a Unix path.
export function testShellEnv(dir: string): Record<string, string> {
  if (process.platform === "win32") return {};
  if (!existsSync("/bin/bash")) return { SHELL: "/bin/sh" };
  mkdirSync(dir, { recursive: true });
  const shell = join(dir, "test-bash");
  // Keep the long options before herdr's flags, including -l. Noninteractive bash also
  // reads BASH_ENV unless it is unset; none of the user's startup files belong in a pane. A login
  // shell also runs ~/.bash_logout as it exits, so -l/--login is dropped: the pane keeps HOME.
  // Readline in a C locale (a CI container sets none) takes each byte over 0x7f for a Meta key and
  // mangles UTF-8 typed into the pane (`\u2022`, `\u2191`, `\u203a`); keep typed bytes as they are.
  const inputrc = join(dir, "test-inputrc");
  writeFileSync(inputrc, "set input-meta on\nset output-meta on\nset convert-meta off\n");
  writeFileSync(shell, `#!/bin/sh\nunset BASH_ENV ENV\nINPUTRC='${inputrc.replaceAll("'", "'\\''")}'\nexport INPUTRC\nn=$#\nwhile [ "$n" -gt 0 ]; do a=$1; shift; n=$((n - 1)); case "$a" in -l|--login) ;; *) set -- "$@" "$a" ;; esac; done\nexec /bin/bash --noprofile --norc "$@"\n`, { mode: 0o700 });
  chmodSync(shell, 0o700);
  return { SHELL: shell };
}
