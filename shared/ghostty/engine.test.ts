import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ENGINE_ENUMS, ENGINE_FIELDS, ENGINE_FUNCTIONS, GhosttyEngine, GhosttyModule, readTypeLayout, type GhosttyExports, type GhosttyRun } from "./engine.ts";

const repo = join(import.meta.dir, "../..");
const wasmPath = join(import.meta.dir, "ghostty-vt.wasm");
/** the file the digest case checks: OVIS_GHOSTTY_WASM points it at another copy */
const checkedWasmPath = process.env.OVIS_GHOSTTY_WASM || wasmPath;

const wasm = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
const instantiate = (): WebAssembly.Instance => new WebAssembly.Instance(wasm, {});

const rowText = (runs: GhosttyRun[]): string => runs.flatMap((run) => run.cells.map((cell) => cell.text)).join("").trimEnd();

describe("shared/ghostty engine", () => {
  it("engine exports", () => {
    const exported = new Set(WebAssembly.Module.exports(wasm).map((entry) => entry.name));
    expect(Object.keys(ENGINE_FUNCTIONS).filter((name) => !exported.has(name))).toEqual([]);
    const layout = readTypeLayout(instantiate().exports as unknown as GhosttyExports);
    const unresolved = [
      ...Object.entries(ENGINE_ENUMS).flatMap(([type, names]) =>
        names.filter((name) => layout.types[type]?.values?.[name] === undefined).map((name) => `${type}.${name}`)),
      ...Object.entries(ENGINE_FIELDS).flatMap(([type, names]) =>
        names.filter((name) => layout.types[type]?.fields?.[name] === undefined).map((name) => `${type}.${name}`)),
    ];
    expect(unresolved).toEqual([]);
  });

  it("engine wasm is the build script's expected output", async () => {
    const script = await Bun.file(join(repo, "scripts/ghostty-vt/build.sh")).text();
    const expected = /^# Expected output sha256.*\n#\s+([0-9a-f]{64})$/m.exec(script)?.[1];
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(checkedWasmPath).arrayBuffer()).digest("hex");
    expect(actual).toBe(expected!);
  });

  it("engine draws what was written", () => {
    const engine = new GhosttyEngine(new GhosttyModule(instantiate()), 20, 4, { imageStorageBytes: 0n });
    try {
      engine.write(new TextEncoder().encode("hello"));
      const rows = new Map<number, string>();
      expect(engine.frame((y, runs) => rows.set(y, rowText(runs)))).toBe(true);
      expect(rows.get(0)).toBe("hello");
      expect(engine.cursor()).toEqual({ visible: true, x: 5, y: 0, style: 1 });
    } finally {
      engine.dispose();
    }
  });

  it("engine names a type name the module does not have", () => {
    const exports = new GhosttyModule(instantiate()).exports;
    const layout = readTypeLayout(exports);
    delete layout.types["GhosttyTerminalOption"]!.values!["SCROLLBACK_MAX_LINES"];
    const json = new TextEncoder().encode(`${JSON.stringify(layout)}\0`);
    const ptr = exports.ghostty_wasm_alloc(json.length);
    new Uint8Array(exports.memory.buffer, ptr, json.length).set(json);
    expect(() => new GhosttyModule({ ...exports, ghostty_type_json: () => ptr })).toThrow("GhosttyTerminalOption.SCROLLBACK_MAX_LINES");
  });
});
