import type { PairApprover } from "../../shared/relay-mux.ts";
import type { Translate } from "../lib/i18n.ts";

/** The one line a device waits on while the PC itself approves it on its own screen (a first join), named by its system. */
export function approveOnLine(t: Translate, approveOn: PairApprover): string {
  switch (approveOn) {
    case "mac": return t("Press [Allow] on your Mac");
    case "linux": return t("Press [Allow] on your Linux PC");
    case "windows": case "pc": return t("Press [Allow] on your PC");
    default: {
      const exhaustive: never = approveOn;
      return exhaustive;
    }
  }
}
