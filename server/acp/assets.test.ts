import { expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeeperClient } from "./client.ts";

// The Codex probe's planSample and Agy's diffSample (local path/value redacted),
// in keeper envelopes, with a one-pixel prompt image instead of a model download.
it("serves the prompt picture from the active archive and renders a create-file diff without rawInput", async () => {
  const root = mkdtempSync(join(tmpdir(), "acp-image-"));
  const path = join(root, "archive.jsonl");
  copyFileSync(new URL("../fixtures/acp/keeper.jsonl", import.meta.url), path);
  const socket = new Socket();
  const client = new KeeperClient(root, { connect: () => socket });
  try {
    socket.emit("data", readFileSync(path, "utf8"));
    const { turns } = await client.history.page({});
    const image = turns[0]?.parts[0];
    if (image?.kind !== "image") throw new Error("missing prompt image");
    const asset = await client.history.asset(image.ref);
    if (!asset || typeof asset === "string") throw new Error("missing image bytes");
    expect(asset.mediaType).toBe("image/png");
    expect(Buffer.from(asset.bytes).readUInt32BE(0)).toBe(0x89504e47);
    expect(client.history.plan?.[0]).toMatchObject({ label: "Look up alpha in the Ovis vault.", status: "in_progress" });
    const edit = turns[1]?.parts.find(part => part.kind === "tool" && part.name === "edit");
    if (edit?.kind !== "tool") throw new Error("missing edit");
    expect(edit).toMatchObject({ edits: [{ path: "probe-note.txt", before: "", after: "sample" }], output: "--- probe-note.txt\n\n+++ probe-note.txt\nsample" });
    const mode = (seq: number, phase: string) => JSON.stringify({ seq, dir: "keeper", raw: JSON.stringify({ method: "_keeper/mode", params: { mode: "acp", phase } }) });
    socket.emit("data", mode(6,"start") + "\n" + mode(7,"ready") + "\n");
    expect(await client.history.asset(image.ref)).toBeNull();
  } finally { client.close(); rmSync(root, { recursive: true, force: true }); }
});
