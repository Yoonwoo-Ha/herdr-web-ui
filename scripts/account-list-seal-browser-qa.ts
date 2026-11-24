import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { chromium, webkit } from "playwright-core";
import {
  epochKeyCommitment, generateStoredEncryptionKey, newEpochKey, nextEpoch, openSealed, openWrap, readStoredEncryptionKey, sealFields, wrapEpochKey, wrapFromText, wrapToText,
} from "../shared/account-list-seal.ts";
import type { SealVector, SealVectorResult } from "../shared/account-list-seal-vectors.ts";
import { fromBase64Url, toBase64Url } from "../shared/relay-pair-sas.ts";
import { chromePath } from "./chrome-path.ts";

// A device seals and opens with WebCrypto and a key it cannot export, kept in IndexedDB. Bun's
// tests cannot show that a browser does the same, so the vectors and both directions run here.
// CI runs Chromium; SEAL_ENGINE=webkit runs the engine of iPhones where Playwright's WebKit starts.
const engine = process.env["SEAL_ENGINE"] === "webkit" ? "WebKit" : "Chromium";
const shared = (file: string) => fileURLToPath(new URL(`../shared/${file}`, import.meta.url));
const build = await Bun.build({ entrypoints: [shared("account-list-seal.ts"), shared("account-list-seal-vectors.ts")], target: "browser" });
if (!build.success || build.outputs.length !== 2) throw new AggregateError(build.logs, "Could not build the seal module");
const modules = new Map(build.outputs.map((output) => [output.path.replace(/^.*\//, "/"), output]));
const vectorDir = shared("account-list-vectors/seal");
const vectors = readdirSync(vectorDir).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(`${vectorDir}/${file}`, "utf8")) as SealVector);
assert.ok(vectors.length >= 68, "the vectors are read");

const LIST = "5c".repeat(32);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
  const module = modules.get(new URL(request.url).pathname);
  return module ? new Response(module, { headers: { "content-type": "text/javascript" } }) : new Response("<!doctype html><title>Seal test</title>", { headers: { "content-type": "text/html" } });
} });
try {
  const browser = engine === "WebKit" ? await webkit.launch({ headless: true }) : await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);

    const results = await page.evaluate(async (given: SealVector[]) => {
      const modulePath = "/account-list-seal-vectors.js";
      const { sealVectorResult }: typeof import("../shared/account-list-seal-vectors.ts") = await import(modulePath);
      const out: SealVectorResult[] = [];
      for (const vector of given) out.push(await sealVectorResult(vector));
      return out;
    }, vectors);
    for (const [index, vector] of vectors.entries()) assert.deepEqual(results[index], vector.expect, vector.name);
    console.log(`PASS seal vectors in ${engine}: ${vectors.length} vectors give their expect with a member key that cannot be exported`);

    const device = await page.evaluate(async () => {
      const modulePath = "/account-list-seal.js";
      const { generateDeviceEncryptionKey }: typeof import("../shared/account-list-seal.ts") = await import(modulePath);
      const made = await generateDeviceEncryptionKey();
      const exported: string[] = [];
      for (const format of ["pkcs8", "jwk", "raw"] as const) {
        exported.push(await crypto.subtle.exportKey(format, made.privateKey).then(() => "exported", (error: unknown) => (error instanceof DOMException ? error.name : "threw")));
      }
      const stored = await new Promise<string>((resolve, reject) => {
        const opening = indexedDB.open("seal-test", 1);
        opening.onupgradeneeded = () => opening.result.createObjectStore("keys");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const write = opening.result.transaction("keys", "readwrite");
          write.oncomplete = () => { opening.result.close(); resolve("stored"); };
          // A write can be taken and its transaction still not kept: then `abort` comes, with or without an `error` before it.
          const failed = () => { opening.result.close(); reject(write.error ?? new Error("The transaction that stores the key was aborted")); };
          write.onerror = failed;
          write.onabort = failed;
          try {
            write.objectStore("keys").put(made, "device");
          } catch (error) {
            opening.result.close();
            resolve(error instanceof DOMException ? error.name : "threw");
          }
        };
      });
      (globalThis as { sealDevice?: unknown }).sealDevice = made;
      return { key: made.key, extractable: made.privateKey.extractable, usages: made.privateKey.usages, exported, stored };
    });
    assert.equal(device.extractable, false);
    assert.deepEqual(device.usages, ["deriveBits"]);
    assert.deepEqual(device.exported, ["InvalidAccessError", "InvalidAccessError", "InvalidAccessError"]);
    // Playwright's WebKit has no key to wrap a CryptoKey for IndexedDB with (Safari takes it from the
    // Keychain) and refuses the write; there the key stays in the page that made it.
    const fromStore = device.stored === "stored";
    if (engine === "Chromium") assert.equal(device.stored, "stored");
    else if (!fromStore) assert.equal(device.stored, "DataCloneError");
    console.log(`PASS device key in ${engine}: made so that it cannot be exported${fromStore ? ", and stored in IndexedDB as the key it is" : `; this engine's harness stores no key in IndexedDB (${device.stored})`}`);

    // Made here (Bun), opened there: in a new page of the same origin, with the key read back from IndexedDB.
    const first = newEpochKey(0);
    const removal = await nextEpoch({ list: LIST, current: first, members: [device.key] });
    const fields = [{ name: "endpoint", value: utf8ToBytes("pc.example:17420") }, { name: "label", value: utf8ToBytes("거실 맥북") }];
    const stored = await generateStoredEncryptionKey();
    const pc = await readStoredEncryptionKey(stored.secret);
    const handed = {
      list: LIST, pc: pc.key,
      wrap: wrapToText(removal.wraps[0]?.wrap ?? new Uint8Array(0)), link: toBase64Url(removal.link),
      commitments: [epochKeyCommitment({ list: LIST, epoch: first }), removal.commitment],
      genesis: toBase64Url(await sealFields({ place: { list: "", seq: 0 }, epoch: first, commitment: epochKeyCommitment({ list: "", epoch: first }), fields })),
      later: toBase64Url(await sealFields({ place: { list: LIST, seq: 4 }, epoch: removal.epoch, commitment: removal.commitment, fields })),
    };
    const second = fromStore ? await context.newPage() : page;
    if (fromStore) await second.goto(`http://127.0.0.1:${server.port}`);
    const there = await second.evaluate(async (given: typeof handed) => {
      const modulePath = "/account-list-seal.js";
      const seal: typeof import("../shared/account-list-seal.ts") = await import(modulePath);
      const unbase64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const shown = (opened: Awaited<ReturnType<typeof seal.openSealed>>) => (opened.open ? opened.value.map((field) => [field.name, new TextDecoder().decode(field.value)]) : opened.why);
      type Device = import("../shared/account-list-seal.ts").MemberEncryptionKey;
      const kept = (globalThis as { sealDevice?: Device }).sealDevice;
      const device = kept ?? await new Promise<Device>((resolve, reject) => {
        const opening = indexedDB.open("seal-test", 1);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const reading = opening.result.transaction("keys");
          const read = reading.objectStore("keys").get("device");
          read.onsuccess = () => { opening.result.close(); resolve(read.result); };
          const failed = () => { opening.result.close(); reject(read.error ?? reading.error ?? new Error("The transaction that reads the key was aborted")); };
          read.onerror = failed;
          reading.onabort = failed;
        };
      });
      const [commitment0 = "", commitment1 = ""] = given.commitments;
      const current = await seal.openWrap({ list: given.list, epoch: 1, commitment: commitment1, wrap: seal.wrapFromText(given.wrap), member: device });
      if (!current.open) return { stopped: current.why };
      const walk = await seal.walkBack({ list: given.list, from: current.value, openings: new Map([[0, { commitment: commitment0 }], [1, { commitment: commitment1, link: unbase64(given.link) }]]) });
      const [, epoch0] = walk.keys;
      if (walk.stopped !== null || epoch0 === undefined) return { stopped: walk.stopped?.why ?? "missing" };
      const refusedWrap = await seal.openWrap({ list: given.list, epoch: 1, commitment: commitment0, wrap: seal.wrapFromText(given.wrap), member: device });
      const next = await seal.nextEpoch({ list: given.list, current: current.value, members: [given.pc, device.key] });
      return {
        stopped: null,
        extractable: device.privateKey.extractable,
        keys: walk.keys.map((key) => hex(key.key)),
        genesis: shown(await seal.openSealed({ place: { list: "", seq: 0 }, epoch: epoch0, sealed: unbase64(given.genesis) })),
        later: shown(await seal.openSealed({ place: { list: given.list, seq: 4 }, epoch: current.value, sealed: unbase64(given.later) })),
        underOldEpoch: shown(await seal.openSealed({ place: { list: given.list, seq: 4 }, epoch: epoch0, sealed: unbase64(given.later) })),
        otherCommitment: refusedWrap.open ? "open" : refusedWrap.why,
        // Made there, for Bun to open.
        made: {
          commitment: next.commitment,
          wraps: next.wraps.map((wrap) => ({ member: wrap.member, text: seal.wrapToText(wrap.wrap) })),
          sealed: hex(await seal.sealFields({ place: { list: given.list, seq: 9 }, epoch: next.epoch, commitment: next.commitment, fields: [{ name: "label", value: new TextEncoder().encode("Made in a browser") }] })),
        },
      };
    }, handed);
    assert.equal(there.stopped, null);
    assert.equal(there.extractable, false);
    assert.deepEqual(there.keys, [bytesToHex(removal.epoch.key), bytesToHex(first.key)]);
    const names = [["endpoint", "pc.example:17420"], ["label", "거실 맥북"]];
    assert.deepEqual(there.genesis, names);
    assert.deepEqual(there.later, names);
    assert.equal(there.underOldEpoch, "refused");
    assert.equal(there.otherCommitment, "other_key");
    console.log(`PASS made in Bun, opened in ${engine}: the key ${fromStore ? "from IndexedDB" : "of the page"} opens its wrap, walks back one epoch and opens both sealed fields`);

    const made = there.made;
    assert.ok(made);
    assert.deepEqual(made.wraps.map((wrap) => wrap.member), [pc.key, device.key]);
    const opened = await openWrap({ list: LIST, epoch: 2, commitment: made.commitment, wrap: wrapFromText(made.wraps[0]?.text ?? ""), member: pc });
    assert.ok(opened.open, "the PC's stored key opens the wrap a browser made");
    const label = await openSealed({ place: { list: LIST, seq: 9 }, epoch: opened.value, sealed: hexToBytes(made.sealed) });
    assert.ok(label.open);
    assert.deepEqual(label.value.map((field) => [field.name, new TextDecoder().decode(field.value)]), [["label", "Made in a browser"]]);
    const others = await openWrap({ list: LIST, epoch: 2, commitment: made.commitment, wrap: wrapFromText(made.wraps[1]?.text ?? ""), member: pc });
    assert.deepEqual(others, { open: false, why: "refused" });
    const service = await wrapEpochKey({ list: LIST, epoch: newEpochKey(2), member: pc.key });
    assert.deepEqual(await openWrap({ list: LIST, epoch: 2, commitment: made.commitment, wrap: service, member: pc }), { open: false, why: "other_key" });
    assert.equal(fromBase64Url(stored.secret).length, 138);
    console.log(`PASS made in ${engine}, opened in Bun: a PC's stored key opens its wrap of the next epoch and the field sealed under it, and no other member's wrap`);
  } finally {
    await browser.close();
  }
} finally {
  await server.stop(true);
}
