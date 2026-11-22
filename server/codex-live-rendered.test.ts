import { describe, expect, it } from "bun:test";
import { matchCodexTranscript } from "./codex.ts";

const answer = "**금융 운영 업무의 반복 작업을 분석하고 자동화하는 직무입니다.** 고객의 문의와 처리 기준을 먼저 확인하고, 담당자가 검토해야 하는 단계와 자동으로 처리할 수 있는 단계를 구분하겠습니다. 확인한 결과는 지원서 초안에 반영하겠습니다.";
const drawn = answer.replaceAll("**", "");
const message = (text: string, role = "assistant") => JSON.stringify({
  type: "response_item", payload: { type: "message", role, phase: "commentary", content: [{ type: "output_text", text }] },
});
const candidate = (path = "own", text = answer) => ({ path, text: message(text) });
const screen = (text = drawn) => [
  "› Check the application requirements",
  "",
  `• ${text}`,
  "",
  "• Ran inspect-application",
  "  └ Required fields are listed below",
  "",
  "• Working (4s • esc to interrupt)",
  "",
  "› Ask Codex to do anything",
  "",
  "  GPT-6.1-Sol medium · /tmp/project",
].join("\n");

describe("whole rendered assistant messages during a tool run", () => {
  it("recognizes a complete emphasized commentary before the turn finishes", () => {
    expect(matchCodexTranscript(screen(), [candidate()])).toBe("own");
  });

  it("recognizes a message wrapped inside a Korean word", () => {
    expect(matchCodexTranscript(screen(drawn.replace("검토해야", "검토\n  해야")), [candidate()])).toBe("own");
  });

  it("refuses a partial message or changed punctuation", () => {
    for (const changed of [drawn.slice(10), drawn.slice(0, -12), drawn + " extra", drawn.replace("직무입니다.", "직무입니다!")]) {
      expect(matchCodexTranscript(screen(changed), [candidate()])).toBeNull();
    }
  });

  it("takes no message from the rows a read begins with, below a prompt's or a tool output's first row it cut", () => {
    const rest = ["", "• Ran inspect-application", "  └ Fields checked", "", "› Ask Codex to do anything"];
    for (const cut of [`  ${drawn.slice(0, 60)}\n  ${drawn.slice(60)}`, `    ${drawn}`]) {
      expect(matchCodexTranscript([cut, ...rest].join("\n"), [candidate()])).toBeNull();
    }
  });

  it("refuses two conversations whose messages render identically", () => {
    expect(matchCodexTranscript(screen(), [candidate(), candidate("other", drawn)])).toBeNull();
  });

  it("does not use a user prompt or a tool output quoting the message", () => {
    for (const quoted of [`› ${drawn}`, `• Ran command\n  └ ${drawn}`]) {
      expect(matchCodexTranscript(`${quoted}\n\n› Ask Codex to do anything`, [candidate()])).toBeNull();
    }
    expect(matchCodexTranscript(screen(), [{ path: "prompt", text: message(answer, "user") }])).toBeNull();
  });

  it("does not turn short rendered messages into persistent evidence", () => {
    expect(matchCodexTranscript(screen("확인했습니다."), [candidate("short", "**확인했습니다.**")])).toBeNull();
  });
});
