import { expect, it } from "bun:test";
import { MuxProtocolError } from "../shared/relay-mux.ts";
import { accountPcFailure } from "./machines.ts";

const shown = { shown: true, aborted: false };

it("tells a member's Deny from nobody answering in time, once the request was shown", () => {
  expect(accountPcFailure(new MuxProtocolError("auth_failed", "refused"), shown).failure).toBe("declined");
  // the PC closed the comparison at its deadline (session.ts close("timeout")): nobody decided, so nothing is remembered
  expect(accountPcFailure(new MuxProtocolError("timeout", "timed out"), shown).failure).toBe("unanswered");
  expect(accountPcFailure(new Error("Relay connection lost", { cause: new MuxProtocolError("timeout", "timed out") }), shown).failure).toBe("unanswered");
});

it("keeps the failures before the request was shown as they were", () => {
  expect(accountPcFailure(new MuxProtocolError("timeout", "timed out"), { shown: false, aborted: false }).failure).toBe("offline");
  expect(accountPcFailure(new MuxProtocolError("auth_failed", "refused"), { shown: true, aborted: true }).failure).toBe("cancelled");
});
