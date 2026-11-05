import { CHAT_FONT_MAX, CHAT_FONT_MIN, chatFontSize, fileFontSize, useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsRow, Stepper } from "./SettingsControls.tsx";

/** Settings → Appearance → File text size: a file's own reading size, from the chat's until one is chosen (#2005). */
export function FileTextSizeRow() {
  const { settings, update } = useSettings();
  const t = useT();
  const size = fileFontSize(settings);
  return (
    <SettingsRow label={t("File text size")} description={t("An open file's text, in its preview and its source. Follows the chat font size until you choose one.")} wide>
      <span className="settings-file-size">
        {settings.fileFontSize !== null && <button type="button" className="btn btn-ghost" onClick={() => update({ fileFontSize: null, fileFontFrom: null })}>{t("Reset")}</button>}
        <Stepper label={t("File text size")} value={size} text={`${size}px`} min={CHAT_FONT_MIN} max={CHAT_FONT_MAX} decreaseLabel={t("Decrease file text size")} increaseLabel={t("Increase file text size")} onChange={(next) => update({ fileFontSize: next, fileFontFrom: settings.fileFontSize === null ? chatFontSize(settings) : settings.fileFontFrom })} />
      </span>
    </SettingsRow>
  );
}
