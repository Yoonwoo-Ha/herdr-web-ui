import { AGENT_CHROME, codexThreadTitle, folderName, SHELL_PREFIX, shortPathTitle, stripPaneChrome } from "../../shared/pane-title.ts";

export { codexThreadTitle, folderName, shortPathTitle, stripPaneChrome };

export function tabTitle(title: string, agent: string | null | undefined): string {
  const rest = shortPathTitle(stripPaneChrome(title, agent));
  const mark = agent ? title.replace(SHELL_PREFIX, "").match(AGENT_CHROME)?.[0] ?? "" : "";
  return rest ? `${mark}${rest}` : "";
}

export function taskRowLines({ paneTitle, labelled, folder, workspace, alias }: {
  paneTitle: string;
  labelled: boolean;
  folder: string;
  /** the workspace's row name: its label, which herdr makes from the branch until its owner names it */
  workspace: string;
  alias?: string | null;
}): { title: string; place: string } {
  const title = !labelled && paneTitle === folder ? workspace : paneTitle;
  const where = [workspace === title ? "" : workspace, alias && alias !== title && alias !== workspace ? alias : ""].filter(Boolean).join(" · ");
  const said = folder === title || folder === workspace || folder === alias;
  return { title, place: placeLine(where, said ? "" : folder) };
}

export function unsaidLine(title: string, parts: readonly (string | null | undefined)[]): string {
  const said = new Set([title]);
  const line: string[] = [];
  for (const part of parts) {
    if (!part || said.has(part)) continue;
    said.add(part);
    line.push(part);
  }
  return line.join(" · ");
}

export function placeLine(workspace: string, folder: string): string {
  return !folder || folder === workspace ? workspace : !workspace ? folder : `${workspace} · ${folder}`;
}
