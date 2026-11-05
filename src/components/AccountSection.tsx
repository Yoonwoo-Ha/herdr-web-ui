/**
 * Settings → Phone & devices → Account, in the desktop app: sign in with GitHub or Apple through
 * the system browser, see the account's PCs, sign out. Only where the app names an account service
 * (lib/account/desktop.ts); a browser on the PC's own address has none of this.
 */
import { useCallback, useEffect, useState } from "react";

import { desktopAccount, desktopProviders, desktopSignIn } from "../lib/account/desktop.ts";
import { myPcs, type MyPc } from "../lib/account/myPcs.ts";
import { AccountService, SignedOutError } from "../lib/account/service.ts";
import { indexedAccountStore, type AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { AccountPcList, AccountSignIn } from "./AccountPcs.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";

type View =
  | { kind: "loading" }
  | { kind: "signed-out"; error: string | null }
  | { kind: "signing-in" }
  | { kind: "signed-in"; provider: AccountProvider; pcs: MyPc[] | null; error: string | null };

const PROVIDER_NAMES: Record<AccountProvider, string> = { github: "GitHub", apple: "Apple" };

export function AccountSection() {
  const t = useT();
  const bridge = desktopAccount();
  const [view, setView] = useState<View>({ kind: "loading" });

  const load = useCallback(async () => {
    const service = new AccountService({ store: indexedAccountStore });
    const session = await service.session();
    if (session === undefined) { setView({ kind: "signed-out", error: null }); return; }
    setView({ kind: "signed-in", provider: session.provider, pcs: null, error: null });
    try {
      setView({ kind: "signed-in", provider: session.provider, pcs: myPcs(await service.listPcs(), [], { now: Date.now() }), error: null });
    } catch (error) {
      if (error instanceof SignedOutError) setView({ kind: "signed-out", error: t("Your sign-in ended. Sign in again to see every PC of your account.") });
      else setView({ kind: "signed-in", provider: session.provider, pcs: [], error: t("The account service could not be reached. The PCs this device is paired with still work.") });
    }
  }, [t]);

  useEffect(() => { if (bridge) void load(); }, [bridge !== null, load]);

  if (bridge === null) return null;

  const signIn = (provider: AccountProvider): void => {
    setView({ kind: "signing-in" });
    desktopSignIn(provider, bridge, indexedAccountStore).then(load, (error: unknown) => {
      console.warn("Ovis: the sign-in did not finish", error instanceof Error ? error.name : error);
      setView({ kind: "signed-out", error: t("The sign-in did not finish. Try again.") });
    });
  };

  const signOut = (): void => {
    void new AccountService({ store: indexedAccountStore }).signOut()
      .catch((error: unknown) => console.warn("Ovis: the account service did not confirm the sign-out", error instanceof Error ? error.name : error))
      .finally(() => setView({ kind: "signed-out", error: null }));
  };

  return (
    <SettingsGroup title={t("Account")} section="account">
      {view.kind === "signed-out" && <div className="settings-item"><AccountSignIn onSignIn={signIn} error={view.error} {...(bridge ? { providers: desktopProviders(bridge) } : {})} /></div>}
      {view.kind === "signing-in" && <SettingsRow label={t("Signing in…")} description={t("Finish signing in in your browser.")}>{null}</SettingsRow>}
      {view.kind === "signed-in" && (
        <>
          <SettingsRow label={t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })}>
            <button type="button" className="btn" onClick={signOut}>{t("Sign out")}</button>
          </SettingsRow>
          {view.pcs !== null && <div className="settings-item"><AccountPcList pcs={view.pcs} /></div>}
          {view.error !== null && <p className="settings-condition" role="alert">{view.error}</p>}
        </>
      )}
    </SettingsGroup>
  );
}
