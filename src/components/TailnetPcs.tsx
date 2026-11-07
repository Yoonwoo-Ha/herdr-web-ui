import { useEffect, useState } from "react";

import { addTailnetPc, ApiError, findTailnetPcs, type TailnetPc } from "../lib/api.ts";
import { type Translate, useT } from "../lib/i18n.ts";
import { codeFailureText, typedCodeFailure } from "./codeFailureText.ts";

/** What a refusal of `POST /api/machines/tailnet` (`tailnet_<failure>`, server/tailnet-pcs.ts) says; null for any other code. */
function tailnetFailureText(t: Translate, code: string | null): string | null {
  switch (code) {
    case "tailnet_not_found": return t("That PC is no longer one of yours on Tailscale. Look again.");
    case "tailnet_not_owner": return t("That PC no longer lets this PC in as its owner. Add it with its code instead.");
    case "tailnet_already_added": return t("That PC is already added.");
    case "tailnet_relay_off": return t("Turn the relay on on that PC first.");
    case "tailnet_relay_offline": return t("That PC's relay cannot be reached right now. Try again in a moment.");
    case "tailnet_code_unavailable": return t("That PC uses its own relay, which cannot give a code. Add it with its QR code instead.");
    case "tailnet_outdated": return t("Update Ovis on that PC to 0.5 to add it in one tap.");
    case "tailnet_unreachable": return t("That PC did not answer. Check that it is on, then try again.");
    case "tailnet_no_code": return t("That PC could not give a code just now. Try again in a moment.");
    case "tailnet_mismatch": return t("The relay found a different PC than the one asked. Nothing was added.");
    default: return null;
  }
}

/**
 * Connect a device → PCs on your Tailscale: other PCs of this PC's own Tailscale login whose Ovis lets this PC in
 * as its owner, each added through the relay with one tap (server/tailnet-pcs.ts). Nothing shows while none is found.
 */
export function TailnetPcs() {
  const t = useT();
  const [pcs, setPcs] = useState<readonly TailnetPc[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ error: boolean; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    findTailnetPcs().then(({ pcs: found }) => { if (live) setPcs(found); }, () => { if (live) setPcs([]); });
    return () => { live = false; };
  }, []);
  const add = async (pc: TailnetPc) => {
    setBusy(pc.url);
    setResult(null);
    try {
      const { machine } = await addTailnetPc(pc.url);
      setPcs((current) => current.filter((other) => other.url !== pc.url));
      setResult({ error: false, text: t("{name} was added. Its workspaces join the sidebar.", { name: machine.name }) });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      const failure = typedCodeFailure(code);
      setResult({ error: true, text: tailnetFailureText(t, code) ?? (failure !== null ? codeFailureText(t, failure) : error instanceof Error ? error.message : String(error)) });
    } finally { setBusy(null); }
  };
  if (pcs.length === 0 && result === null) return null;
  return (
    <div className="connect-way-item tailnet-pcs" data-testid="tailnet-pcs">
      {pcs.length > 0 && <p className="settings-label">{t("PCs on your Tailscale")}</p>}
      {pcs.map((pc) => (
        <div key={pc.url} className="tailnet-pc">
          <span className="tailnet-pc-name">
            {pc.name}
            {pc.outdated ? <span className="settings-hint">{t("Update Ovis on that PC to 0.5 to add it in one tap.")}</span>
              : pc.relay !== "online" && <span className="settings-hint">{t("Turn the relay on on that PC first.")}</span>}
          </span>
          <button type="button" className="btn btn-primary" disabled={busy !== null || pc.relay !== "online" || pc.outdated} aria-busy={busy === pc.url || undefined}
            aria-label={t("Add {name} through the relay", { name: pc.name })} onClick={() => void add(pc)}>{t("Add PC")}</button>
        </div>
      ))}
      {result && <p className="settings-hint" role={result.error ? "alert" : "status"}>{result.text}</p>}
    </div>
  );
}
