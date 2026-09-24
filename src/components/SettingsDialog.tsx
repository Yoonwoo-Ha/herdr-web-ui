import { useEffect, useRef, useState } from "react";
import { Minus, Plus, X } from "lucide-react";

import "./SettingsDialog.css";

import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { SHORTCUTS, formatKeys } from "../lib/shortcuts.ts";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, chatFontSize, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, useSettings } from "../lib/settings.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import type { MachineSettings } from "../../shared/machines.ts";
import { machineRequest } from "../lib/api.ts";
import { UpdateControls } from "./UpdateControls.tsx";

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  actions: AppActions;
  updates: UpdatesModel;
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" className="settings-toggle" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span className="settings-toggle-thumb" />
    </button>
  );
}

export function SettingsDialog({ open, onClose, updates }: SettingsDialogProps) {
  const { settings, update } = useSettings();
  const installPrompt = useInstallPrompt();
  const firstControlRef = useRef<HTMLButtonElement>(null);
  // server-side: the web server updates PC bridges, so it keeps this choice
  const [pcSettings, setPcSettings] = useState<MachineSettings | null>(null);
  const [pcSettingsError, setPcSettingsError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    machineRequest<MachineSettings>("/settings").then(setPcSettings, () => setPcSettings(null));
  }, [open]);
  const updatePcSettings = async (patch: Partial<MachineSettings>) => {
    try { setPcSettings(await machineRequest<MachineSettings>("/settings", "PATCH", patch)); setPcSettingsError(null); }
    catch (e) { setPcSettingsError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    if (!open) return;
    firstControlRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-header">
          <h2 className="modal-title" id="settings-title">Settings</h2>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}><X /></button>
        </header>
        <div className="modal-body settings-body">
          <section className="settings-section">
            <h3>Appearance</h3>
            <div className="settings-row">
              <div><span className="settings-label">Theme</span><span className="settings-description">Choose the app color scheme</span></div>
              <div className="segmented" aria-label="Theme">
                {(["dark", "light", "system"] as const).map((theme, index) => (
                  <button key={theme} ref={index === 0 ? firstControlRef : undefined} type="button" aria-pressed={settings.theme === theme} onClick={() => update({ theme })}>
                    {theme[0]?.toUpperCase()}{theme.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">Density</span><span className="settings-description">Adjust spacing throughout the interface</span></div>
              <div className="segmented" aria-label="Density">
                {(["comfortable", "compact"] as const).map((density) => (
                  <button key={density} type="button" aria-pressed={settings.density === density} onClick={() => update({ density })}>
                    {density[0]?.toUpperCase()}{density.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">Terminal font size</span><span className="settings-description">Applied to every terminal pane</span></div>
              <div className="settings-stepper" aria-label="Terminal font size">
                <button type="button" className="icon-button" aria-label="Decrease terminal font size" disabled={settings.terminalFontSize <= TERMINAL_FONT_MIN} onClick={() => update({ terminalFontSize: settings.terminalFontSize - 1 })}><Minus /></button>
                <output aria-live="polite">{settings.terminalFontSize}px</output>
                <button type="button" className="icon-button" aria-label="Increase terminal font size" disabled={settings.terminalFontSize >= TERMINAL_FONT_MAX} onClick={() => update({ terminalFontSize: settings.terminalFontSize + 1 })}><Plus /></button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>Composer</h3>
            <div className="settings-row">
              <div><span className="settings-label">Enter sends</span><span className="settings-description">When off, Mod+Enter sends</span></div>
              <Toggle label="Enter sends" checked={settings.enterSends} onChange={(enterSends) => update({ enterSends })} />
            </div>
          </section>

          <section className="settings-section">
            <h3>Chat</h3>
            <div className="settings-row">
              <div><span className="settings-label">Show thinking</span><span className="settings-description">Include the agent's reasoning blocks</span></div>
              <Toggle label="Show thinking" checked={settings.showThinking} onChange={(showThinking) => update({ showThinking })} />
            </div>
            <div className="settings-row">
              <div><span className="settings-label">Chat font size</span><span className="settings-description">Messages, code and prompt cards in the chat view</span></div>
              <div className="settings-stepper" aria-label="Chat font size">
                <button type="button" className="icon-button" aria-label="Decrease chat font size" disabled={chatFontSize(settings) <= CHAT_FONT_MIN} onClick={() => update({ chatFontSize: chatFontSize(settings) - 1 })}><Minus /></button>
                <output aria-live="polite">{chatFontSize(settings)}px</output>
                <button type="button" className="icon-button" aria-label="Increase chat font size" disabled={chatFontSize(settings) >= CHAT_FONT_MAX} onClick={() => update({ chatFontSize: chatFontSize(settings) + 1 })}><Plus /></button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>Shortcuts</h3>
            <table className="settings-shortcuts">
              <tbody>{SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.id}><th scope="row">{shortcut.label}</th><td>{formatKeys(shortcut.keys).map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}</td></tr>
              ))}</tbody>
            </table>
          </section>

          <section className="settings-section">
            <h3>Install</h3>
            {installPrompt.installed ? <p className="settings-hint">Installed</p> : installPrompt.canInstall ? (
              <button type="button" className="btn btn-primary" onClick={() => void installPrompt.install()}>Install app</button>
            ) : <p className="settings-hint">{installPrompt.help}</p>}
          </section>

          <section className="settings-section settings-about">
            <h3>About</h3>
            <p><strong>herdr web ui</strong></p>
            <a href="https://github.com/devswha/herdr-web-ui" target="_blank" rel="noreferrer">github.com/devswha/herdr-web-ui</a>
          </section>
          {pcSettings && <section className="settings-section">
            <h3>Remote PCs</h3>
            <div className="settings-row">
              <div><span className="settings-label">Update PC bridges automatically</span><span className="settings-description">When an app update needs a newer bridge, PCs that connect with their saved key are updated in the background. PCs that need a password ask first.</span></div>
              <Toggle label="Update PC bridges automatically" checked={pcSettings.auto_update_bridges} onChange={(auto_update_bridges) => void updatePcSettings({ auto_update_bridges })} />
            </div>
            {pcSettingsError && <p className="settings-hint" role="alert">{pcSettingsError}</p>}
          </section>}

          <UpdateControls updates={updates} bridgesFollow={pcSettings?.auto_update_bridges === true} />
        </div>
      </section>
    </div>
  );
}
