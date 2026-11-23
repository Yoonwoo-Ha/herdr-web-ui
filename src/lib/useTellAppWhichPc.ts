import { useEffect } from "react";

import { tellAppWhichPc } from "./nativeApp.ts";
import { shellMode } from "./shellMode.ts";

/**
 * The phone app learns which PC this page is (tellAppWhichPc), for the saved PC it opened it as, as the PC's relay ID
 * (its own health's `web_ui.server_id`, "" once a health read names none) and name come in. A relay PC's page on the
 * hosted app is named by its scope.
 */
export function useTellAppWhichPc(serverId: string | undefined, name: string | undefined): void {
  useEffect(() => { if (shellMode() !== "relay") tellAppWhichPc({ serverId, name }); }, [serverId, name]);
}
