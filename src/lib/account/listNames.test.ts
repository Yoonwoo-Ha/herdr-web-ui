import { expect, it } from "bun:test";
import type { ListState } from "../../../shared/account-list.ts";
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import {
  LIST_EPOCH_WALK_MAX, epochKeyCommitment, generateDeviceEncryptionKey, newEpochKey, nextEpoch, wrapEpochKey, wrapToText, type EpochKey,
} from "../../../shared/account-list-seal.ts";
import { openEpochs } from "./listNames.ts";

it("walks back from every wrap it holds: a list with more epochs than one walk goes through still opens its oldest names", async () => {
  const list = "5c".repeat(32);
  const member = await generateDeviceEncryptionKey();
  let current: EpochKey = newEpochKey(0);
  const keys = [current];
  const epochs: { opens: string; link: string | null; seq: number }[] = [{ opens: epochKeyCommitment({ list: "", epoch: current }), link: null, seq: 0 }];
  // one epoch more than a walk from the newest reaches: that walk ends at epoch 1
  const last = LIST_EPOCH_WALK_MAX + 1;
  for (let epoch = 1; epoch <= last; epoch += 1) {
    const next = await nextEpoch({ list, current, members: [] });
    epochs.push({ opens: next.commitment, link: toBase64Url(next.link), seq: epoch });
    current = next.epoch;
    keys.push(current);
  }
  const wrapOf = async (epoch: number): Promise<[number, string]> => [epoch, wrapToText((await wrapEpochKey({ list, epoch: keys[epoch]!, member: member.key }))!)];
  const state = { list, epoch: last, epochs } as unknown as ListState;
  // with the newest wrap alone, the walk stops one short of epoch 0
  const newest = await openEpochs(state, { list, member: member.key, wraps: new Map([await wrapOf(last)]) }, member);
  expect([newest.keys.size, newest.keys.has(1), newest.keys.has(0)]).toEqual([LIST_EPOCH_WALK_MAX + 1, true, false]);
  // with a wrap of an epoch that walk reached, the device walks on from there
  const both = await openEpochs(state, { list, member: member.key, wraps: new Map([await wrapOf(last), await wrapOf(1)]) }, member);
  expect([both.keys.size, both.good, both.wrong]).toEqual([last + 1, [last, 1], []]);
  expect(both.keys.get(0)!.key).toEqual(keys[0]!.key);
}, 60_000);
