import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forgetPiModels, piContextWindow } from "./pi-models.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-pi-models-"));
afterEach(() => forgetPiModels());
afterEach(() => rmSync(root, { recursive: true, force: true }));

const agentDir = (name: string, body: string) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "models.json"), body);
  return dir;
};

const catalogsDir = (name: string, files: Record<string, unknown>) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), typeof body === "string" ? body : JSON.stringify(body));
  return dir;
};

const catalog = JSON.stringify({
  providers: {
    "lwsa-platform": {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      models: [
        { id: "vllm-flash/Qwen3.8-Flash-Next", contextWindow: 215000 },
        { id: "no-window-model" },
      ],
    },
    "other-platform": { models: [{ id: "vllm-flash/Qwen3.8-Flash-Next", contextWindow: 32000 }] },
    "shared-default": { contextWindow: 128000, models: [{ id: "a" }, { id: "b", contextWindow: 64000 }] },
    "overridden": {
      baseUrl: "https://example.invalid/v1",
      models: [{ id: "over", contextWindow: 128000 }, { id: "over-no-window" }, { id: "over-renamed", contextWindow: 20000 }],
      modelOverrides: {
        over: { contextWindow: 256000 },
        "over-no-window": { contextWindow: 96000 },
        "over-renamed": { name: "shown under another name" },
      },
    },
    "ragged": { models: [null, "a string", 7, { id: "after-the-rubble", contextWindow: 44000 }] },
    "no-models": { baseUrl: "https://example.invalid" },
  },
});

