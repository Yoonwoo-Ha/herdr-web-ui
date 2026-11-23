import { useContext, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";

import { defaultExpiryDays, expiryDate, MEMORY_TITLE_MAX, projectLabel, type MemoryDraft, type MemoryFlag, type MemoryItem, type MemoryKind, type MemoryOrigin, type MemoryScope, type MemoryView } from "../../shared/memory.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { memoryActions, waitingNotes } from "../lib/memory.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Segmented, SettingsGroup, SettingsQuery, SettingsRow, SettingsSelect } from "./SettingsControls.tsx";
import "./MemorySettings.css";

type Translate = ReturnType<typeof useT>;
type Mode = { at: "list" } | { at: "inbox" } | { at: "note"; item: MemoryItem | null };
type Failure = { message: string; ask: (() => Promise<void>) | null };

export interface MemorySettingsProps {
  view: MemoryView | null;
  loadError: string | null;
  reload: () => Promise<void>;
  /** a watching device reads the notes and changes none */
  watching: boolean;
}

const pad = (value: number) => String(value).padStart(2, "0");
function stamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function scopeName(t: Translate, scope: MemoryScope): string {
  return scope === "account" ? t("Account") : scope === "project" ? t("Project") : t("This PC");
}

function kindName(t: Translate, kind: MemoryKind): string {
  return kind === "preference" ? t("Preference") : kind === "fact" ? t("Fact") : kind === "decision" ? t("Decision") : t("Where it is");
}

function flagName(t: Translate, flag: MemoryFlag): string {
  return flag === "web" ? t("Saw the web") : flag === "command" ? t("Holds a command") : flag === "absolute" ? t("Says always or never") : t("Holds an address");
}

function writer(t: Translate, origin: MemoryOrigin, withTurn = true): string {
  if (origin.by === "human") return origin.surface === "cli" ? t("Command line · ovis memory add") : t("You · written on a screen");
  const agent = [origin.harness ?? t("Agent"), origin.harness_version].filter(Boolean).join(" ");
  return origin.turn === undefined || !withTurn ? agent : `${agent} · ${t("turn {turn}", { turn: origin.turn })}`;
}

function failureText(t: Translate, error: unknown): string {
  const code = error instanceof ApiError ? error.code : null;
  if (code === "secret_found") return t("This looks like a secret, which a note must not hold. Write where it is kept instead.");
  if (code === "memory_full") return t("This scope holds as many notes as it can. Remove one first.");
  if (code === "memory_conflict") return t("The note changed meanwhile. Open it again.");
  if (code === "invalid_memory") return t("The note could not be saved. Check its title and text.");
  return t("Memory could not be changed. Try again.");
}

function Crumb({ title, onBack }: { title: string; onBack: () => void }) {
  const t = useT();
  return (
    <div className="memory-crumb">
      <button type="button" className="icon-button" aria-label={t("Back to memory")} title={t("Back to memory")} onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
      <span>{t("Memory|notes")}</span>
      <ChevronRight className="memory-crumb-mark" aria-hidden="true" />
      <strong>{title}</strong>
    </div>
  );
}

function FailureLine({ failure, onAsk }: { failure: Failure | null; onAsk: () => void }) {
  const t = useT();
  if (failure === null) return null;
  return (
    <p className="memory-failure" role="alert">
      {failure.message}
      {failure.ask !== null && <button type="button" className="btn" onClick={onAsk}>{t("It is not a secret")}</button>}
    </p>
  );
}

function useAct(reload: () => Promise<void>) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const act = async (run: (notSecret: boolean) => Promise<unknown>, after?: () => void, notSecret = false): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await run(notSecret);
      after?.();
      await reload();
    } catch (error) {
      if (error instanceof ApiError && error.code === "secret_suspected") setFailure({ message: t("It holds a random-looking string. Keep it only if that is not a secret."), ask: () => act(run, after, true) });
      else {
        setFailure({ message: failureText(t, error), ask: null });
        // a note that changed since it was listed is listed again, so the next try uses what is there now
        if (error instanceof ApiError && error.code === "memory_conflict") await reload();
      }
    } finally {
      setBusy(false);
    }
  };
  return { busy, failure, act, ask: () => void failure?.ask?.(), clear: () => setFailure(null) };
}

