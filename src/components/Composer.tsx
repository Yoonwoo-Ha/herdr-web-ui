import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Clock, Paperclip, SendHorizontal, Square, X } from "lucide-react";

import "./Composer.css";

import type { AgentStatus, ConversationMetadata, SlashCommand } from "../../shared/protocol.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import {
  agentDisplayLabel,
  composerStatusWord,
  imageMention,
  MAX_COMPOSER_CHARS,
  rankSlashCommands,
} from "../lib/compose.ts";
import { activeTrigger, applyCompletion, type ActiveTrigger } from "../lib/mentions.ts";
import { useSettings } from "../lib/settings.ts";
import { modKeyLabel } from "../lib/shortcuts.ts";
import { AgentMark } from "./AgentMark.tsx";

export interface ComposerProps {
  connected: boolean;
  paneId: string;
  agent: string | null;
  agentStatus?: AgentStatus;
  metadata?: ConversationMetadata | null;
  queueMode?: boolean;
  onSend: (text: string) => boolean;
  onAbort: () => void;
  onUploadImage: (file: File) => Promise<string>;
}

const MAX_IMAGES_PER_ACTION = 4;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const COMMAND_CACHE_MS = 60_000;
const SLASH_USAGE_KEY = "herdr-web-ui:slash-usage";
/** One height for every pane on this device: it is the screen, not the conversation, that decides it. */
const COMPOSER_HEIGHT_KEY = "herdr-web-ui:composer-height";
const COMPOSER_HEIGHT_MAX = 480;
const COMPOSER_HEIGHT_STEP = 24;
/** How far a press on the grip must travel to become a resize: a tap or a resting finger sets nothing. */
const RESIZE_SLACK = { mouse: 3, touch: 10 } as const;
/** Two taps on the grip this close return the box to its automatic height (iOS may send no dblclick). */
const DOUBLE_TAP_MS = 350;
const COMMAND_SOURCES = ["builtin", "user", "project"] as const;
const SOURCE_LABEL: Record<SlashCommand["source"], string> = {
  builtin: "Built in",
  user: "User",
  project: "Project",
};

type CommandCacheEntry = { loadedAt: number; commands: SlashCommand[] };
const commandCache = new Map<string, CommandCacheEntry>();
let attachmentSequence = 0;

type Attachment = {
  id: number;
  file: File;
  previewUrl: string;
  path: string | null;
  state: "uploading" | "ready" | "error";
};

function readSlashUsage(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SLASH_USAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  } catch {
    return {};
  }
}

/** A saved manual height, or null for the automatic one (also for anything malformed). */
function readComposerHeight(): number | null {
  try {
    const value = Number(window.localStorage.getItem(COMPOSER_HEIGHT_KEY));
    return Number.isFinite(value) && value > 0 && value <= COMPOSER_HEIGHT_MAX ? Math.round(value) : null;
  } catch {
    return null;
  }
}

function saveComposerHeight(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(COMPOSER_HEIGHT_KEY);
    else window.localStorage.setItem(COMPOSER_HEIGHT_KEY, String(value));
  } catch {
    // Without storage the height still holds until reload.
  }
}

/** Half the visible viewport at most, so a raised keyboard never leaves the transcript without room. */
function composerHeightLimit(): number {
  const viewport = window.visualViewport?.height ?? window.innerHeight;
  return Math.min(COMPOSER_HEIGHT_MAX, Math.floor(viewport / 2));
}

async function cachedPaneCommands(paneId: string, machineId: string, fetchCommands: (pane: string) => Promise<SlashCommand[]>): Promise<SlashCommand[]> {
  const cached = commandCache.get(paneStorageId(machineId, paneId));
  if (cached && Date.now() - cached.loadedAt < COMMAND_CACHE_MS) return cached.commands;
  const commands = await fetchCommands(paneId);
  commandCache.set(paneStorageId(machineId, paneId), { loadedAt: Date.now(), commands });
  return commands;
}

