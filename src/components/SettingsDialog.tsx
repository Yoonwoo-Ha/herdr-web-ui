import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Bell, Check, ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, Gauge, Info, Keyboard, MessageSquare, Mic, Monitor, Palette, Plug, Plus, Smartphone, SquareTerminal, Star, X, type LucideIcon } from "lucide-react";

import "./SettingsDialog.css";

import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { SHORTCUTS, formatKeys, isMacPlatform, shortcutDisplayKeys, shortcutKeys, shortcutConflict } from "../lib/shortcuts.ts";
import { isReservedShortcutKey } from "../lib/shortcutBindings.ts";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, CHAT_WIDTHS, chatFontSize, DEFAULT_SETTINGS, MARKDOWN_WIDTHS, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, TERMINAL_WHEEL_SPEED_MAX, TERMINAL_WHEEL_SPEED_MIN, TERMINAL_CURSOR_STYLES, DICTATION_LANGUAGES, VOICE_BUTTONS, useSettings, forgetPaneViews, type DictationLanguage, type TerminalCursorStyle, type VoiceButton } from "../lib/settings.ts";
import { LANGUAGE_NAMES, LANGUAGE_SETTINGS, useLocale, useT } from "../lib/i18n.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { KeyBarSettings } from "./KeyBarSettings.tsx";
import { onSettingsHistory, recordSettings, settingsEntry, settingsLevels, type SettingsLevel } from "../lib/settingsHistory.ts";
import { Segmented, SettingsGroup, SettingsRow, Stepper, Toggle } from "./SettingsControls.tsx";
import { FONT_FAMILY_MAX_CHARS, sanitizeFontFamily } from "../lib/fontFamily.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import type { MachineSettings } from "../../shared/machines.ts";
import { fetchRemoteAccess, fetchVoiceStatus, machineRequest, saveVoiceConfig } from "../lib/api.ts";
import { isLoopbackHost, phonePlan } from "../lib/phone.ts";
import type { AgentIntegration, HealthAuth, PluginActions, ProviderUsage, RemoteAccess } from "../../shared/protocol.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { loadIntegrations, outcomeFor, type IntegrationsResult } from "../lib/integrations.ts";
import type { VoiceStatus } from "../../shared/voice.ts";
import { dictationLocale, VOICE_CONFIG_EVENT } from "../lib/voice.ts";
import { moveInOrder, orderProviders, PROVIDER_MARK, PROVIDER_NAME, usageName, useUsage } from "../lib/usage.ts";
import { AgentMark } from "./AgentMark.tsx";
import { DevicesPanel } from "./DevicesPanel.tsx";
import { PhonePanel } from "./PhonePanel.tsx";
import { copyText } from "../lib/clipboard.ts";
import { PushTestControls } from "./PushTestControls.tsx";
import { previewAlertSound, unlockAlertSound } from "../lib/alertSound.ts";
import { HerdrUpdateControls, UpdateControls } from "./UpdateControls.tsx";
import { TelemetryControls } from "./TelemetryControls.tsx";
import { useSheetSwipe } from "../lib/sheets.ts";

export interface SettingsDialogProps {
  open: boolean;
  /** the section to open on, for a button that points at it; the top otherwise */
  section?: "updates" | null;
  /** the page a link to Settings names (`?settings=`, lib/deepLink.ts), for this opening alone */
  linkPage?: string | null;
  /** the group on that page a link names (`&section=`): it is scrolled to and focused, as Updates is */
  linkSection?: string | null;
  /** the page shown, for the address; null while a phone shows its list of pages */
  onPage?: (page: string | null) => void;
  onClose: () => void;
  actions: AppActions;
  updates: UpdatesModel;
  /** how this browser got in, from the last health check */
  auth: HealthAuth | null;
  /** the herdr this app's server talks to, from the last health check */
  herdrVersion: string | null;
  onEnableNotifications: () => Promise<boolean>;
  /** a file preview is open beneath: the dialog is drawn above it */
  overPreview?: boolean;
}

function compactKeys(keys: readonly string[]): string {
  return formatKeys(keys).map((key) => ({ Shift: "⇧", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[key] ?? (key.length === 1 ? key.toUpperCase() : key))).join("+");
}

const FONT_FAMILY_PLACEHOLDER = 'D2Coding, "Cascadia Mono"';

/**
 * A font family list, saved when the field is left, on Enter or when the dialog closes: saving
 * every keystroke would sanitize away the comma or space being typed, and each change of the
 * terminal's font refits the grid and resizes the pane.
 */
function FontFamilyInput({ value, label, onCommit }: { value: string; label: string; onCommit: (family: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    const next = sanitizeFontFamily(draft);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  // closing the dialog with Escape unmounts the field without a blur
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);
  return (
    <input
      className="input settings-font-input"
      value={draft}
      placeholder={FONT_FAMILY_PLACEHOLDER}
      maxLength={FONT_FAMILY_MAX_CHARS}
      aria-label={label}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        // an IME keeps its Enter, including the committing one WebKit can send after compositionend as key code 229
        if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        commit();
      }}
    />
  );
}


type SettingsPage = "appearance" | "chat" | "terminal" | "alerts" | "voice" | "usage" | "shortcuts" | "devices" | "remote" | "integrations" | "about";

/** The pages in the order the list shows them: what is looked at first, then what is set once. */
const PAGES: readonly { id: SettingsPage; icon: LucideIcon }[] = [
  { id: "appearance", icon: Palette },
  { id: "chat", icon: MessageSquare },
  { id: "terminal", icon: SquareTerminal },
  { id: "alerts", icon: Bell },
  { id: "voice", icon: Mic },
  { id: "usage", icon: Gauge },
  { id: "shortcuts", icon: Keyboard },
  { id: "devices", icon: Smartphone },
  { id: "remote", icon: Monitor },
  { id: "integrations", icon: Plug },
  { id: "about", icon: Info },
];

/** The sheet's own breakpoint (`.modal`, styles.css): under it the list and a page take turns. */
const NARROW_QUERY = "(max-width: 640px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(NARROW_QUERY);
    if (!media) return;
    const refresh = () => setNarrow(media.matches);
    refresh();
    media.addEventListener("change", refresh);
    return () => media.removeEventListener("change", refresh);
  }, []);
  return narrow;
}

/** What a Settings entry of the history shows, when it names a page this version has. */
function shownBy(entry: SettingsLevel | null): { page: SettingsPage | null; keyBar: boolean } | null {
  if (entry === null) return null;
  const page = PAGES.find(({ id }) => id === entry.page)?.id ?? null;
  return page === null && entry.page !== null ? null : { page, keyBar: entry.keyBar && page === "terminal" };
}

