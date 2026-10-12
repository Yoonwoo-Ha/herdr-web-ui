import { useT } from "../lib/i18n.ts";
import type { SplitSide } from "../lib/split.ts";
import "./SplitDropPreview.css";

/** A guide over the pane area; it never takes a drag, focus or space from the terminals. */
export function SplitDropPreview({ visible, side }: { visible: boolean; side: SplitSide | null }) {
  const t = useT();
  return <div className={`split-drop${visible ? " is-visible" : ""}`} data-side={side ?? undefined} aria-hidden="true">
    <div className="split-drop-track">
      <div className="split-drop-target" />
      <div className="split-drop-half"><span className="split-drop-label">{t("Drop on the left")}</span></div>
      <div className="split-drop-half"><span className="split-drop-label">{t("Drop on the right")}</span></div>
    </div>
  </div>;
}