function NoteRow({ item, view, watching, onOpen, onRemove }: { item: MemoryItem; view: MemoryView; watching: boolean; onOpen: () => void; onRemove: () => void }) {
  const t = useT();
  const status = item.state === "stale" ? t("Expired · not given") : item.state === "changed" ? t("Changed outside Ovis") : t("Confirmed");
  return (
    <div className={`memory-note is-${item.state}`}>
      <button type="button" className="memory-note-main" onClick={onOpen}>
        <span className="memory-note-title">{item.title || t("Hidden: it looks like a secret")}</span>
        <span className="memory-note-meta">
          <span className={`memory-chip is-${item.state}`}>{status}</span>
          <span>{writer(t, item.origin)}</span>
          {item.origin.machine !== undefined && item.origin.machine !== view.machine.id && <span>{t("another PC")}</span>}
          <span className="memory-note-expiry">{item.expires === null ? t("Never expires") : t("Expires {date}", { date: item.expires })}</span>
        </span>
      </button>
      {!watching && <span className="memory-note-actions">
        <button type="button" className="icon-button" aria-label={t("Edit note")} title={t("Edit note")} onClick={onOpen}><Pencil aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={t("Remove note")} title={t("Remove note")} onClick={onRemove}><Trash2 aria-hidden="true" /></button>
      </span>}
    </div>
  );
}