function AppearancePage() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsGroup>
      <SettingsRow label={t("Theme")} wide>
        <Segmented label={t("Theme")} value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: "dark", label: t("Dark") }, { value: "light", label: t("Light") }, { value: "system", label: t("System") }]} />
      </SettingsRow>
      <SettingsRow label={t("Colors")} htmlFor="settings-palette">
        <select id="settings-palette" className="select settings-select" value={settings.palette} onChange={(event) => update({ palette: event.target.value as typeof settings.palette })}>
          <option value="amber">{t("Amber")}</option>
          <option value="report">{t("Dark report")}</option>
          <option value="charcoal">{t("Charcoal")}</option>
          <option value="catppuccin">{t("Catppuccin")}</option>
          <option value="lilac">{t("Lilac")}</option>
          <option value="forest">{t("Forest")}</option>
        </select>
      </SettingsRow>
      <SettingsRow label={t("Density")}>
        <Segmented label={t("Density")} value={settings.density} onChange={(density) => update({ density })} options={[{ value: "comfortable", label: t("Comfortable") }, { value: "compact", label: t("Compact") }]} />
      </SettingsRow>
      <SettingsRow label={t("Language")} description={t("Follows the browser unless you choose one")} htmlFor="settings-language">
        <select id="settings-language" className="select settings-select" value={settings.language} onChange={(event) => update({ language: event.target.value as typeof settings.language })}>
          {LANGUAGE_SETTINGS.map((language) => <option key={language} value={language}>{language === "system" ? t("System") : LANGUAGE_NAMES[language]}</option>)}
        </select>
      </SettingsRow>
      <SettingsRow label={t("Sidebar rows")} description={t("Name each workspace on one line, or show what its agent is doing with the workspace under it")} wide>
        <Segmented label={t("Sidebar rows")} value={settings.sidebarRows} onChange={(sidebarRows) => update({ sidebarRows })} options={[{ value: "one", label: t("One line") }, { value: "two", label: t("Two lines") }]} />
      </SettingsRow>
      <SettingsRow label={t("Agents order")} description={t("Activity keeps a waiting agent on top, then the one that changed last; herdr's own order is not changed")} wide>
        <Segmented label={t("Agents order")} value={settings.agentOrder} onChange={(agentOrder) => update({ agentOrder })} options={[{ value: "workspace", label: t("Workspaces") }, { value: "activity", label: t("Activity") }]} />
      </SettingsRow>
      <SettingsRow label={t("Workspace cards")} description={t("In the Workspaces order, put each workspace's agents in a card under the workspace's name")}>
        <Toggle label={t("Workspace cards")} checked={settings.agentCards} onChange={(agentCards) => update({ agentCards })} />
      </SettingsRow>
      <SettingsRow label={t("Pin agents")} description={t("Show a star beside each agent that keeps it at the top of the Agents list")}>
        <Toggle label={t("Pin agents")} checked={settings.agentPins} onChange={(agentPins) => update({ agentPins })} />
      </SettingsRow>
      <SettingsRow label={t("Quiet opened finishes")} description={t("A finished agent you have opened here loses its dot, as herdr's own view would clear it; remembered per PC on this browser")}>
        <Toggle label={t("Quiet opened finishes")} checked={settings.quietOpenedDone} onChange={(quietOpenedDone) => update({ quietOpenedDone })} />
      </SettingsRow>
      <SettingsRow label={t("Agent logos")} description={t("Draw each agent's logo in its brand colors, or without color")} wide>
        <Segmented label={t("Agent logos")} value={settings.agentMarks} onChange={(agentMarks) => update({ agentMarks })} options={[{ value: "color", label: t("Color") }, { value: "mono", label: t("Mono") }]} />
      </SettingsRow>
    </SettingsGroup>
  );
}

