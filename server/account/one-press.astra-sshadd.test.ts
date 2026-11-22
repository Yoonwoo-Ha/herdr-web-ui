import { expect, test } from "bun:test";
import { pairingPc } from "./pairing.test-helpers.ts";
import { askRecovery } from "./recovery.ts";

const server = { accountOpensAll: true, machines: false };

test("SSH add can inspect an independently installed PC before its first browser visit", async () => {
  const pc = await pairingPc({ server, startRelay: false });
  try {
    expect(await askRecovery(pc.stateDir, { act: "account_add_inspect" })).toMatchObject({ server_id: expect.any(String), account: null });
  } finally { await pc.close(); }
});