function NoteList({ view, scope, setScope, projectChosen, onProject, watching, onOpen, onInbox, reload }: { view: MemoryView; scope: MemoryScope; setScope: (scope: MemoryScope) => void; projectChosen: (key: string) => void; onProject: string | null; watching: boolean; onOpen: (item: MemoryItem | null, scope: MemoryScope) => void; onInbox: () => void; reload: () => Promise<void> }) {
  const t = useT();
  const [removing, setRemoving] = useState<MemoryItem | null>(null);
  const waiting = waitingNotes(view);
  const kept = view.items.filter((item) => item.state === "confirmed" || item.state === "stale");
  const count = (of: MemoryScope) => kept.filter((item) => item.scope === of && (of !== "project" || item.project === onProject)).length;
  const shown = kept.filter((item) => item.scope === scope && (scope !== "project" || item.project === onProject));
  const fromCli = waiting.filter((item) => item.origin.by === "human").length;
  return <>
    {waiting.length > 0 && (
      <button type="button" className="memory-inbox-row" onClick={onInbox}>
        <strong>{t("Waiting for you {count}", { count: waiting.length })}</strong>
        <span>{t("command line {cli}, agents {agents}", { cli: fromCli, agents: waiting.length - fromCli })}</span>
        <ChevronRight aria-hidden="true" />
      </button>
    )}
    <Segmented label={t("Scope")} value={scope} onChange={setScope}
      options={(["account", "project", "machine"] as const).map((value) => ({ value, label: `${scopeName(t, value)} ${count(value)}` }))} />
    {scope === "project" && (
      <div className="memory-project">
        {view.projects.length > 1 ? (
          <SettingsSelect aria-label={t("Project")} value={onProject ?? ""} onChange={(event) => projectChosen(event.target.value)}>
            {view.projects.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
          </SettingsSelect>
        ) : <strong>{onProject === null ? t("No project") : projectLabel(onProject)}</strong>}
        <span>{onProject === null ? t("Open a pane in a git repository with a remote to keep notes for its project.") : t("Given only to panes in this project")}</span>
      </div>
    )}
    <div className="settings-card memory-notes">
      {shown.length === 0 && <p className="memory-empty">{t("No notes here yet.")}</p>}
      {shown.map((item) => <NoteRow key={item.id} item={item} view={view} watching={watching} onOpen={() => onOpen(item, scope)} onRemove={() => setRemoving(item)} />)}
      {!watching && !(scope === "project" && onProject === null) && (
        <button type="button" className="memory-add" onClick={() => onOpen(null, scope)}><Plus aria-hidden="true" />{t("Add a note")}</button>
      )}
    </div>
    {removing !== null && <ConfirmDialog title={t("Remove this note?")} body={t("It goes to the trash and is deleted after 30 days.")} confirmLabel={t("Remove")}
      onConfirm={async () => { await memoryActions.remove(removing.id); await reload(); }} onClose={() => setRemoving(null)} />}
  </>;
}

function Inbox({ view, watching, reload }: { view: MemoryView; watching: boolean; reload: () => Promise<void> }) {
  const t = useT();
  const { busy, failure, act, ask } = useAct(reload);
  const waiting = waitingNotes(view);
  const groups = new Map<string, MemoryItem[]>();
  for (const item of waiting) {
    // one run's waiting notes are one group, the only ones its "discard all" takes; a changed note stands apart
    const group = item.state === "unconfirmed" && item.origin.run !== undefined ? `run:${item.origin.run}` : `${item.origin.by}:${item.origin.surface ?? ""}:${item.state}:${item.origin.run ?? ""}`;
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  const machine = (item: MemoryItem) => item.origin.machine === undefined || item.origin.machine === view.machine.id ? view.machine.name : t("another PC");
  return <>
    <p className="settings-description memory-lead">{t("Agents will get only notes you confirm. Unconfirmed ones go away by themselves after 14 days.")}</p>
    <FailureLine failure={failure} onAsk={ask} />
    {waiting.length === 0 && <p className="memory-empty">{t("Nothing waits for you.")}</p>}
    {[...groups].map(([group, items]) => {
      const first = items[0]!;
      const run = first.state === "unconfirmed" ? first.origin.run : undefined;
      return (
        <section key={group} className="memory-group">
          <header className="memory-group-head">
            <span className="memory-group-who">{writer(t, first.origin, false)}</span>
            <span className="memory-group-where">{[first.origin.session ? t("session {session}", { session: first.origin.session }) : null, machine(first), first.origin.drive === "acp" ? "ACP" : first.origin.drive === "terminal" ? t("terminal") : null, stamp(first.origin.at), first.origin.by === "human" && first.origin.surface === "cli" ? t("who typed it is not known") : null].filter(Boolean).join(" · ")}</span>
            {run !== undefined && !watching && (
              <button type="button" className="btn btn-ghost memory-group-drop" disabled={busy} onClick={() => void act(() => memoryActions.discardRun(run))}>{t("Discard all this run wrote ({count})", { count: items.length })}</button>
            )}
          </header>
          {items.map((item) => (
            <article key={item.id} className="memory-card">
              {item.withheld !== null ? <p className="memory-card-title">{t("Hidden: it looks like a secret")}</p> : <>
                <p className="memory-card-title">{item.title}</p>
                {item.body !== "" && <p className="memory-card-body">{item.body}</p>}
              </>}
              <div className="memory-card-chips">
                <span className="memory-chip">{item.scope === "project" && item.project !== null ? `${t("Project")} · ${projectLabel(item.project)}` : scopeName(t, item.scope)}</span>
                {item.state === "changed" && <span className="memory-chip is-warn">{t("Changed outside Ovis")}</span>}
                {item.flags.map((flag) => <span key={flag} className="memory-chip is-warn">{flagName(t, flag)}</span>)}
                {item.origin.turn !== undefined && <span className="memory-card-turn">{t("turn {turn}", { turn: item.origin.turn })}</span>}
              </div>
              {!watching && <div className="memory-card-actions">
                {item.withheld === null && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act((notSecret) => memoryActions.confirm(item, notSecret))}>{t("Confirm")}</button>}
                <button type="button" className="btn" disabled={busy} onClick={() => void act(() => item.state === "unconfirmed" ? memoryActions.discard(item.id) : memoryActions.remove(item.id))}>{t("Discard")}</button>
              </div>}
            </article>
          ))}
        </section>
      );
    })}
  </>;
}

const EXPIRY_CHOICES = [null, 90, 180, 365] as const;

function NoteForm({ view, item, scope: startScope, project, watching, onDone, reload }: { view: MemoryView; item: MemoryItem | null; scope: MemoryScope; project: string | null; watching: boolean; onDone: () => void; reload: () => Promise<void> }) {
  const t = useT();
  const { busy, failure, act, ask, clear } = useAct(reload);
  const [title, setTitle] = useState(item?.title ?? "");
  const [body, setBody] = useState(item?.body ?? "");
  const [scope, setScope] = useState<MemoryScope>(item?.scope ?? startScope);
  const [noteProject, setNoteProject] = useState<string | null>(item?.project ?? project ?? view.projects[0]?.key ?? null);
  const [kind, setKind] = useState<MemoryKind>(item?.kind ?? "preference");
  const keep = item === null ? null : item.expires;
  const [expiry, setExpiry] = useState<string>(item === null ? "default" : "keep");
  const [removing, setRemoving] = useState(false);
  // "it is not a secret" answers for the draft that was sent: a change to the draft asks for Save again
  useEffect(clear, [title, body, scope, noteProject, kind, expiry]);
  const fallback = defaultExpiryDays(kind, scope);
  const expires = expiry === "keep" ? keep : expiry === "never" ? null
    : expiry === "default" ? (fallback === null ? null : expiryDate(Date.now(), fallback)) : expiryDate(Date.now(), Number(expiry));
  const draft = (notSecret: boolean): MemoryDraft => ({ scope, project: scope === "project" ? noteProject : null, kind, title: title.trim(), body, expires, ...(notSecret ? { notSecret } : {}) });
  const save = () => act((notSecret) => item === null ? memoryActions.add(draft(notSecret)) : memoryActions.edit({ ...draft(notSecret), id: item.id, rev: item.rev, digest: item.digest }), onDone);
  const field = (label: string, control: ReactNode, id?: string) => (
    <div className="memory-field">{id === undefined ? <span className="memory-field-label">{label}</span> : <label className="memory-field-label" htmlFor={id}>{label}</label>}{control}</div>
  );
  const fact = (label: string, value: string) => <div className="memory-fact"><span>{label}</span><span>{value}</span></div>;
  return <>
    <div className="settings-card memory-form">
      {field(t("Title"), <input id="memory-title" className="input" value={title} maxLength={MEMORY_TITLE_MAX} disabled={watching} onChange={(event) => setTitle(event.target.value)} />, "memory-title")}
      {field(t("Text"), <textarea id="memory-body" className="input memory-body-input" rows={4} value={body} disabled={watching} placeholder={t("Optional: why, and where it comes from")} onChange={(event) => setBody(event.target.value)} />, "memory-body")}
      {field(t("Scope"), <Segmented label={t("Scope")} value={scope} disabled={watching} onChange={setScope} options={(["account", "project", "machine"] as const).map((value) => ({ value, label: scopeName(t, value) }))} />)}
      {scope === "project" && field(t("Project"), view.projects.length === 0 ? <span className="memory-fact-value">{t("No project")}</span> : (
        <SettingsSelect id="memory-project" value={noteProject ?? ""} disabled={watching} onChange={(event) => setNoteProject(event.target.value)}>
          {view.projects.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
        </SettingsSelect>
      ), "memory-project")}
      {field(t("Kind"), (
        <SettingsSelect id="memory-kind" value={kind} disabled={watching} onChange={(event) => setKind(event.target.value as MemoryKind)}>
          {(["preference", "fact", "decision", "pointer"] as const).map((value) => <option key={value} value={value}>{kindName(t, value)}</option>)}
        </SettingsSelect>
      ), "memory-kind")}
      {field(t("Expires"), (
        <SettingsSelect id="memory-expiry" value={expiry} disabled={watching} onChange={(event) => setExpiry(event.target.value)}>
          {item === null ? <option value="default">{expires === null ? t("Never") : t("{date} (default)", { date: expires })}</option> : <option value="keep">{keep === null ? t("Never") : keep}</option>}
          {EXPIRY_CHOICES.map((choice) => choice === null ? <option key="never" value="never">{t("Never")}</option> : <option key={choice} value={String(choice)}>{t("In {days} days", { days: choice })}</option>)}
        </SettingsSelect>
      ), "memory-expiry")}
    </div>
    {item !== null && (
      <SettingsGroup title={t("Where it comes from")}>
        {fact(t("Written by"), writer(t, item.origin))}
        {fact(t("PC"), [item.origin.machine === undefined || item.origin.machine === view.machine.id ? view.machine.name : t("another PC"), item.origin.drive === "acp" ? "ACP" : item.origin.drive === "terminal" ? t("terminal") : null].filter(Boolean).join(" · "))}
        {item.origin.session != null && fact(t("Session"), item.origin.session)}
        {item.origin.by === "agent" && fact(t("Web"), item.origin.exposure === "web" ? t("Saw the web") : t("Did not see the web"))}
        {item.verified_at !== null && fact(t("Confirmed"), stamp(item.verified_at))}
        {fact(t("Changed"), t("{when} · version {rev}", { when: stamp(item.updated_at), rev: item.rev }))}
      </SettingsGroup>
    )}
    <FailureLine failure={failure} onAsk={ask} />
    {!watching && <div className="memory-form-actions">
      {item !== null && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setRemoving(true)}><Trash2 aria-hidden="true" />{t("Remove")}</button>}
      <span className="memory-form-gap" />
      <button type="button" className="btn" disabled={busy} onClick={onDone}>{t("Cancel")}</button>
      <button type="button" className="btn btn-primary" disabled={busy || title.trim() === "" || (scope === "project" && noteProject === null)} onClick={() => void save()}>{t("Save")}</button>
    </div>}
    {removing && item !== null && <ConfirmDialog title={t("Remove this note?")} body={t("It goes to the trash and is deleted after 30 days.")} confirmLabel={t("Remove")}
      onConfirm={async () => { await memoryActions.remove(item.id); onDone(); await reload(); }} onClose={() => setRemoving(false)} />}
  </>;
}

export function MemorySettings({ view, loadError, reload, watching }: MemorySettingsProps) {
  const t = useT();
  const words = useContext(SettingsQuery);
  const [mode, setMode] = useState<Mode>({ at: "list" });
  const [scope, setScope] = useState<MemoryScope | null>(null);
  const [chosenProject, setChosenProject] = useState<string | null>(null);
  if (words.length > 0) {
    return (
      <SettingsGroup section="memory">
        <SettingsRow label={t("Notes for your agents")} keywords={t("memory notes remember inbox confirm")}><span className="pill">{view?.items.length ?? 0}</span></SettingsRow>
      </SettingsGroup>
    );
  }
  if (view === null) return <p className="memory-empty" role={loadError === null ? undefined : "alert"}>{loadError ?? t("Loading…")}</p>;
  const chosen = chosenProject !== null && view.projects.some((candidate) => candidate.key === chosenProject) ? chosenProject : null;
  const project = chosen ?? view.here?.key ?? view.projects[0]?.key ?? null;
  const stale = loadError !== null && <p className="memory-failure" role="alert">{t("The list could not be refreshed, so it may be out of date.")}<button type="button" className="btn" onClick={() => void reload()}>{t("Retry")}</button></p>;
  // the scope picked stays picked while a note or the inbox is open
  const shownScope = scope ?? (view.here !== null ? "project" : "account");
  const back = () => setMode({ at: "list" });
  const waiting = waitingNotes(view).length;
  switch (mode.at) {
    case "inbox": return <div className="memory-page">{stale}<Crumb title={t("Waiting for you {count}", { count: waiting })} onBack={back} /><Inbox view={view} watching={watching} reload={reload} /></div>;
    case "note": return (
      <div className="memory-page">
        {stale}
        <Crumb title={mode.item === null ? t("New note") : t("Note")} onBack={back} />
        <NoteForm view={view} item={mode.item} scope={shownScope} project={project} watching={watching} onDone={back} reload={reload} />
      </div>
    );
    default: return (
      <div className="memory-page">
        {stale}
        <NoteList view={view} scope={shownScope} setScope={setScope} onProject={project} projectChosen={setChosenProject} watching={watching} reload={reload}
          onInbox={() => setMode({ at: "inbox" })} onOpen={(item) => setMode({ at: "note", item })} />
      </div>
    );
  }
}