function ChatPage() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("Panes open in")} description={t("Every pane on this device. Switching a pane's lens keeps it there until this changes. Auto: chat for an agent on a touch screen, else the terminal.")} wide>
          <Segmented label={t("Panes open in")} value={settings.defaultView} options={[{ value: "auto", label: t("Auto") }, { value: "chat", label: t("Chat") }, { value: "terminal", label: t("Terminal") }]} onChange={(defaultView) => {
            if (settings.defaultView === defaultView) return;
            // one choice for every pane: what each one remembered gives way to it
            forgetPaneViews();
            update({ defaultView });
          }} />
        </SettingsRow>
        <SettingsRow label={t("Show thinking")} description={t("Include the agent's reasoning blocks")}>
          <Toggle label={t("Show thinking")} checked={settings.showThinking} onChange={(showThinking) => update({ showThinking })} />
        </SettingsRow>
        <SettingsRow label={t("Chat width")} description={t("How wide the conversation and the message box run on a large screen")} wide>
          <Segmented label={t("Chat width")} value={settings.chatWidth} onChange={(chatWidth) => update({ chatWidth })} options={CHAT_WIDTHS.map((chatWidth) => ({ value: chatWidth, label: t(chatWidth === "narrow" ? "Narrow" : chatWidth === "wide" ? "Wide" : chatWidth === "full" ? "Full" : "Default") }))} />
        </SettingsRow>
        <SettingsRow label={t("Chat font size")} description={t("Messages, code, prompt cards and the message box in the chat view")}>
          <Stepper label={t("Chat font size")} value={chatFontSize(settings)} text={`${chatFontSize(settings)}px`} min={CHAT_FONT_MIN} max={CHAT_FONT_MAX} decreaseLabel={t("Decrease chat font size")} increaseLabel={t("Increase chat font size")} onChange={(size) => update({ chatFontSize: size })} />
        </SettingsRow>
        <SettingsRow label={t("Chat font")} description={t("Message text; code stays monospace. Comma-separated, tried in order. A font this device does not have falls back to the default.")} wide>
          <FontFamilyInput value={settings.chatFontFamily} label={t("Chat font")} onCommit={(chatFontFamily) => update({ chatFontFamily })} />
        </SettingsRow>
        <SettingsRow label={t("Highlight code")} description={t("Colors code by its language. Off, code is plain text.")}>
          <Toggle label={t("Highlight code")} checked={settings.highlightCode} onChange={(highlightCode) => update({ highlightCode })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Composer")} section="composer">
        <SettingsRow label={t("Enter sends")} description={t("When off, Mod+Enter sends")}>
          <Toggle label={t("Enter sends")} checked={settings.enterSends} onChange={(enterSends) => update({ enterSends })} />
        </SettingsRow>
        <SettingsRow label={t("Send queued messages automatically")} description={t("A message sent while the agent works goes by itself when the turn ends. When off, it waits until you press Send now.")}>
          <Toggle label={t("Send queued messages automatically")} checked={settings.autoSendQueued} onChange={(autoSendQueued) => update({ autoSendQueued })} />
        </SettingsRow>
        <SettingsRow label={t("Suggestion chip")} description={t("On a touch screen, a chip above the message box puts the prompt Claude Code suggests next into the box. With a keyboard, Tab does it.")}>
          <Toggle label={t("Suggestion chip")} checked={settings.showSuggestionChip} onChange={(showSuggestionChip) => update({ showSuggestionChip })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Quick replies")} section="quick-replies">
        <SettingsRow label={t("Show above the message box")} description={t("One-tap messages above the message box, on this device. Each is sent as if typed: queued while the agent works, an answer when a question is open.")}>
          <Toggle label={t("Show above the message box")} checked={settings.showQuickReplies} onChange={(showQuickReplies) => update({ showQuickReplies })} />
        </SettingsRow>
        <div className="settings-item">
          <ol className="quick-replies-list">
            {settings.quickReplies.map((reply, index) => (
              <li key={index}>
                <input
                  className="input"
                  value={reply}
                  maxLength={QUICK_REPLY_MAX_CHARS}
                  aria-label={t("Quick reply {number}", { number: index + 1 })}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => update({ quickReplies: settings.quickReplies.map((current, at) => at === index ? event.target.value : current) })}
                />
                <button type="button" className="icon-button" aria-label={t("Remove quick reply {number}", { number: index + 1 })} onClick={() => update({ quickReplies: settings.quickReplies.filter((_, at) => at !== index) })}>
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <div className="settings-actions">
            <button type="button" className="btn" disabled={settings.quickReplies.length >= QUICK_REPLIES_MAX} onClick={() => update({ quickReplies: [...settings.quickReplies, ""] })}><Plus aria-hidden="true" />{t("Add reply")}</button>
            <button type="button" className="btn btn-ghost" onClick={() => update({ quickReplies: [...DEFAULT_SETTINGS.quickReplies] })}>{t("Restore defaults")}</button>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("File viewer")}>
        <SettingsRow label={t("Wrap long lines")}>
          <Toggle label={t("Wrap long lines")} checked={settings.wrapCode} onChange={(wrapCode) => update({ wrapCode })} />
        </SettingsRow>
        <SettingsRow label={t("Markdown width")}>
          {/* literal keys, so the i18n check finds them */}
          <Segmented label={t("Markdown width")} value={settings.markdownWidth} onChange={(markdownWidth) => update({ markdownWidth })} options={MARKDOWN_WIDTHS.map((markdownWidth) => ({ value: markdownWidth, label: markdownWidth === "full" ? t("Full width") : t("Default") }))} />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function TerminalPage({ keyBarButtonRef, onEditKeyBar }: { keyBarButtonRef: RefObject<HTMLButtonElement>; onEditKeyBar: () => void }) {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsGroup>
      <SettingsRow label={t("Terminal font size")} description={t("Applied to every terminal pane")}>
        <Stepper label={t("Terminal font size")} value={settings.terminalFontSize} text={`${settings.terminalFontSize}px`} min={TERMINAL_FONT_MIN} max={TERMINAL_FONT_MAX} decreaseLabel={t("Decrease terminal font size")} increaseLabel={t("Increase terminal font size")} onChange={(terminalFontSize) => update({ terminalFontSize })} />
      </SettingsRow>
      <SettingsRow label={t("Fit 80 columns in a split pane")} description={t("A split pane narrower than 80 columns draws in a smaller font, down to 10px, so a program that needs 80 columns still fits. Turn it off to keep your font size in every pane.")}>
        <Toggle label={t("Fit 80 columns in a split pane")} checked={settings.narrowPaneFont} onChange={(narrowPaneFont) => update({ narrowPaneFont })} />
      </SettingsRow>
      <SettingsRow label={t("Terminal font")} description={t("Comma-separated, tried in order. A font this device does not have falls back to the default.")} wide>
        <FontFamilyInput value={settings.terminalFontFamily} label={t("Terminal font")} onCommit={(terminalFontFamily) => update({ terminalFontFamily })} />
      </SettingsRow>
      <SettingsRow label={t("Cursor shape")} description={t("A program in the pane can still change this with its own cursor control sequence")} wide>
        <Segmented label={t("Cursor shape")} value={settings.terminalCursorStyle} onChange={(terminalCursorStyle: TerminalCursorStyle) => update({ terminalCursorStyle })}
          options={TERMINAL_CURSOR_STYLES.map((style) => ({ value: style, label: t(style === "block" ? "Block" : style === "bar" ? "Bar" : "Underline") }))} />
      </SettingsRow>
      <SettingsRow label={t("Blinking cursor")}>
        <Toggle label={t("Blinking cursor")} checked={settings.terminalCursorBlink} onChange={(terminalCursorBlink) => update({ terminalCursorBlink })} />
      </SettingsRow>
      <SettingsRow label={t("Wheel scroll speed")} description={t("How far one turn of the wheel scrolls the terminal")}>
        <Stepper label={t("Wheel scroll speed")} value={settings.terminalWheelSpeed} text={`${settings.terminalWheelSpeed}×`} min={TERMINAL_WHEEL_SPEED_MIN} max={TERMINAL_WHEEL_SPEED_MAX} decreaseLabel={t("Slower wheel scrolling")} increaseLabel={t("Faster wheel scrolling")} onChange={(terminalWheelSpeed) => update({ terminalWheelSpeed })} />
      </SettingsRow>
      <SettingsRow label={t("Terminal input mode")} htmlFor="terminal-input-mode">
        <select id="terminal-input-mode" className="select settings-select" value={settings.terminalInputMode} onChange={(event) => update({ terminalInputMode: event.target.value as "auto" | "line" | "direct" })}>
          <option value="auto">{t("Automatic")}</option><option value="line">{t("Input line")}</option><option value="direct">{t("Direct typing")}</option>
        </select>
      </SettingsRow>
      <SettingsRow label={t("Key bar")} description={t("Keys, order and custom combinations for the terminal.")}>
        <button type="button" ref={keyBarButtonRef} className="btn" onClick={onEditKeyBar}>{t("Edit key bar")}</button>
      </SettingsRow>
      <SettingsRow label={t("Clipboard from a pane")} description={t("A program in a pane that copies (vim, tmux, Claude Code) puts its text on this device's clipboard, as a copy you made yourself would. Turn it off if a pane runs output you do not trust: it could replace what you paste next.")}>
        <Toggle label={t("Clipboard from a pane")} checked={settings.paneClipboard} onChange={(paneClipboard) => update({ paneClipboard })} />
      </SettingsRow>
      <SettingsRow label={t("Use alongside herdr's own window")} description={t("Turn this on if this PC also shows herdr in a terminal window. A second after you switch to another window, this tab only watches the pane, so herdr's window keeps the pane at its own size instead of this window's. Click the tab to type again. While it watches, the pane is drawn at herdr's size and may not fill this window.")}>
        <Toggle label={t("Use alongside herdr's own window")} checked={settings.releasePaneAway} onChange={(releasePaneAway) => update({ releasePaneAway })} />
      </SettingsRow>
    </SettingsGroup>
  );
}

function AlertsPage({ onEnableNotifications }: { onEnableNotifications: () => Promise<boolean> }) {
  const { settings, update } = useSettings();
  const t = useT();
  // the Sound switch as last set: the preview waits for the audio, and must not play once it is off
  const alertSoundWanted = useRef(settings.alertSound);
  return (
    <SettingsGroup note={t("For this device. An alert waits a little first, and none comes when the pane changes meanwhile, as when you answer at the PC.")}>
      <PushTestControls onEnable={onEnableNotifications} />
      <SettingsRow label={t("Needs input")} description={t("An agent waits for an answer or a permission")}>
        <Toggle label={t("Needs input")} checked={settings.alertInput} onChange={(alertInput) => update({ alertInput })} />
      </SettingsRow>
      <SettingsRow label={t("Finished")} description={t("Long turns: only work that took a minute or more")} wide>
        <Segmented label={t("Finished")} value={settings.alertDone} onChange={(alertDone) => update({ alertDone })} options={[{ value: "off", label: t("Off") }, { value: "long", label: t("Long turns") }, { value: "always", label: t("Every turn") }]} />
      </SettingsRow>
      <SettingsRow label={t("In the app")} description={t("While the app is open, these drop in from the top of the screen at once. Tap one to open its pane.")}>
        <Toggle label={t("In the app")} checked={settings.alertInApp} onChange={(alertInApp) => update({ alertInApp })} />
      </SettingsRow>
      <SettingsRow label={t("Sound")} description={t("While a tab of the app is open, it chimes for these alerts, also when a Focus or Do Not Disturb silences notifications.")}>
        <Toggle label={t("Sound")} checked={settings.alertSound} onChange={(alertSound) => {
          update({ alertSound });
          alertSoundWanted.current = alertSound;
          // this tap is the gesture the page needs to play audio; the chime is the preview,
          // unless the switch went off again while the audio was getting ready
          if (alertSound) void unlockAlertSound().then((ready) => { if (ready && alertSoundWanted.current) previewAlertSound(); });
        }} />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** A language tag's name in the UI language (`hu-HU` is "Hungarian (Hungary)"), or the tag where the browser cannot name it. */
function languageName(names: Intl.DisplayNames | null, tag: string): string {
  try { return names?.of(tag) ?? tag; } catch { return tag; }
}

function DictationLanguageSelect() {
  const { settings, resolvedLanguage, update } = useSettings();
  const t = useT();
  const locale = useLocale();
  const names = useMemo(() => { try { return new Intl.DisplayNames([locale], { type: "language" }); } catch { return null; } }, [locale]);
  const auto = languageName(names, dictationLocale("auto", settings.language, resolvedLanguage, navigator.languages));
  const choices = useMemo(() => DICTATION_LANGUAGES.map((tag) => ({ tag, name: languageName(names, tag) })).sort((a, b) => a.name.localeCompare(b.name, locale)), [names, locale]);
  return (
    <select id="settings-voice-language" className="select settings-select" value={settings.voiceLanguage} onChange={(event) => update({ voiceLanguage: event.target.value as DictationLanguage })}>
      <option value="auto">{t("Auto ({language})", { language: auto })}</option>
      {choices.map(({ tag, name }) => <option key={tag} value={tag}>{name}</option>)}
    </select>
  );
}

function VoicePage() {
  const { settings, update } = useSettings();
  const t = useT();
  // the server only says whether it holds a key; the key typed here is never kept past a save
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [voiceKey, setVoiceKey] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [micDenied, setMicDenied] = useState(false);
  useEffect(() => { fetchVoiceStatus().then(setVoice, () => setVoice(null)); }, []);
  /** On asks now, so the first dictation does not stop at the browser's permission prompt */
  const chooseVoiceInput = async (voiceInput: VoiceButton) => {
    update({ voiceInput });
    setMicDenied(false);
    if (voiceInput !== "on" || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return;
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((track) => track.stop()); }
    catch { setMicDenied(true); }
  };
  const changeVoiceKey = async (api_key: string | null) => {
    setVoiceBusy(true);
    try {
      // the save answers the new status itself: no second request that could fail after it
      const saved = await saveVoiceConfig({ api_key });
      setVoiceKey("");
      setVoiceError(null);
      setVoice(saved);
      window.dispatchEvent(new Event(VOICE_CONFIG_EVENT));
    } catch (e) { setVoiceError(e instanceof Error ? e.message : String(e)); }
    finally { setVoiceBusy(false); }
  };
  const micProblem = settings.voiceInput === "off" ? null : !window.isSecureContext ? t("Voice input needs HTTPS") : micDenied ? t("Microphone permission was denied") : null;
  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("Microphone button")} description={<>{t("Auto: in the chat on a desktop, where dictation can work. On: on a phone and in the terminal input line too.")}{micProblem !== null && <span className="voice-error">{micProblem}</span>}</>} wide>
          <Segmented label={t("Microphone button")} value={settings.voiceInput} onChange={(voiceInput) => void chooseVoiceInput(voiceInput)} options={VOICE_BUTTONS.map((voiceInput) => ({ value: voiceInput, label: t(voiceInput === "auto" ? "Auto" : voiceInput === "on" ? "On" : "Off") }))} />
        </SettingsRow>
        {settings.voiceInput !== "off" && (
          <SettingsRow label={t("Dictation language")} description={t("Auto listens for the app's language, or for the browser's when the app is not translated into it")} htmlFor="settings-voice-language">
            <DictationLanguageSelect />
          </SettingsRow>
        )}
      </SettingsGroup>

      {settings.voiceInput !== "off" && (
        <SettingsGroup title={t("Tidy dictated text")} section="tidy-dictation">
          <SettingsRow label={t("In chat")} description={t("Drops fillers and fixes spacing; code and paths stay as spoken")}>
            <Toggle label={t("Tidy dictated text in chat")} checked={settings.voicePolishChat} onChange={(voicePolishChat) => update({ voicePolishChat })} />
          </SettingsRow>
          <SettingsRow label={t("In the terminal")} description={t("Off keeps a command exactly as transcribed")}>
            <Toggle label={t("Tidy dictated text in the terminal")} checked={settings.voicePolishTerminal} onChange={(voicePolishTerminal) => update({ voicePolishTerminal })} />
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup title={t("OpenAI API key")} section="openai-key">
        <div className="settings-item">
          {voice && (
            <p className="settings-label voice-status">
              {voice.configured ? t(voice.source === "env" ? "OpenAI key set by HERDR_WEB_OPENAI_API_KEY" : "OpenAI key saved on this PC") : t("No OpenAI key: the browser's speech recognition is used")}
            </p>
          )}
          {voice && voice.source !== "env" && (
            <form className="voice-key" onSubmit={(event) => { event.preventDefault(); if (voiceKey.trim()) void changeVoiceKey(voiceKey.trim()); }}>
              <input
                className="input voice-key-input"
                type="password"
                value={voiceKey}
                placeholder="sk-..."
                aria-label={t("OpenAI API key")}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setVoiceKey(event.target.value)}
              />
              <button type="submit" className="btn voice-key-save" disabled={voiceBusy || !voiceKey.trim()}>{t("Save key")}</button>
              <button type="button" className="btn btn-ghost voice-key-remove" disabled={voiceBusy || !voice.configured} onClick={() => void changeVoiceKey(null)}>{t("Remove key")}</button>
            </form>
          )}
          {voiceError && <p className="settings-hint voice-error" role="alert">{voiceError}</p>}
          <p className="settings-hint voice-privacy">
            {voice && !voice.configured
              ? t("Without a key the browser recognizes the speech: Chrome and Edge send the audio to Google or Microsoft. Nothing is recorded until you press the mic.")
              : t("Audio is sent to OpenAI with your key. Nothing is recorded until you press the mic.")}
          </p>
        </div>
      </SettingsGroup>
    </>
  );
}

/**
 * The accounts the plan meters know, in the strip's order: each row names the account and
 * carries its move up / move down and show / hide controls.
 */
function UsageAccounts({ providers }: { providers: readonly ProviderUsage[] }) {
  const { settings, update } = useSettings();
  const t = useT();
  const ordered = orderProviders(providers, settings.usageOrder);
  const keys = ordered.map((usage) => usage.key);
  const move = (key: string, by: -1 | 1) => update({ usageOrder: moveInOrder(keys, settings.usageOrder, key, by) });
  return (
    <SettingsGroup title={t("Accounts")} className="usage-accounts" section="accounts">
      <ol aria-label={t("Accounts")}>
        {ordered.map((usage, index) => {
          const name = usageName(usage);
          const hidden = settings.usageHidden.includes(usage.key);
          return (
            <li key={usage.key} className={`usage-accounts-row${hidden ? " is-hidden" : ""}`}>
              <AgentMark agent={PROVIDER_MARK[usage.id]} size={16} />
              <span className="usage-accounts-name">{PROVIDER_NAME[usage.id]}</span>
              <span className="usage-accounts-account" title={usage.account ?? undefined}>{usage.account}</span>
              <span className="usage-accounts-actions">
                <button type="button" className="icon-button" aria-label={t("Move {name} up", { name })} title={t("Move {name} up", { name })} disabled={index === 0} onClick={() => move(usage.key, -1)}><ChevronUp aria-hidden="true" /></button>
                <button type="button" className="icon-button" aria-label={t("Move {name} down", { name })} title={t("Move {name} down", { name })} disabled={index === ordered.length - 1} onClick={() => move(usage.key, 1)}><ChevronDown aria-hidden="true" /></button>
                <button
                  type="button"
                  className="icon-button usage-accounts-visibility"
                  role="switch"
                  aria-checked={!hidden}
                  aria-label={t("Show {name}", { name })}
                  title={t("Show {name}", { name })}
                  onClick={() => update({ usageHidden: hidden ? settings.usageHidden.filter((key) => key !== usage.key) : [...settings.usageHidden, usage.key] })}
                >
                  {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </button>
              </span>
            </li>
          );
        })}
      </ol>
    </SettingsGroup>
  );
}

function UsagePage() {
  const { settings, update } = useSettings();
  const t = useT();
  // the accounts to order and hide: the same report the meters show, from the server's cache
  const usage = useUsage(settings.showUsage);
  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("Show plan limits")} description={t("Beside Settings, how much of each plan the AI tools on the server's PC have used. Turning it on sends their sign-ins to each provider's usage endpoint; they are never refreshed here.")}>
          <Toggle label={t("Show plan limits")} checked={settings.showUsage} onChange={(showUsage) => update({ showUsage })} />
        </SettingsRow>
        {settings.showUsage && <>
          <SettingsRow label={t("Meters show")}>
            <Segmented label={t("Meters show")} value={settings.usageCount} onChange={(usageCount) => update({ usageCount })} options={[{ value: "used", label: t("Used") }, { value: "left", label: t("Remaining") }]} />
          </SettingsRow>
          <SettingsRow label={t("Limit shown")} description={t("The limit each chip shows. Session is the short one, 5 hours on Claude and Codex. A plan without the chosen limit shows the one closest to running out.")} wide>
            <Segmented label={t("Limit shown")} value={settings.usageGlance} onChange={(usageGlance) => update({ usageGlance })} options={[{ value: "week", label: t("Weekly") }, { value: "session", label: t("Session") }]} />
          </SettingsRow>
          <SettingsRow label={t("Show pace")} description={t("On each limit, a mark where an even pace would be by now, the rate so far, and a warning when it runs out before its reset. Claude, Codex and Grok only.")}>
            <Toggle label={t("Show pace")} checked={settings.usagePace} onChange={(usagePace) => update({ usagePace })} />
          </SettingsRow>
        </>}
      </SettingsGroup>
      {settings.showUsage && usage.report && usage.report.providers.length > 0 && <UsageAccounts providers={usage.report.providers} />}
    </>
  );
}

/**
 * herdr's own integrations (`integration.list`), read only: installing one writes into an agent's
 * hooks or settings, which this app leaves to the user, so a row shows the command to run instead.
 */
function IntegrationsPage() {
  const t = useT();
  const api = useMachineApi();
  const machineId = useMachineId();
  const [result, setResult] = useState<IntegrationsResult | null>(null);
  useEffect(() => {
    let live = true;
    void loadIntegrations(api.fetchIntegrations).then((outcome) => { if (live) setResult({ machineId, outcome }); });
    return () => { live = false; };
  }, [api, machineId]);
  const outcome = outcomeFor(result, machineId);
  const note = t("herdr's integrations let it resume each agent's session after a restart. This page only reads them: run a command in a terminal on the PC herdr runs on, then reopen this page.");
  if (outcome === null) return <SettingsGroup note={note}><p className="settings-item settings-hint" role="status">{t("Loading…")}</p></SettingsGroup>;
  if (outcome.kind === "unsupported") return <SettingsGroup><p className="settings-item settings-hint" role="status">{t("This PC's bridge does not offer agent integrations yet. It will after its next runtime update.")}</p></SettingsGroup>;
  if (outcome.kind === "error") return <SettingsGroup note={note}><p className="settings-item settings-hint" role="alert">{outcome.message}</p></SettingsGroup>;
  const { integrations } = outcome;
  // agents on the PC's PATH first, in herdr's order: the rest can wait until one is installed
  const groups = [
    { title: undefined, rows: integrations.filter((integration) => integration.available) },
    { title: t("Not found on this PC"), rows: integrations.filter((integration) => !integration.available) },
  ].filter((group) => group.rows.length > 0);
  return (
    <>
      {groups.map((group, index) => (
        <SettingsGroup key={group.title ?? "found"} title={group.title} note={index === 0 ? note : undefined}>
          {group.rows.map((integration) => <IntegrationRow key={integration.target} integration={integration} />)}
        </SettingsGroup>
      ))}
    </>
  );
}

function IntegrationRow({ integration }: { integration: AgentIntegration }) {
  const t = useT();
  const commandRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  // the latest Copy owns the label: an earlier press's timer must not clear it early
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const name = integration.label;
  if (integration.state === "current") {
    return (
      <SettingsRow label={name} description={t("Installed")}>
        <Check className="settings-integration-check" aria-hidden="true" />
      </SettingsRow>
    );
  }
  // the label is the name `herdr integration install` takes (antigravity_cli is antigravity-cli)
  const command = `herdr integration install ${name}`;
  const copy = async (): Promise<void> => {
    if (!(await copyText(command, commandRef.current))) return;
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  const state = integration.state === "outdated" ? t("Installed, but older than this herdr: run this to update it") : t("Not installed");
  return (
    <SettingsRow label={name} description={<>{state}<code ref={commandRef} className="settings-integration-command">{command}</code></>}>
      <button type="button" className="btn" aria-label={t("Copy the command for {name}", { name })} onClick={() => void copy()}>{t(copied ? "Copied" : "Copy")}</button>
    </SettingsRow>
  );
}

const SHORTCUT_KEYS: readonly string[] = [..."abcdefghijklmnopqrstuvwxyz0123456789,", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

function ShortcutsPage() {
  const { settings, update } = useSettings();
  const t = useT();
  const platformIsMac = isMacPlatform();
  return (
    <>
      <SettingsGroup className="settings-shortcuts" section="shortcuts" note={<>{t("Bindings apply to this browser and device; Mod+Shift is fixed.")} {t("Text selection in focused fields stays native; Tab/list keys are UI-local, not global shortcuts.")} {t("The mobile key bar sends terminal keys, not app actions.")}</>}>
        {SHORTCUTS.map((shortcut) => {
          const displayedKeys = shortcutDisplayKeys(shortcut.id, settings.shortcutOverrides);
          const selectedKey = displayedKeys[displayedKeys.length - 1];
          const selectedReserved = selectedKey !== undefined && isReservedShortcutKey(selectedKey, platformIsMac);
          const defaultKeys = shortcutDisplayKeys(shortcut.id, {});
          const defaultKey = defaultKeys[defaultKeys.length - 1];
          const defaultReserved = defaultKey !== undefined && isReservedShortcutKey(defaultKey, platformIsMac);
          return (
            <SettingsRow key={shortcut.id} label={t(shortcut.label)} wide={shortcut.id !== "voice"} description={selectedReserved ? t("Your browser or operating system may intercept {keys}.", { keys: compactKeys(displayedKeys) }) : undefined}>
              {shortcut.id === "voice" ? <span className="settings-keys">{formatKeys(shortcut.keys).map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}</span> : (
                <select className="select settings-select settings-shortcut-select" aria-label={t(shortcut.label)} value={Object.hasOwn(settings.shortcutOverrides, shortcut.id) ? settings.shortcutOverrides[shortcut.id] ?? "off" : "default"} onChange={(event) => {
                  const next = { ...settings.shortcutOverrides };
                  if (event.target.value === "default") delete next[shortcut.id];
                  else next[shortcut.id] = event.target.value === "off" ? null : event.target.value;
                  update({ shortcutOverrides: next });
                }}>
                  <option value="default" title={t("Default")} disabled={shortcutConflict(shortcut.id, shortcutKeys(shortcut.id, {}), settings.shortcutOverrides)}>{compactKeys(defaultKeys)}{defaultReserved ? ` — ${t("Reserved")}` : ""}</option>
                  <option value="off" title={t("Send keys to terminal")}>{t("Off")}</option>
                  {SHORTCUT_KEYS.map((key) => {
                    const conflict = shortcutConflict(shortcut.id, [key], settings.shortcutOverrides);
                    const reserved = isReservedShortcutKey(key, platformIsMac);
                    return <option key={key} value={key} disabled={conflict}>{compactKeys(["Mod", "Shift", key])}{reserved ? ` — ${t("Reserved")}` : ""}{conflict ? " — " + t("Already assigned") : ""}</option>;
                  })}
                </select>
              )}
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      <div className="settings-actions">
        <button type="button" className="btn" onClick={() => update({ shortcutOverrides: {} })}>{t("Reset shortcuts")}</button>
      </div>
    </>
  );
}

function DevicesPage({ auth }: { auth: HealthAuth | null }) {
  const { settings, update } = useSettings();
  const t = useT();
  const installPrompt = useInstallPrompt();
  // the server says what Tailscale on its PC already serves
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  const loadAccess = useCallback(() => {
    setAccess(undefined);
    fetchRemoteAccess().then(setAccess, () => setAccess(null));
  }, []);
  useEffect(() => { loadAccess(); }, [loadAccess]);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext }, access ?? null);
  // where a phone can open this app now, for the pairing QR code: the served address, else this one when it is not loopback
  const pairUrl = plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin;
  return (
    <>
      <SettingsGroup title={t("Phone")} section="phone">
        <div className="settings-item"><PhonePanel plan={plan} loading={access === undefined} onRefresh={loadAccess} /></div>
        <SettingsRow label={t("Keep screen on")} description={t("While a terminal or chat pane is open. Requires HTTPS or localhost and a supported browser.")}>
          <Toggle label={t("Keep screen on")} checked={settings.keepScreenOn} onChange={(keepScreenOn) => update({ keepScreenOn })} />
        </SettingsRow>
        <SettingsRow label={t("Install")} description={installPrompt.installed ? t("Installed") : installPrompt.canInstall ? undefined : installPrompt.help}>
          {!installPrompt.installed && installPrompt.canInstall && <button type="button" className="btn btn-primary" onClick={() => void installPrompt.install()}>{t("Install app")}</button>}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Devices")} section="devices">
        <div className="settings-item"><DevicesPanel pairUrl={pairUrl} auth={auth} /></div>
      </SettingsGroup>
    </>
  );
}

function RemotePcsPage({ actions, pcSettings, pcSettingsError, onPcSettings }: { actions: AppActions; pcSettings: MachineSettings | null; pcSettingsError: string | null; onPcSettings: (patch: Partial<MachineSettings>) => void }) {
  const t = useT();
  return (
    <SettingsGroup>
      <SettingsRow label={t("Add PC")} description={t("Connect another PC over an SSH alias or user@host. Its workspaces join the sidebar.")}>
        <button type="button" className="btn" onClick={actions.openAddPc}><Monitor aria-hidden="true" />{t("Add PC")}</button>
      </SettingsRow>
      {/* the switch is the server's and waits for its answer; Add PC never does */}
      {pcSettings && (
        <SettingsRow label={t("Update PC bridges automatically")} description={t("When an app update needs a newer bridge, PCs that connect with their saved key are updated in the background. PCs that need a password ask first.")}>
          <Toggle label={t("Update PC bridges automatically")} checked={pcSettings.auto_update_bridges} onChange={(auto_update_bridges) => onPcSettings({ auto_update_bridges })} />
        </SettingsRow>
      )}
      {pcSettingsError && <p className="settings-item settings-hint" role="alert">{pcSettingsError}</p>}
    </SettingsGroup>
  );
}

/**
 * The herdr plugins of the PC on screen and what each can do, to read only: installing, enabling
 * and removing a plugin stay with herdr. Nothing is drawn where there is none to list.
 */
function PluginsGroup() {
  const t = useT();
  const api = useMachineApi();
  const [plugins, setPlugins] = useState<PluginActions[]>([]);
  useEffect(() => {
    let current = true;
    void api.fetchPluginActions().then((list) => { if (current) setPlugins(list); }, () => { if (current) setPlugins([]); });
    return () => { current = false; };
  }, [api]);
  if (plugins.length === 0) return null;
  return (
    <SettingsGroup title={t("herdr plugins")} note={t("Run a plugin's actions from the command palette.")} className="settings-plugins">
      {plugins.map((plugin) => (
        <SettingsRow key={plugin.plugin_id} label={`${plugin.name} ${plugin.version}`} description={plugin.actions.length > 0 ? plugin.actions.map((action) => action.title).join(" · ") : t("No actions")}>
          <span className="settings-hint">{plugin.enabled ? t("Enabled") : t("Disabled")}</span>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

function AboutPage({ updates, herdrVersion, bridgesFollow }: { updates: UpdatesModel; herdrVersion: string | null; bridgesFollow: boolean }) {
  const t = useT();
  return (
    <>
      <UpdateControls updates={updates} bridgesFollow={bridgesFollow} />
      <HerdrUpdateControls enabled herdrVersion={herdrVersion} />
      <PluginsGroup />
      <TelemetryControls />
      <SettingsGroup title={t("About")} className="settings-about" section="about">
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">herdr web ui</span>
            <a className="settings-link" href="https://herdrweb.dev/" target="_blank" rel="noreferrer">herdrweb.dev</a>
          </div>
          <a className="btn" href="https://github.com/devswha/herdr-web-ui" target="_blank" rel="noreferrer"><Star aria-hidden="true" />{t("Star on GitHub")}</a>
        </div>
      </SettingsGroup>
    </>
  );
}

export function SettingsDialog(props: SettingsDialogProps) {
  // mounted per opening: every opening starts on the list, with nothing left from the last one
  return props.open ? <OpenSettingsDialog {...props} /> : null;
}

function OpenSettingsDialog({ section = null, linkPage = null, linkSection = null, onPage, onClose, actions, updates, auth, herdrVersion, onEnableNotifications, overPreview = false }: SettingsDialogProps) {
  const t = useT();
  const narrow = useNarrow();
  // opened by Forward, the dialog shows what that entry of the history showed
  const [restored] = useState(() => shownBy(settingsEntry(window.history.state)));
  // a phone opens on the list of pages; a wider dialog shows the list beside the first page. A
  // button that points at Updates opens on About whatever an entry still landing would restore
  const linked = PAGES.find((candidate) => candidate.id === linkPage)?.id ?? null;
  const [chosen, setChosen] = useState<SettingsPage | null>(section === "updates" ? "about" : restored ? restored.page : linked);
  const page = chosen ?? (narrow ? null : PAGES[0]!.id);
  const [keyBarOpen, setKeyBarOpen] = useState(section === "updates" ? false : restored?.keyBar ?? false);
  // every step in is an entry of the history, so the system Back button takes one step out
  // (lib/settingsHistory.ts); the Back control, the X and Escape take the same entries off
  useEffect(() => { recordSettings(settingsLevels(narrow, page, keyBarOpen)); }, [narrow, page, keyBarOpen]);
  useEffect(() => { onPage?.(page); }, [onPage, page]);
  useEffect(() => onSettingsHistory((entry, own) => {
    const view = own ? null : shownBy(entry);
    if (view === null) return;
    setChosen(view.page);
    setKeyBarOpen(view.keyBar);
  }), []);
  const keyBarButtonRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const settingsScrollRef = useRef(0);
  // Tab stays inside the dialog, and the focus returns to whatever opened it
  const surface = useFocusTrap<HTMLElement>(true, { initialFocus: backRef });
  useSheetSwipe(surface, onClose);
  const shown = useRef<{ page: SettingsPage | null; keyBar: boolean } | null>(null);
  const label = (id: SettingsPage): string => t(id === "appearance" ? "Appearance" : id === "chat" ? "Chat" : id === "terminal" ? "Terminal" : id === "alerts" ? "Alerts" : id === "voice" ? "Voice input"
    : id === "usage" ? "Subscription usage" : id === "shortcuts" ? "Shortcuts" : id === "devices" ? "Phone & devices" : id === "remote" ? "Remote PCs" : id === "integrations" ? "Agent integrations" : "About");
  const openPage = (id: SettingsPage): void => { setKeyBarOpen(false); setChosen(id); };
  const openKeyBar = (): void => {
    settingsScrollRef.current = settingsBodyRef.current?.scrollTop ?? 0;
    setKeyBarOpen(true);
  };
  const goBack = (): void => {
    if (keyBarOpen) setKeyBarOpen(false);
    else setChosen(null);
  };
  const tab = (id: SettingsPage | null): HTMLElement | null => tabsRef.current?.querySelector<HTMLElement>(id === null ? '[role="tab"]' : `[data-settings-page="${id}"]`) ?? null;
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { page, keyBar: keyBarOpen };
    if (keyBarOpen) backRef.current?.focus();
    else if (before?.keyBar && before.page === page) {
      if (settingsBodyRef.current) settingsBodyRef.current.scrollTop = settingsScrollRef.current;
      keyBarButtonRef.current?.focus({ preventScroll: true });
    } else if (before === null) {
      // a button that points at Updates opens on it, and the focus goes there too; so does a link to a group
      const named = section === "updates" ? "updates" : linked && linkSection ? linkSection : null;
      const pointed = named ? settingsBodyRef.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(named)}"]`) : null;
      if (pointed) { pointed.focus({ preventScroll: true }); pointed.scrollIntoView(); }
      else tab(page)?.focus();
    } else if (before.page !== page && narrow) {
      // a phone shows one of the two: the focus follows into the page, and back onto its row
      if (page !== null) backRef.current?.focus();
      else tab(before.page)?.focus();
    }
  }, [page, keyBarOpen, narrow, section]);
  // server-side: the web server updates PC bridges, so it keeps this choice
  const [pcSettings, setPcSettings] = useState<MachineSettings | null>(null);
  const [pcSettingsError, setPcSettingsError] = useState<string | null>(null);
  // asked when a page that shows them opens, so a request that failed earlier is made again
  useEffect(() => {
    if (page !== "remote" && page !== "about") return;
    let live = true;
    machineRequest<MachineSettings>("/settings").then((settings) => { if (live) setPcSettings(settings); }, () => { if (live) setPcSettings(null); });
    return () => { live = false; };
  }, [page]);
  const updatePcSettings = async (patch: Partial<MachineSettings>) => {
    try { setPcSettings(await machineRequest<MachineSettings>("/settings", "PATCH", patch)); setPcSettingsError(null); }
    catch (e) { setPcSettingsError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      // an Escape that cancels an IME composition (the editor's Character field) is the IME's
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      // out of the key bar editor first; from any page, a phone's included, it closes the dialog
      if (keyBarOpen) setKeyBarOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, keyBarOpen]);

  /** the list is one Tab stop: the arrows walk it, and beside an open page they turn the page too */
  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const to = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? PAGES.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = PAGES[(to + PAGES.length) % PAGES.length]!.id;
    tab(next)?.focus();
    if (!narrow) openPage(next);
  };

  const body = (): ReactNode => {
    switch (page) {
      case "appearance": return <AppearancePage />;
      case "chat": return <ChatPage />;
      case "terminal": return <TerminalPage keyBarButtonRef={keyBarButtonRef} onEditKeyBar={openKeyBar} />;
      case "alerts": return <AlertsPage onEnableNotifications={onEnableNotifications} />;
      case "voice": return <VoicePage />;
      case "usage": return <UsagePage />;
      case "shortcuts": return <ShortcutsPage />;
      case "devices": return <DevicesPage auth={auth} />;
      case "remote": return <RemotePcsPage actions={actions} pcSettings={pcSettings} pcSettingsError={pcSettingsError} onPcSettings={(patch) => void updatePcSettings(patch)} />;
      case "integrations": return <IntegrationsPage />;
      case "about": return <AboutPage updates={updates} herdrVersion={herdrVersion} bridgesFollow={pcSettings?.auto_update_bridges === true} />;
      default: return null;
    }
  };
  const listShown = !narrow || (page === null && !keyBarOpen);
  const focusable = page ?? PAGES[0]!.id;

  return (
    <div className={overPreview ? "modal-scrim settings-over-preview" : "modal-scrim"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      {/* named Settings on every page: the page's own name is the visible title */}
      <section ref={surface} className="modal settings-dialog" role="dialog" aria-modal="true" aria-label={keyBarOpen ? t("Key bar") : t("Settings")} tabIndex={-1}>
        <header className="modal-header settings-header">
          {(keyBarOpen || (narrow && page !== null)) && <button type="button" ref={backRef} className="icon-button" aria-label={t("Back to settings")} onClick={goBack}><ArrowLeft aria-hidden="true" /></button>}
          <h2 className="modal-title">{keyBarOpen ? t("Key bar") : page === null ? t("Settings") : label(page)}</h2>
          <button type="button" className="icon-button" aria-label={t("Close settings")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {listShown && (
          <nav className="settings-nav" aria-label={t("Settings")}>
            <p className="settings-nav-title" aria-hidden="true">{t("Settings")}</p>
            <div ref={tabsRef} className="settings-tabs" role="tablist" aria-orientation="vertical">
              {PAGES.map(({ id, icon: Icon }, index) => (
                <button key={id} type="button" role="tab" className="settings-tab" data-settings-page={id} aria-selected={page === id} aria-controls={page === id ? "settings-panel" : undefined} tabIndex={focusable === id ? 0 : -1} onClick={() => openPage(id)} onKeyDown={(event) => onTabKey(event, index)}>
                  <Icon aria-hidden="true" />
                  <span>{label(id)}</span>
                  <ChevronRight className="settings-tab-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          </nav>
        )}
        {page !== null && <div key={page} ref={settingsBodyRef} id="settings-panel" className="modal-body settings-body" role="tabpanel" aria-label={label(page)} hidden={keyBarOpen}>{body()}</div>}
        {keyBarOpen && <div className="modal-body settings-key-bar-body"><KeyBarSettings /></div>}
      </section>
    </div>
  );
}
