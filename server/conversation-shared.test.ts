import { expect, it } from "bun:test";
import { closeSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishAsync, type Steps } from "./codex-images.ts";
import { boundSteps, ConversationReadPending, type FileIdentity, openBound } from "./conversation-shared.ts";

it("keeps two interleaved lookups' bindings of one path apart, through their awaits and a rejected one, and none after them", async () => {
  const root = mkdtempSync(join(tmpdir(), "bound-steps-"));
  try {
    const path = join(root, "transcript.jsonl");
    writeFileSync(path, "the pane's own\n");
    const own = statSync(path);
    const other: FileIdentity = { dev: own.dev, ino: own.ino + 1 };
    const opened = (): string => {
      try { closeSync(openBound(path)); return "open"; }
      catch (error) { return error instanceof ConversationReadPending ? "refused" : "error"; }
    };
    function* lookup(rejecting: boolean): Steps<string> {
      const seen: string[] = [];
      for (let step = 0; step < 3; step++) {
        if (rejecting && step === 1) {
          try { yield Promise.reject(new Error("read failed")); } catch { seen.push("rejected"); }
        } else yield;
        seen.push(opened());
      }
      return seen.join(",");
    }
    const [mine, theirs] = await Promise.all([
      finishAsync(boundSteps([[path, own]], lookup(false))),
      finishAsync(boundSteps([[path, other]], lookup(true))),
    ]);
    expect(mine).toBe("open,open,open");
    expect(theirs).toBe("refused,rejected,refused,refused");
    expect(opened()).toBe("open");
    const failing = function* (): Steps<never> { yield; throw new Error("broken"); };
    await expect(finishAsync(boundSteps([[path, other]], failing()))).rejects.toThrow("broken");
    expect(opened()).toBe("open");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
