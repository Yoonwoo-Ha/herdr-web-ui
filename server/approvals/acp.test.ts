import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { InteractivePrompt, PanePromptResponse } from "../../shared/protocol.ts";
import { KeeperClient, type AcpApproval } from "../acp/client.ts";
import { keeperBuilt, keeperRoot, startKeeper, until } from "../acp/keeper.fake.ts";
import { handlePromptRequest } from "../prompt.ts";
import { acpCard, type AcpCards } from "./acp.ts";

const approval = (toolCall: Partial<AcpApproval["toolCall"]>, raw = "{}"): AcpApproval => ({
  keeperId: "agent-7", seq: 9, raw, sessionId: "s",
  toolCall: { title: null, kind: null, rawInput: null, content: null, ...toolCall },
  options: [{ optionId: "a", name: "Allow once", kind: "allow_once" }, { optionId: "r", name: "Reject", kind: "reject_once" }],
});

describe("acpCard", () => {
  it("shows the agent's title, its command and its options in order, and names the request it was built on", () => {
    const card = acpCard("claude", approval({ title: "Run tests", kind: "execute", rawInput: { command: "bun test" } }, "{\"id\":\"agent-7\"}"));
    expect(card).toMatchObject({
      agent: "claude", kind: "approval", title: "Run tests", body: "bun test", multi_select: false, custom_option_index: null,
      options: [{ label: "Allow once", description: null }, { label: "Reject", description: null }],
    });
    expect(card.id).toMatch(/^acp\.agent-7\.[0-9a-f]{16}$/);
    expect(card.own_text?.title).toBeUndefined();
    // another request under the same keeper id is another card
    expect(acpCard("claude", approval({ title: "Run tests" }, "{\"id\":\"agent-7\",\"x\":1}")).id).not.toBe(card.id);
  });

  it("shows shell argument boundaries, including empty arguments", () => {
    const card = acpCard("fake", approval({ rawInput: { command: ["echo", "my dir", "", "x"] } }));
    expect(card.body).toBe("echo 'my dir' '' x");
  });

  it("writes its own title where the agent gave none, and shows the input and the content it sent", () => {
    const card = acpCard("gemini", approval({
      rawInput: { path: "a.txt" },
      content: [{ type: "content", content: { type: "text", text: "Write a.txt" } }, { type: "diff", path: "a.txt", oldText: "", newText: "hello" }],
    }));
    expect(card.own_text?.title).toEqual({ key: "Permission request" });
    expect(card.title).toBe("Permission request");
    expect(card.body).toBe("{\n  \"path\": \"a.txt\"\n}\n\nWrite a.txt\n\na.txt\nhello");
    expect(card.options.map((option) => option.label)).toEqual(["Allow once", "Reject"]);
  });

  it("only offers rejection when the request's only description is an unshowable title", () => {
    const card = acpCard("fake", approval({ title: "Delete \u202efile" }));
    expect(card.own_text?.title).toBeDefined();
    expect(card.own_text?.body).toBeDefined();
    expect(card.options.map((option) => option.label)).toEqual(["Reject"]);
  });

  it("only offers rejection when the body cannot be shown in full", () => {
    for (const command of ["echo x\u202e", "x".repeat(12_001)]) {
      const card = acpCard("claude", approval({ title: "Run", rawInput: { command } }));
      expect(card.own_text?.body?.key).toBe(card.body ?? "missing body");
      expect(card.body).toContain("F4");
      expect(card.options.map((option) => option.label)).toEqual(["Reject"]);
    }
  });
});

describe.skipIf(!keeperBuilt)("the prompt routes for an ACP child", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function child() {
    const root = keeperRoot();
    const keeper = await startKeeper(root);
    const client = new KeeperClient(root);
    cleanups.push(() => rmSync(dirname(root), { recursive: true, force: true }), keeper.stop, () => client.close());
    await client.ready();
    await until(client, "session", () => client.session !== null);
    return { harness: "fake", client };
  }

  const read = async (acp: AcpCards, paneId: string, readOnly = false) => {
    const url = new URL(`http://ovis/api/pane/prompt?pane_id=${paneId}`);
    const response = await handlePromptRequest(new Request(url), url, { acp, readOnly });
    return (await response!.json()) as PanePromptResponse;
  };
  const answer = async (acp: AcpCards, body: Record<string, unknown>) => {
    const url = new URL("http://ovis/api/pane/prompt/answer");
    const response = await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, { acp });
    return { status: response!.status, body: await response!.json() as { error?: { code: string } } };
  };

  it("sends the visible reject choice, not the option that used to be at its index", async () => {
    const acpChild = await child();
    const acp = { forPane: () => acpChild };
    const { client } = acpChild;
    const turn = client.request("session/prompt", { sessionId: client.session, prompt: [{ type: "text", text: "ask" }] });
    await until(client, "the request", () => client.pending().length === 1);
    const [asked] = client.pending();
    if (!asked) throw new Error("missing request");
    using pending = spyOn(client, "pending");
    pending.mockReturnValue([{ ...asked, toolCall: { ...asked.toolCall, rawInput: "x".repeat(12_001) } }]);
    const card = (await read(acp, "t7")).prompt;
    expect(card?.options.map((option) => option.label)).toEqual(["Reject"]);
    expect((await answer(acp, { pane_id: "t7", prompt_id: card?.id, option_index: 0 })).status).toBe(200);
    await turn;
    expect(client.turn?.text).toBe("answered reject");
  });

  it("shows the oldest permission request as a card, and the chosen option reaches the agent once", async () => {
    const acpChild = await child();
    const acp = { forPane: (paneId: string) => paneId === "t7" ? acpChild : undefined };
    const { client } = acpChild;
    expect((await read(acp, "t7")).prompt).toBeNull();

    const turn = client.request("session/prompt", { sessionId: client.session, prompt: [{ type: "text", text: "ask" }] });
    await until(client, "the permission request", () => client.pending().length === 1);
    const card = (await read(acp, "t7")).prompt as InteractivePrompt;
    expect(card).toMatchObject({ agent: "fake", kind: "approval", title: "touch x", body: "touch x" });
    expect(card.options.map((option) => option.label)).toEqual(["Allow", "Reject"]);
    // a watcher sees the same card
    expect((await read(acp, "t7", true)).prompt).toEqual(card);

    expect(await answer(acp, { pane_id: "t7", prompt_id: `${card.id}x`, option_index: 1 })).toMatchObject({ status: 409, body: { error: { code: "prompt_changed" } } });
    expect(await answer(acp, { pane_id: "t7", prompt_id: card.id, option_index: 2 })).toMatchObject({ status: 400, body: { error: { code: "invalid_answer" } } });
    const choice = { pane_id: "t7", prompt_id: card.id, option_index: 1 };
    const responses = await Promise.all([answer(acp, choice), answer(acp, choice)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)?.body.error?.code).toBe("prompt_changed");
    await turn;
    expect(client.turn?.text).toBe("answered reject");
    expect(await answer(acp, { pane_id: "t7", prompt_id: card.id, option_index: 0 })).toMatchObject({ status: 409, body: { error: { code: "prompt_changed" } } });
    expect((await read(acp, "t7")).prompt).toBeNull();
  });
});
