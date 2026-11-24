import { describe, expect, it } from "bun:test";
import { KeeperAnswers } from "./answers.ts";
import type { AcpApproval } from "./messages.ts";

const asked = { options: [{ optionId: "allow" }, { optionId: "reject" }] } as unknown as AcpApproval;

function sentAsClient2(answers: KeeperAnswers): Promise<string> {
  return answers.answer({ id: "agent-1", optionId: "reject", asked }, () => () => {}, (_asked, reservation) => { reservation.by = "client-2"; });
}

describe("KeeperAnswers", () => {
  it("counts an answer the keeper dropped while another client's was on its way to the agent as lost", async () => {
    const answers = new KeeperAnswers();
    const outcome = sentAsClient2(answers);
    // the keeper notes the loser before the winner's delivery is confirmed
    answers.dropped("agent-1", "client-2", true);
    expect(await outcome).toBe("lost");
  });

  it("counts an answer the keeper dropped for an agent that is gone as gone", async () => {
    const answers = new KeeperAnswers();
    const outcome = sentAsClient2(answers);
    answers.dropped("agent-1", "client-2", false);
    expect(await outcome).toBe("gone");
  });
});