/** Chat-style input surface with pane-local drafts, command/file completion, and image mentions. */
export function Composer({
  connected,
  paneId,
  agent,
  agentStatus,
  metadata,
  queueMode = false,
  onSend,
  onAbort,
  onUploadImage,
}: ComposerProps) {
  const machineId = useMachineId();
  const { fetchPaneCommands, fetchPaneFiles } = useMachineApi();
  const { settings } = useSettings();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<Attachment[]>([]);
  const removedAttachments = useRef(new Set<number>());
  const fileRequest = useRef(0);
  const draftKey = `herdr-web-ui:composer-draft:${paneStorageId(machineId, paneId)}`;
  const [text, setText] = useState(() => {
    try { return window.localStorage.getItem(draftKey) ?? ""; }
    catch { return ""; }
  });
  const mounted = useRef(true);
  const [caret, setCaret] = useState(text.length);
  const textRef = useRef(text);
  const caretRef = useRef(caret);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [slashUsage, setSlashUsage] = useState<Record<string, number>>(readSlashUsage);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [manualHeight, setManualHeight] = useState<number | null>(readComposerHeight);
  /** the box's rendered height, for the grip to announce while the height is automatic */
  const [autoHeight, setAutoHeight] = useState(0);
  /** the automatic height of an empty box (the textarea's CSS min-height): the grip's floor */
  const [minHeight, setMinHeight] = useState(0);
  const [heightLimit, setHeightLimit] = useState(composerHeightLimit);
  const lastGripTap = useRef(0);

  attachmentsRef.current = attachments;
  textRef.current = text;
  caretRef.current = caret;
  const trigger = useMemo(() => activeTrigger(text, caret), [caret, text]);
  const uploading = attachments.some((attachment) => attachment.state === "uploading");
  const agentLabel = agentDisplayLabel(agent);
  const placeholder = connected
    ? `Message ${agentLabel}…`
    : "Reconnecting… message held here, never queued";

  useEffect(() => {
    try {
      if (text.length > 0) window.localStorage.setItem(draftKey, text);
      else window.localStorage.removeItem(draftKey);
    } catch {
      // Private browsing can reject persistence; the in-memory draft still works.
    }
  }, [draftKey, text]);

  useEffect(() => {
    let live = true;
    void cachedPaneCommands(paneId, machineId, fetchPaneCommands)
      .then((next) => {
        if (live) setCommands(next);
      })
      .catch(() => {
        if (live) setCommands([]);
      });
    return () => {
      live = false;
    };
  }, [paneId]);

  useEffect(() => {
    const request = ++fileRequest.current;
    if (trigger?.kind !== "file") {
      setFiles([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchPaneFiles(paneId, trigger.query, 20)
        .then((next) => {
          if (request === fileRequest.current) setFiles(next);
        })
        .catch(() => {
          if (request === fileRequest.current) setFiles([]);
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [paneId, trigger?.kind, trigger?.query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [trigger?.kind, trigger?.query]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl);
    };
  }, []);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const floor = Math.round(parseFloat(getComputedStyle(element).minHeight)) || 0;
    setMinHeight((current) => current === floor ? current : floor);
    if (manualHeight !== null) {
      element.style.height = `${manualHeight}px`;
      return;
    }
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    const height = Math.round(element.getBoundingClientRect().height);
    setAutoHeight((current) => current === height ? current : height);
  }, [text, manualHeight, placeholder]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = (): void => setHeightLimit(composerHeightLimit());
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const maxHeight = Math.max(minHeight, heightLimit);
  /** A grip height within the limits; at or below the automatic floor it is the automatic height again. */
  const gripHeight = (value: number): number | null => value <= minHeight ? null : Math.round(Math.min(maxHeight, value));

  /**
   * Dragging the grip up grows the box; the pointer stays captured, so a finger may leave the grip.
   * The height changes only once the press has moved past the slack, and is saved when it lets go.
   */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const element = textareaRef.current;
    if (!element || event.button !== 0) return;
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const slack = event.pointerType === "mouse" ? RESIZE_SLACK.mouse : RESIZE_SLACK.touch;
    const startHeight = element.getBoundingClientRect().height;
    const startY = event.clientY;
    let resizing = false;
    let height = manualHeight;
    const move = (next: PointerEvent): void => {
      if (!resizing && Math.abs(next.clientY - startY) < slack) return;
      resizing = true;
      height = gripHeight(startHeight + startY - next.clientY);
      setManualHeight(height);
    };
    const end = (finished: PointerEvent): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      if (resizing) {
        lastGripTap.current = 0;
        saveComposerHeight(height);
      } else if (finished.type === "pointerup") {
        // a tap: the second of two quick ones returns the automatic height
        if (finished.timeStamp - lastGripTap.current < DOUBLE_TAP_MS) {
          lastGripTap.current = 0;
          setManualHeight(null);
          saveComposerHeight(null);
        } else {
          lastGripTap.current = finished.timeStamp;
        }
      }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  };

  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = manualHeight ?? textareaRef.current?.getBoundingClientRect().height ?? minHeight;
    const step = event.shiftKey ? COMPOSER_HEIGHT_STEP * 2 : COMPOSER_HEIGHT_STEP;
    let next: number | null;
    if (event.key === "ArrowUp") next = gripHeight(current + step);
    else if (event.key === "ArrowDown") next = gripHeight(current - step);
    else if (event.key === "Home") next = null;
    else return;
    event.preventDefault();
    setManualHeight(next);
    saveComposerHeight(next);
  };
  const gripValue = Math.round(Math.min(maxHeight, Math.max(minHeight, manualHeight ?? autoHeight)));

  const filteredCommands = useMemo(
    () => (trigger?.kind === "slash" ? rankSlashCommands(commands, trigger.query, slashUsage) : []),
    [commands, slashUsage, trigger],
  );
  const orderedCommands = useMemo(
    () => COMMAND_SOURCES.flatMap((source) => filteredCommands.filter((command) => command.source === source)),
    [filteredCommands],
  );
  const choices: readonly (SlashCommand | string)[] = trigger?.kind === "slash" ? orderedCommands : files;
  const menuOpen = !menuDismissed && trigger !== null && choices.length > 0;

  useEffect(() => {
    if (selectedIndex >= choices.length) setSelectedIndex(Math.max(0, choices.length - 1));
  }, [choices.length, selectedIndex]);

  const setTextAndCaret = useCallback((nextText: string, nextCaret: number) => {
    const limitedText = nextText.slice(0, MAX_COMPOSER_CHARS);
    const clampedCaret = Math.min(nextCaret, MAX_COMPOSER_CHARS);
    textRef.current = limitedText;
    caretRef.current = clampedCaret;
    setText(limitedText);
    setCaret(clampedCaret);
    setMenuDismissed(false);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.selectionStart = element.selectionEnd = clampedCaret;
      element.focus();
    });
  }, []);

  const insertAtCursor = useCallback(
    (snippet: string) => {
      const element = textareaRef.current;
      const currentText = textRef.current;
      const selectionIsCurrent = element?.value === currentText;
      const start = selectionIsCurrent ? (element.selectionStart ?? caretRef.current) : caretRef.current;
      const end = selectionIsCurrent ? (element.selectionEnd ?? start) : start;
      const room = Math.max(0, MAX_COMPOSER_CHARS - currentText.length + end - start);
      const inserted = snippet.slice(0, room);
      setTextAndCaret(currentText.slice(0, start) + inserted + currentText.slice(end), start + inserted.length);
    },
    [setTextAndCaret],
  );

  const selectCompletion = useCallback(
    (choice: SlashCommand | string, currentTrigger: ActiveTrigger) => {
      const replacement = currentTrigger.kind === "slash" ? `/${(choice as SlashCommand).name} ` : `@${choice as string} `;
      const completed = applyCompletion(text, currentTrigger, replacement);
      setTextAndCaret(completed.text, completed.caret);
      setMenuDismissed(true);
      if (currentTrigger.kind === "slash") {
        const name = (choice as SlashCommand).name;
        setSlashUsage((current) => {
          const next = { ...current, [name]: (current[name] ?? 0) + 1 };
          try {
            window.localStorage.setItem(SLASH_USAGE_KEY, JSON.stringify(next));
          } catch {
            // Completion still works when storage is unavailable.
          }
          return next;
        });
      }
    },
    [setTextAndCaret, text],
  );

  const uploadImages = useCallback(
    async (incoming: readonly File[]) => {
      const images = incoming
        .filter((file) => (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type))
        .slice(0, MAX_IMAGES_PER_ACTION);
      if (images.length === 0) return;

      const added = images.map<Attachment>((file) => ({
        id: ++attachmentSequence,
        file,
        previewUrl: URL.createObjectURL(file),
        path: null,
        state: "uploading",
      }));
      setAttachments((current) => [...current, ...added]);
      setNote(null);

      for (const attachment of added) {
        if (!mounted.current) break;
        try {
          const path = await onUploadImage(attachment.file);
          if (!mounted.current) break;
          if (removedAttachments.current.has(attachment.id)) continue;
          setAttachments((current) =>
            current.map((item) => (item.id === attachment.id ? { ...item, path, state: "ready" } : item)),
          );
          insertAtCursor(imageMention(path));
        } catch (error) {
          if (!mounted.current) break;
          if (removedAttachments.current.has(attachment.id)) continue;
          setAttachments((current) =>
            current.map((item) => (item.id === attachment.id ? { ...item, state: "error" } : item)),
          );
          setNote(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [insertAtCursor, onUploadImage],
  );

  const removeAttachment = useCallback((attachment: Attachment) => {
    removedAttachments.current.add(attachment.id);
    URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    if (attachment.path) {
      const mention = imageMention(attachment.path);
      setText((current) => {
        const next = current.replace(mention, "");
        textRef.current = next;
        caretRef.current = Math.min(caretRef.current, next.length);
        return next;
      });
    }
  }, []);

  const send = useCallback(() => {
    if (!connected || uploading || text.trim().length === 0) return;
    if (onSend(text)) {
      setText("");
      setCaret(0);
      textRef.current = "";
      caretRef.current = 0;
      setNote(null);
      for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
      setAttachments([]);
    }
  }, [attachments, connected, onSend, text, uploading]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (menuOpen && trigger) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setSelectedIndex((current) => (current + direction + choices.length) % choices.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const choice = choices[selectedIndex];
          if (choice !== undefined) selectCompletion(choice, trigger);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMenuDismissed(true);
          return;
        }
      }
      if (event.key === "Escape" && trigger) {
        setMenuDismissed(true);
        return;
      }
      if (event.key !== "Enter") return;
      const shouldSend = settings.enterSends
        ? !event.shiftKey && !event.metaKey && !event.ctrlKey
        : (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (!shouldSend) return;
      event.preventDefault();
      send();
    },
    [choices, menuOpen, selectCompletion, selectedIndex, send, settings.enterSends, trigger],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const images = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file" && (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(item.type))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (images.length === 0) return;
      event.preventDefault();
      void uploadImages(images);
    },
    [uploadImages],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      void uploadImages(Array.from(event.dataTransfer.files));
    },
    [uploadImages],
  );

  const isWorking = agentStatus === "working";
  const menuId = `composer-menu-${paneId}`;

  return (
    <div className="composer" role="group" aria-label="Message composer">
      <div className="composer-status" role="status" data-status={agentStatus ?? "unknown"}>
        {agent && <AgentMark agent={agent} size={14} />}
        <span className="composer-agent-label">{agentLabel}</span>
        <span className="composer-status-separator" aria-hidden="true">·</span>
        <strong>{composerStatusWord(agentStatus)}</strong>
        {(metadata?.model || metadata?.reasoning_effort) && <span className="composer-model-info" aria-label="Model and reasoning">
          <span className="composer-model" title={metadata.model ?? "Model not available"}>{metadata.model ?? "Model —"}</span>
          <span className="composer-reasoning" title={metadata.reasoning_effort ? `Reasoning effort: ${metadata.reasoning_effort}` : "Reasoning effort not available"}>
            Reasoning {metadata.reasoning_effort ?? "—"}
          </span>
        </span>}
        {(uploading || !connected) && (
          <span className="composer-status-hint">
            <span aria-hidden="true">·</span> {uploading ? "Uploading image…" : "Reconnecting… message held here, never queued"}
          </span>
        )}
        {/* what the placeholder used to cram in; Enter-sends is the chat convention and goes unsaid */}
        <span className="composer-keys-hint" aria-hidden="true">
          <kbd className="kbd">/</kbd> commands <kbd className="kbd">@</kbd> files
          {!settings.enterSends && <> <kbd className="kbd">{modKeyLabel()}+Enter</kbd> sends</>}
        </span>
      </div>

      <div
        className={`composer-surface${dragging ? " is-dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <div
          className="composer-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize message box"
          aria-valuemin={minHeight}
          aria-valuemax={maxHeight}
          aria-valuenow={gripValue}
          aria-valuetext={manualHeight === null ? "automatic height" : `${gripValue} pixels`}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onKeyDown={onResizeKey}
        />
        {menuOpen && trigger && (
          <div id={menuId} className="menu composer-menu" role="listbox" aria-label={trigger.kind === "slash" ? "Slash commands" : "Files"}>
            {trigger.kind === "slash" ? (
              COMMAND_SOURCES.map((source) => {
                const group = filteredCommands.filter((command) => command.source === source);
                if (group.length === 0) return null;
                return (
                  <div className="composer-menu-group" key={source}>
                    <div className="menu-heading">{SOURCE_LABEL[source]}</div>
                    {group.map((command) => {
                      const index = orderedCommands.indexOf(command);
                      return (
                        <button
                          id={`${menuId}-${index}`}
                          key={`${command.source}:${command.name}`}
                          type="button"
                          className="menu-item"
                          role="option"
                          aria-selected={index === selectedIndex}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => selectCompletion(command, trigger)}
                        >
                          <span className="menu-item-main">/{command.name}</span>
                          <span className="menu-item-hint">{command.description}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            ) : (
              <div className="composer-menu-group">
                <div className="menu-heading">Files</div>
                {files.map((file, index) => (
                  <button
                    id={`${menuId}-${index}`}
                    key={file}
                    type="button"
                    className="menu-item"
                    role="option"
                    aria-selected={index === selectedIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectCompletion(file, trigger)}
                  >
                    <span className="menu-item-main">{file}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attached images">
            {attachments.map((attachment) => (
              <div className={`composer-attachment is-${attachment.state}`} key={attachment.id}>
                <img src={attachment.previewUrl} alt={attachment.file.name} />
                <span className="composer-attachment-state">
                  {attachment.state === "uploading" ? "Uploading" : attachment.state === "error" ? "Failed" : "Attached"}
                </span>
                <button type="button" aria-label={`Remove ${attachment.file.name}`} onClick={() => removeAttachment(attachment)}>
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className={`composer-text${manualHeight !== null ? " is-sized" : ""}`}
          rows={1}
          maxLength={MAX_COMPOSER_CHARS}
          value={text}
          placeholder={placeholder}
          aria-label="Message"
          aria-controls={menuOpen ? menuId : undefined}
          aria-expanded={menuOpen}
          aria-activedescendant={menuOpen ? `${menuId}-${selectedIndex}` : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={!connected}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            setCaret(event.currentTarget.selectionStart);
            setMenuDismissed(false);
          }}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setMenuDismissed(false);
            setNote(null);
          }}
        />

        <div className="composer-controls composer-controls-left">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(",")}
            multiple
            hidden
            onChange={(event) => {
              const picked = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void uploadImages(picked);
            }}
          />
          <button
            type="button"
            className="icon-button composer-attach"
            aria-label="Attach images"
            title="Attach images"
            disabled={!connected || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip aria-hidden="true" />
          </button>
        </div>
        <div className="composer-controls composer-controls-right">
          {queueMode && (
            <button
              type="button"
              className="composer-queue-button"
              aria-label="Queue message"
              title="Queue as the next message"
              disabled={!connected || uploading || text.trim().length === 0}
              onClick={send}
            >
              <Clock aria-hidden="true" />
              Queue
            </button>
          )}
          {isWorking ? (
            <button
              type="button"
              className="composer-action composer-stop"
              aria-label="Stop agent"
              title="Stop agent"
              disabled={!connected}
              onClick={onAbort}
            >
              <Square aria-hidden="true" />
            </button>
          ) : !queueMode ? (
            <button
              type="button"
              className="composer-action composer-send"
              aria-label="Send message"
              title="Send message"
              disabled={!connected || uploading || text.trim().length === 0}
              onClick={send}
            >
              <SendHorizontal aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      {note && <div className="composer-note" role="alert">{note}</div>}
    </div>
  );
}
