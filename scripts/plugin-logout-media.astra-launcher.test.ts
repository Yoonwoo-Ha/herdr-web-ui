import { expect, it } from "bun:test";
import { memberRow, pairingPc } from "../server/account/pairing.test-helpers.ts";
import { askRecovery } from "../server/account/recovery.ts";
import { watchPageMedia } from "../server/file-view.ts";
import { runLogout } from "./plugin-recover.ts";

it.skipIf(process.platform === "win32")("logout invalidates device media authorizations as well as paired rows", async () => {
  const member = await memberRow("acct_fixture");
  const codeDevice = { ...(await memberRow("unused")).row, account: undefined };
  const pc = await pairingPc({ rows: [member.row, codeDevice], startRelay: false, server: { accountOpensAll: true } });
  const before = watchPageMedia();
  try {
    expect(pc.devices.account()).toBe("acct_fixture");
    expect(pc.stored().some(row => row.id === codeDevice.id)).toBe(true);
    const result = await runLogout({ platform: "linux", label: "fixture", terminal: true, out() {}, ask: async () => "yes",
      account: async () => ({ account: pc.devices.account(), members: 1 }), send: request => askRecovery(pc.stateDir, request), leave: async () => true });
    expect(result).toBe(0);
    expect(pc.stored()).toHaveLength(0);
    const after = watchPageMedia();
    after.done();
    expect(after.since, "logout did not invalidate any device media authorizations").toBeGreaterThan(before.since);
  } finally { before.done(); await pc.close(); }
});
