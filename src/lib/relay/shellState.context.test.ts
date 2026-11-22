import { describe, expect, it } from "bun:test";
import { oldDashboardHash } from "./shellState.ts";

describe("the old control page's addresses", () => {
  it("are told from a sign-in's return, a pairing link and the app's own fragments", () => {
    for (const hash of ["#overview", "#pcs", "#pcs?filter=needs&relay=relay-ap.ovis.sh&pc=abc123", "#devices", "#relay", "#settings", "#relay-dash-pcs?pc=abc123", "#my-machines", "#my-machines?machine=abc123"]) expect(oldDashboardHash(hash)).toBe(true);
    for (const hash of ["", "#", "#add", "#offer=private", "#code=private&state=oauth", "#pane=p1", "#sign-in=github", "#overviewx", "#relayed", "#my-machinesx"]) expect(oldDashboardHash(hash)).toBe(false);
  });
});
