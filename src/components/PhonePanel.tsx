import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import "./PhonePanel.css";

import { copyText } from "../lib/clipboard.ts";
import type { PhonePlan } from "../lib/phone.ts";
import { QrCode } from "./QrCode.tsx";

const README_PHONE = "https://github.com/devswha/herdr-web-ui#on-your-phone";
const README_SAFETY = "https://github.com/devswha/herdr-web-ui#access-and-safety";

export interface PhonePanelProps {
  plan: PhonePlan;
  /** the server is still being asked */
  loading: boolean;
  onRefresh: () => void;
}

/** Settings → Phone: the address a phone can open, or the one step still missing on this PC. */
export function PhonePanel({ plan, loading, onRefresh }: PhonePanelProps) {
  return <div className="phone-panel">{loading && plan.kind !== "here" ? <p className="settings-hint" role="status">Asking this PC about Tailscale…</p> : <Plan plan={plan} loading={loading} onRefresh={onRefresh} />}</div>;
}

function Plan({ plan, loading, onRefresh }: PhonePanelProps) {
  const checkAgain = <button type="button" className="btn" onClick={onRefresh} disabled={loading}><RefreshCw aria-hidden="true" />Check again</button>;
  switch (plan.kind) {
    case "here":
    case "served":
      return (
        <>
          <Address url={plan.url} title={plan.kind === "here" ? "Open this address on your phone" : "Tailscale already serves this PC"} />
          <p className="settings-description">Once it is open, install the app and tap the bell for alerts.</p>
          {plan.kind === "served" && <Sharing />}
        </>
      );
    case "command":
      return (
        <>
          <p className="settings-description">In a terminal on this PC, publish the app to your tailnet. Only devices in your tailnet can open the address.</p>
          <Command command={plan.command} />
          {plan.url !== null && <p className="settings-description">It will be at <code>{plan.url}</code>.</p>}
          <div className="phone-actions">{checkAgain}</div>
          <Sharing />
        </>
      );
    case "stopped":
      return (
        <>
          <p className="settings-description">Tailscale is on this PC but not connected. Run <code>tailscale up</code> there, then check again.</p>
          <div className="phone-actions">{checkAgain}</div>
        </>
      );
    case "missing":
      return (
        <>
          <p className="settings-description">Tailscale is the shortest route: <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">install it</a> on this PC, run <code>tailscale up</code>, then check again. An SSH tunnel or your own HTTPS proxy work too: <a href={README_PHONE} target="_blank" rel="noreferrer">On your phone</a>.</p>
          <div className="phone-actions">{checkAgain}</div>
        </>
      );
    default:
      return (
        <>
          <p className="settings-description">This PC did not say how it can be reached. <a href={README_PHONE} target="_blank" rel="noreferrer">On your phone</a> lists the routes.</p>
          <div className="phone-actions">{checkAgain}</div>
        </>
      );
  }
}

function Address({ url, title }: { url: string; title: string }) {
  return (
    <div className="phone-address">
      <QrCode value={url} label={`QR code for ${url}`} />
      <div>
        <p className="settings-label">{title}</p>
        <p className="phone-url"><a href={url} target="_blank" rel="noreferrer">{url}</a></p>
      </div>
    </div>
  );
}

function Command({ command }: { command: string }) {
  const codeRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(command, codeRef.current))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="phone-command">
      <code ref={codeRef}>{command}</code>
      <button type="button" className="btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

function Sharing() {
  return <p className="settings-hint">Your own Tailscale devices get in as you. Anyone else's device, or a LAN or public address, needs pairing: Devices, below. Details in <a href={README_SAFETY} target="_blank" rel="noreferrer">Access and safety</a>.</p>;
}
