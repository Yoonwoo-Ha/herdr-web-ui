import { useT } from "../lib/i18n.ts";
import { retryRestore, useRestoreHeld } from "../lib/pageRestore.ts";

/**
 * The phone app brought this page back whole, and storage refused the unsent text its reload has to keep
 * (lib/pageRestore.ts): the page stays, its text in its fields to copy, and says so, with Reload app as the update
 * notice has it, which reloads once that text is in storage or gone from the page.
 */
export function RestoreNotice() {
  const t = useT();
  const held = useRestoreHeld();
  if (held === 0) return null;
  return (
    <div className="update-notice is-line is-warning" role="status" data-restore-held="">
      <span>{held === 1
        ? t("This page came back without its connection, and this device would not keep its unsent text through a reload. Copy what you need, then reload.")
        : t("The unsent text is still not kept. Copy it or clear it, then reload.")}</span>
      <button type="button" className="btn" onClick={retryRestore}>{t("Reload app")}</button>
    </div>
  );
}