describe("the context window a pi model runs in", () => {
  it("reads the window pi reads its custom providers from", () => {
    const dir = agentDir("basic", catalog);
    expect(piContextWindow("vllm-flash/Qwen3.8-Flash-Next", "lwsa-platform", dir)).toBe(215000);
  });

  it("asks the provider too: the same model id at two windows answers with the one that served it", () => {
    const dir = agentDir("two-providers", catalog);
    expect(piContextWindow("vllm-flash/Qwen3.8-Flash-Next", "other-platform", dir)).toBe(32000);
    expect(piContextWindow("vllm-flash/Qwen3.8-Flash-Next", null, dir)).toBeNull();
    expect(piContextWindow("vllm-flash/Qwen3.8-Flash-Next", "absent-platform", dir)).toBeNull();
  });

  it("refuses a provider-level window it cannot confirm, and takes the override pi applies", () => {
    const dir = agentDir("defaults", catalog);
    expect(piContextWindow("a", "shared-default", dir)).toBeNull();
    expect(piContextWindow("b", "shared-default", dir)).toBe(64000);
    expect(piContextWindow("over", "overridden", dir)).toBe(256000);
    expect(piContextWindow("over-no-window", "overridden", dir)).toBe(96000);
    expect(piContextWindow("over-renamed", "overridden", dir)).toBe(20000);
  });

  it("skips a model entry that is not an object instead of throwing", () => {
    const dir = agentDir("ragged", catalog);
    expect(piContextWindow("after-the-rubble", "ragged", dir)).toBe(44000);
    expect(piContextWindow("a", "ragged", dir)).toBeNull();
  });

  it("says nothing it cannot support: no entry, no window, no file, a file that is not JSON", () => {
    const dir = agentDir("silent", catalog);
    expect(piContextWindow("no-window-model", "lwsa-platform", dir)).toBeNull();
    expect(piContextWindow("any", "no-models", dir)).toBeNull();
    expect(piContextWindow("any", "anywhere", join(root, "never-written"))).toBeNull();
    expect(piContextWindow("any", "anywhere", agentDir("broken", "{ providers"))).toBeNull();
    expect(piContextWindow("any", "anywhere", agentDir("not-a-catalog", "[1,2]"))).toBeNull();
    expect(piContextWindow("any", "anywhere", agentDir("empty-window", ""))).toBeNull();
  });

  it("reads the file the way pi does: comments, a BOM, and a window updated underneath a warm page", () => {
    const dir = agentDir("live", catalog);
    expect(piContextWindow("b", "shared-default", dir)).toBe(64000);
    writeFileSync(join(dir, "models.json"), `\uFEFF{ // the platform raised this week\n${JSON.stringify({ providers: { "shared-default": { models: [{ id: "a", contextWindow: 256000 }] } } }).slice(1, -1)}\n}`);
    expect(piContextWindow("a", "shared-default", dir)).toBe(256000);
  });

  it("never answers a model with the window of the one standing in for it", () => {
    const dir = agentDir("stand-in", catalog);
    expect(piContextWindow("grok-4.7", "xai", dir)).toBeNull();
    expect(piContextWindow("Ling-3.0-tiny", "llama.cpp", dir)).toBeNull();
    expect(piContextWindow("vllm-flash/Qwen3.8-Flash-Next", "lwsa-platform", dir)).toBe(215000);
  });

  it("reads the commandcode cache and the model store for providers models.json does not define", () => {
    const dir = catalogsDir("other-catalogs", {
      "commandcode-models.json": { models: [{ id: "cc-model", contextWindow: 200000 }, null, { id: "cc-no-window" }] },
      "models-store.json": {
        anthropic: { models: [{ id: "claude-x", contextWindow: 1000000 }] },
        openai: { models: [{ id: "cc-model", contextWindow: 400000 }] },
        broken: "not a provider",
      },
    });
    expect(piContextWindow("cc-model", "commandcode", dir)).toBe(200000);
    expect(piContextWindow("cc-no-window", "commandcode", dir)).toBeNull();
    expect(piContextWindow("claude-x", "anthropic", dir)).toBe(1000000);
    expect(piContextWindow("cc-model", "openai", dir)).toBe(400000);
    expect(piContextWindow("claude-x", "commandcode", dir)).toBeNull();
    expect(piContextWindow("claude-x", null, dir)).toBeNull();
  });

  it("lets models.json win, and falls through when it does not list the model", () => {
    const dir = catalogsDir("precedence", {
      "models.json": { providers: { anthropic: { models: [{ id: "claude-x", contextWindow: 300000 }] } } },
      "models-store.json": { anthropic: { models: [{ id: "claude-x", contextWindow: 1000000 }, { id: "claude-y", contextWindow: 500000 }] } },
    });
    expect(piContextWindow("claude-x", "anthropic", dir)).toBe(300000);
    expect(piContextWindow("claude-y", "anthropic", dir)).toBe(500000);
  });

  it("keeps a model models.json defines without a window unresolved, rather than take another catalog's number", () => {
    const dir = catalogsDir("custom-without-window", {
      "models.json": { providers: { commandcode: { models: [{ id: "m" }] } } },
      "commandcode-models.json": { models: [{ id: "m", contextWindow: 1000000 }, { id: "n", contextWindow: 200000 }] },
    });
    expect(piContextWindow("m", "commandcode", dir)).toBeNull();
    expect(piContextWindow("n", "commandcode", dir)).toBe(200000);
  });

  it("applies a models.json override to a model only another catalog lists", () => {
    const dir = catalogsDir("override-store-model", {
      "models.json": { providers: { anthropic: { modelOverrides: { "claude-x": { contextWindow: 500000 }, "claude-z": { name: "renamed" } } } } },
      "models-store.json": { anthropic: { models: [{ id: "claude-x", contextWindow: 1000000 }, { id: "claude-z", contextWindow: 300000 }] } },
    });
    expect(piContextWindow("claude-x", "anthropic", dir)).toBe(500000);
    expect(piContextWindow("claude-z", "anthropic", dir)).toBe(300000);
  });

  it("reads only a regular catalog file of a sane size, and never waits on a pipe", () => {
    const dir = catalogsDir("not-regular", { "models-store.json": `{"anthropic":{"models":[{"id":"big","contextWindow":1}]},"pad":"${"x".repeat(4 * 1024 * 1024)}"}` });
    mkdirSync(join(dir, "models.json"));
    expect(piContextWindow("big", "anthropic", dir)).toBeNull();
    if (process.platform === "win32") return;
    expect(Bun.spawnSync(["mkfifo", join(dir, "commandcode-models.json")]).exitCode).toBe(0);
    const started = Date.now();
    expect(piContextWindow("cc-model", "commandcode", dir)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.skipIf(process.platform === "win32")("refuses a pipe swapped in after the stat, without waiting on it", async () => {
    const dir = catalogsDir("swapped", {});
    const pipe = join(dir, "models.json");
    expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
    const child = Bun.spawn([process.execPath, "-e", `import { readRegularText } from ${JSON.stringify(join(import.meta.dir, "pi-models.ts"))}; console.log(JSON.stringify(readRegularText(${JSON.stringify(pipe)})));`], { stdout: "pipe", stderr: "inherit", timeout: 10_000 });
    await child.exited;
    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe("null");
  }, 20_000);

  it("ignores a catalog file that is not shaped like one", () => {
    const dir = catalogsDir("misshapen", {
      "commandcode-models.json": [{ id: "cc-model", contextWindow: 200000 }],
      "models-store.json": "{ anthropic",
    });
    expect(piContextWindow("cc-model", "commandcode", dir)).toBeNull();
    expect(piContextWindow("claude-x", "anthropic", dir)).toBeNull();
  });

  it("sees a catalog that appears or changes after the first read", () => {
    const dir = catalogsDir("appearing", {});
    expect(piContextWindow("cc-model", "commandcode", dir)).toBeNull();
    writeFileSync(join(dir, "commandcode-models.json"), JSON.stringify({ models: [{ id: "cc-model", contextWindow: 200000 }] }));
    expect(piContextWindow("cc-model", "commandcode", dir)).toBe(200000);
    writeFileSync(join(dir, "commandcode-models.json"), JSON.stringify({ models: [{ id: "cc-model", contextWindow: 1000000 }] }));
    expect(piContextWindow("cc-model", "commandcode", dir)).toBe(1000000);
  });

  it("refuses a window that is not a number worth dividing by", () => {
    const dir = agentDir("nonsense", JSON.stringify({ providers: { p: { models: [
      { id: "zero", contextWindow: 0 },
      { id: "negative", contextWindow: -1 },
      { id: "text", contextWindow: "200000" },
      { id: "infinite", contextWindow: 1e400 },
    ] } } }));
    for (const id of ["zero", "negative", "text", "infinite"]) expect(piContextWindow(id, "p", dir)).toBeNull();
  });
});
