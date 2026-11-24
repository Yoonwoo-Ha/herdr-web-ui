import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { demoBuild } from "./demo.ts";

const global = globalThis as { __ovisDemo?: unknown };
afterEach(() => { delete global.__ovisDemo; });

describe("demoBuild", () => {
  it("is the demo only where the demo build marked the page, whatever its address", () => {
    expect(demoBuild()).toBe(false);
    global.__ovisDemo = true;
    expect(demoBuild()).toBe(true);
    for (const value of ["true", 1, {}]) {
      global.__ovisDemo = value;
      expect(demoBuild()).toBe(false);
    }
  });

  it("is marked by the demo's transport, which every demo build loads before the client", () => {
    expect(readFileSync(new URL("../../site/demo/transport.ts", import.meta.url), "utf8")).toContain('Reflect.set(window, "__ovisDemo", true);');
  });
});
