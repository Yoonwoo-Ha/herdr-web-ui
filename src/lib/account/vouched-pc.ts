import { accountLabel } from "../../../shared/account-asker.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { enrollmentOf, type RelayDeviceStore } from "../relay/device.ts";
import { isNewAccountPc } from "./myPcs.ts";
import type { AccountService } from "./service.ts";

export interface MemberPcEvidence {
  readonly account: string;
  readonly accountKey: string;
  readonly paired: Pick<RelayDeviceStore, "list">;
}

/** Directory presence alone is not confirmation. The member must have finished linking this PC itself. */
export async function vouchedPcName(service: AccountService, request: { readonly through: string; readonly proven_server_id?: string }, member: MemberPcEvidence): Promise<string | null> {
  const id = request.proven_server_id;
  if (!id || id === request.through) return null;
  const [directory, devices] = await Promise.all([service.listPcs(), member.paired.list()]);
  const mine = devices.filter(device => device.device_id !== null && device.account === member.account && device.public_spki === member.accountKey);
  if (!mine.some(device => device.server_id === request.through)) return null;
  const saved = mine.find(device => device.server_id === id && device.introduced_at === undefined && enrollmentOf(device, member.account) === "complete");
  const listings = directory.filter(pc => pc.server_id === id);
  const pc = listings[0];
  if (!saved || listings.length !== 1 || !pc || pc.last_seen_at === null || !Number.isFinite(Date.parse(pc.last_seen_at)) || isNewAccountPc(pc, Date.now())) return null;
  const key = importPublicKey(saved.server_public_key);
  return deriveServerId(key) === id && bytesToHex(key) === pc.public_key ? accountLabel(pc.label) || null : null;
}
