import { describe, expect, it } from "bun:test";

import { parseAlertFilters, withAlertFilters } from "./alertFilters.ts";

describe("this device's finer alert choices", () => {
  it("reads only known fields, and anything else as the defaults", () => {
    expect(parseAlertFilters(null)).toEqual({ pcsOff: [] });
    expect(parseAlertFilters("not json")).toEqual({ pcsOff: [] });
    expect(parseAlertFilters("[1]")).toEqual({ pcsOff: [] });
    expect(parseAlertFilters(JSON.stringify({ permission: false, error: true, pcsOff: ["Desk", "Desk", 3] })))
      .toEqual({ permission: false, error: true, pcsOff: ["Desk"] });
  });

  it("sends only the choices made, so a device that made none subscribes as before", () => {
    expect(withAlertFilters({ input: true, done: "long" }, { pcsOff: [] })).toEqual({ input: true, done: "long" });
    expect(withAlertFilters({ input: false, done: "off" }, { permission: true, error: false, pcsOff: ["Home PC"] }))
      .toEqual({ input: false, done: "off", permission: true, error: false, pcs_off: ["Home PC"] });
  });
});
