import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Pencil, RefreshCw, Trash2, X } from "lucide-react";

import "./DevicesPanel.css";

import { ApiError, fetchDevices, pairDevice, renameDevice, revokeDevice, startPairing } from "../lib/api.ts";
import { deviceLabel } from "../lib/phone.ts";
import type { HealthAuth, PairedDevice, PairingCode } from "../../shared/protocol.ts";
import { QrCode } from "./QrCode.tsx";

const POLL_MS = 3000;

export interface DevicesPanelProps {
  /** an address the phone can open right now (Settings → Phone knows it), for the QR code; null shows the code alone */
  pairUrl: string | null;
  /** how this browser got in */
  auth: HealthAuth | null;
  /** after this browser paired itself: the health check tells the rest of the app */
  onPaired?: () => void;
}

const VIA: Record<NonNullable<HealthAuth["via"]>, string> = {
  local: "You are on the PC itself.",
  tailscale: "You are in as this PC's Tailscale login.",
  device: "This is a paired device.",
  token: "You are in with the access token.",
  open: "This browser is in only because nothing is paired yet: from anywhere that can reach this address, so would anyone.",
};

function lastSeen(value: string | null): string {
  if (value === null) return "never";
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h ago`;
  return new Date(value).toLocaleDateString();
}

/** Settings → Devices: the paired devices, and a code to pair one more. */
export function DevicesPanel({ pairUrl, auth, onPaired }: DevicesPanelProps) {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [left, setLeft] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const known = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const list = await fetchDevices();
      setDevices(list);
      setError(null);
      // a device that appeared while a code was out just paired with it
      const fresh = list.filter((d) => !known.current.has(d.id));
      if (known.current.size > 0 || list.length === 0) for (const d of fresh) { setJustPaired(d.label); setCode(null); }
      known.current = new Set(list.map((d) => d.id));
    } catch (e) {
      setDevices([]);
      setError(e instanceof ApiError && e.status === 404 ? "Devices are managed on a real server." : e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // while a code is out: count it down, and watch for the device it lets in
  useEffect(() => {
    if (code === null) return;
    const tick = () => {
      const ms = Date.parse(code.expires_at) - Date.now();
      if (ms <= 0) { setCode(null); return; }
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    const poll = window.setInterval(() => void load(), POLL_MS);
    return () => { window.clearInterval(timer); window.clearInterval(poll); };
  }, [code, load]);

  const pair = async () => {
    setJustPaired(null);
    try { setCode(await startPairing()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  /** an "open" browser pairs itself: a code, used at once, so the gate closes to everyone else */
  const pairSelf = async () => {
    try {
      const fresh = await startPairing();
      await pairDevice(fresh.code, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0));
      await load();
      onPaired?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const rename = async () => {
    if (!renaming) return;
    try { await renameDevice(renaming.id, renaming.label); setRenaming(null); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const revoke = async (id: string) => {
    if (confirming !== id) { setConfirming(id); window.setTimeout(() => setConfirming((c) => (c === id ? null : c)), 4000); return; }
    setConfirming(null);
    try { await revokeDevice(id); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const spaced = code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : "";
  const qrValue = code && pairUrl ? `${pairUrl.replace(/\/$/, "")}/?pair=${code.code}` : null;

  return (
    <div className="devices-panel">
      {auth?.via !== undefined && <p className={auth.via === "open" ? "settings-hint devices-open" : "settings-description"}>{VIA[auth.via]}</p>}
      {auth?.via === "open" && <div className="phone-actions"><button type="button" className="btn btn-primary" onClick={() => void pairSelf()}>Pair this device now</button></div>}
      <p className="settings-description">A paired device gets in on its own, from anywhere it can reach this server, until you revoke it here. Pairing needs a code from this screen, on the PC or on a device already paired.</p>
      {devices === null ? <p className="settings-hint" role="status">Loading…</p> : devices.length === 0 ? (
        <p className="settings-hint">No devices paired yet.</p>
      ) : (
        <ul className="devices-list">
          {devices.map((d) => (
            <li key={d.id} className="devices-row">
              {renaming?.id === d.id ? (
                <form className="devices-rename" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                  <input className="input" value={renaming.label} maxLength={48} autoFocus aria-label="Device name" onChange={(e) => setRenaming({ id: d.id, label: e.target.value })} />
                  <button type="submit" className="icon-button" aria-label="Save name"><Check /></button>
                  <button type="button" className="icon-button" aria-label="Cancel" onClick={() => setRenaming(null)}><X /></button>
                </form>
              ) : (
                <>
                  <div className="devices-name">
                    <span className="settings-label">{d.label}{d.current && <span className="devices-current">this device</span>}</span>
                    <span className="settings-description">Last seen {lastSeen(d.last_seen_at)}</span>
                  </div>
                  <div className="devices-actions">
                    <button type="button" className="icon-button" aria-label={`Rename ${d.label}`} onClick={() => setRenaming({ id: d.id, label: d.label })}><Pencil /></button>
                    <button type="button" className={`btn ${confirming === d.id ? "btn-danger" : "btn-ghost"}`} onClick={() => void revoke(d.id)}>
                      <Trash2 aria-hidden="true" />{confirming === d.id ? "Revoke?" : "Revoke"}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {justPaired !== null && <p className="settings-hint" role="status">Paired: {justPaired}.</p>}
      {code === null ? (
        <div className="phone-actions"><button type="button" className="btn btn-primary" onClick={() => void pair()} disabled={error !== null && devices?.length === 0 && error.startsWith("Devices are managed")}>Pair a device</button></div>
      ) : (
        <div className="devices-pairing" role="status">
          {qrValue !== null && <QrCode value={qrValue} label={`QR code that pairs a phone with code ${code.code}`} />}
          <div>
            <p className="settings-label">On the other device, enter this code</p>
            <p className="devices-code">{spaced}</p>
            <p className="settings-description">
              {qrValue !== null ? "Or scan the QR code: it opens the app with the code filled in. " : "Open the app's address on that device and enter it. "}
              Expires in {left}.
            </p>
            <div className="phone-actions">
              <button type="button" className="btn" onClick={() => void pair()}><RefreshCw aria-hidden="true" />New code</button>
              <button type="button" className="btn btn-ghost" onClick={() => setCode(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}
