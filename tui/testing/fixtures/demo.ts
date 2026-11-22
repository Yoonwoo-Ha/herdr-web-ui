import { type Fixture, place } from "./fixture.ts";

/** Two workspaces; the first has a tab split in two and a second tab; Korean text in every pane. */
export const demo: Fixture = {
  build(core) {
    const main = { space: "w-ovis", spaceName: "ovis", tab: "t-main", tabName: "main" };
    place(core, { ...main, pane: "shell" }, "$ echo 안녕\r\n안녕하세요, 헤르더 세계\r\n$ ");
    place(core, { ...main, pane: "files" }, "~/ovis $ ls\r\nREADME.md  한글.txt\r\n~/ovis $ ");
    place(core, { space: "w-ovis", spaceName: "ovis", tab: "t-logs", tabName: "logs" }, "로그: 준비됨\r\n");
    place(core, { space: "w-docs", spaceName: "문서", tab: "t-notes", tabName: "notes" }, "메모 페이지\r\n");
  },
};
