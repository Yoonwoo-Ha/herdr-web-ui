import { useT } from "../lib/i18n.ts";

export function NoPcOnline({ onCheck }: { readonly onCheck: () => void }) {
  const t = useT();
  return (
    <section className="relay-shell-none-online" data-none-online>
      <h2 className="relay-shell-title">{t("No PC is online")}</h2>
      <p className="relay-shell-copy">{t("Turn on a PC that runs Ovis, then check again.")}</p>
      <div className="relay-shell-actions"><button type="button" className="btn btn-primary" onClick={onCheck}>{t("Check again")}</button></div>
    </section>
  );
}
