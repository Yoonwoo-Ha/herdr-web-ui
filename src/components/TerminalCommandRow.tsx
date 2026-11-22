import { useEffect, useState } from "react";
import { SquareTerminal } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";

/** Where the desktop app's `ovis` command is (app/electron/src/terminalCommand.ts CommandState). */
export interface CommandState {
  installed: boolean;
  at: string | null;
  note: { kind: "taken" | "shadowed" | "profile"; path: string } | { kind: "off-path"; dir: string } | null;
}

/** The desktop app's bridge (app/electron/src/preload.ts ovisCommand); null elsewhere, where there is no row. */
export interface TerminalCommand {
  state(): Promise<CommandState | null>;
  install(): Promise<CommandState>;
}

export function terminalCommand(): TerminalCommand | null {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisCommand?: Partial<TerminalCommand> }).ovisCommand;
  return typeof bridge?.state === "function" && typeof bridge.install === "function" ? bridge as TerminalCommand : null;
}

/** Settings → About in the desktop app: puts the app's `ovis` command on the terminal's PATH, as VS Code's "Install 'code' command". */
export function TerminalCommandRow() {
  const t = useT();
  const [bridge] = useState(terminalCommand);
  const [state, setState] = useState<CommandState | null>(null);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void bridge?.state().then((read) => { if (current) setState(read); }).catch(() => {});
    return () => { current = false; };
  }, [bridge]);
  if (bridge === null || state === null) return null;
  const add = () => {
    setAdding(true);
    setFailed(false);
    bridge.install().then(setState, () => setFailed(true)).finally(() => setAdding(false));
  };
  const said = state.note;
  const note = said === null ? null
    : said.kind === "off-path" ? t("{dir} is not on your terminal's PATH: add it there to run ovis.", { dir: said.dir })
    : said.kind === "profile" ? t("Added ~/.local/bin to your PATH in {path}: open a new terminal window to run ovis.", { path: said.path })
    : said.kind === "taken" ? t("{path} is the ovis command of another Ovis install: it stays as it is, and this app adds none.", { path: said.path })
    : t("{path} comes first on your terminal's PATH, so ovis runs that one.", { path: said.path });
  return (
    <SettingsGroup title={t("Terminal command")} section="terminal-command">
      <SettingsRow icon={SquareTerminal} label={t("Use ovis in a terminal")}
        description={t("Adds the ovis command for this app: in a new terminal window, ovis login, ovis status and ovis approve work on this app's Ovis.")}
        condition={note === null && !failed ? undefined : <span className="settings-condition" role="status">{failed ? t("Couldn't add the ovis command.") : note}</span>}>
        {state.installed
          ? <span className="settings-fact">{state.at}</span>
          : <button type="button" className="btn" disabled={adding || state.note?.kind === "taken"} aria-busy={adding} onClick={add}>{adding ? t("Adding the command…") : t("Add the command")}</button>}
      </SettingsRow>
    </SettingsGroup>
  );
}
