import { useEffect, useId, useRef, useState } from "react";
import { Send, X } from "lucide-react";

import "./PromptCard.css";

import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import type { InteractivePrompt, PromptAnswer, UnreadablePrompt, UnreadablePromptAction } from "../../shared/protocol.ts";
import type { TypedAnswer } from "../lib/promptAnswer.ts";
import { useT } from "../lib/i18n.ts";

export interface PromptCardProps {
  paneId: string;
  prompt: InteractivePrompt;
  onPromptChanged(): void;
  onAnswered(): void;
  /** an option picked by a typed message, sent only on Confirm */
  typedAnswer?: TypedAnswer | null;
  onTypedAnswerDone?(): void;
}

export function PromptCard({ paneId, prompt, onPromptChanged, onAnswered, typedAnswer = null, onTypedAnswerDone }: PromptCardProps) {
  const t = useT();
  const { answerPanePrompt } = useMachineApi();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [custom, setCustom] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  // the question to confirm comes into view, clear of the chat's floating buttons
  useEffect(() => {
    confirmRef.current?.scrollIntoView({ block: "center" });
  }, [typedAnswer]);

  useEffect(() => {
    setSelected(new Set());
    setCustom("");
    setPending(false);
    setError(null);
  }, [prompt.id]);

  const answer = async (choice: Omit<PromptAnswer, "pane_id" | "prompt_id">): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await answerPanePrompt({ pane_id: paneId, prompt_id: prompt.id, ...choice });
      onAnswered();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.code === "prompt_changed") {
        setError("the prompt changed — re-read");
        onPromptChanged();
        window.setTimeout(() => setError(null), 2000);
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setPending(false);
    }
  };

  const toggle = (index: number): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  const customLabelId = useId();
  // Claude renders the menu's own pick as "Redis (Recommended)": a tag reads better than the suffix
  const labelOf = (label: string): { text: string; recommended: boolean } => {
    const text = label.replace(/\s*\(recommended\)$/i, "");
    return { text, recommended: text !== label };
  };
  const hasChoices = prompt.options.some((_, index) => index !== prompt.custom_option_index);

  return (
    <section className="prompt-card" role="region" aria-label={t("Agent is asking")} aria-busy={pending}>
      <header className="prompt-card-header">
        <span className="badge badge-blocked">{t("input needed")}</span>
        <h2>{prompt.title}</h2>
      </header>
      {/* a Claude approval's heading is its question too: said once */}
      {prompt.question !== prompt.title && <p className="prompt-card-question">{prompt.question}</p>}
      {prompt.queued && (
        <p className="prompt-card-hint">
          {prompt.queued === "open"
            ? t("Codex keeps working meanwhile. Answer here; the question holds the terminal's input until it is answered or closed.")
            : t("Codex keeps working meanwhile. Answer here; the message box still talks to Codex.")}
        </p>
      )}
      {prompt.body !== null && prompt.body.length > 0 && <pre className="prompt-card-body">{prompt.body}</pre>}
      {hasChoices && (
        <div className="prompt-card-options" role={prompt.multi_select ? "group" : undefined} aria-label={prompt.multi_select ? prompt.question : undefined}>
          {prompt.options.map((option, index) => {
            if (index === prompt.custom_option_index) return null;
            const { text, recommended } = labelOf(option.label);
            const content = (
              <span className="prompt-card-option-text">
                <span className="prompt-card-option-label">{text}{recommended && <> <span className="prompt-card-tag">{t("Recommended")}</span></>}</span>
                {option.description !== null && <span className="prompt-card-option-description">{option.description}</span>}
              </span>
            );
            if (prompt.multi_select) {
              const checked = selected.has(index);
              return (
                <label className={`prompt-card-option${checked ? " is-checked" : ""}`} key={index}>
                  <input type="checkbox" checked={checked} disabled={pending} onChange={() => toggle(index)} />
                  <span className="prompt-card-number">{index + 1}.</span> {content}
                </label>
              );
            }
            return (
              <button key={index} type="button" className={`prompt-card-option${typedAnswer?.option_index === index ? " is-typed" : ""}`} disabled={pending} onClick={() => void answer({ option_index: index })}>
                <span className="prompt-card-number">{index + 1}.</span> {content}
              </button>
            );
          })}
        </div>
      )}
      {prompt.multi_select && (
        <button type="button" className={`btn${selected.size > 0 ? " btn-primary" : ""} prompt-card-submit`} disabled={pending || selected.size === 0} onClick={() => void answer({ option_indices: [...selected].sort((a, b) => a - b) })}>
          {selected.size > 0 ? t("Submit ({n})", { n: selected.size }) : t("Submit")}
        </button>
      )}
      {prompt.custom_option_index !== null && (
        <div className="prompt-card-custom">
          {hasChoices && <span className="prompt-card-custom-label" id={customLabelId}>{t("Or type your own answer")}</span>}
          <div className="prompt-card-custom-row">
            <input className="input" value={custom} disabled={pending} placeholder={prompt.options[prompt.custom_option_index]?.label ?? t("Type an answer")} aria-label={hasChoices ? undefined : t("Custom answer")} aria-labelledby={hasChoices ? customLabelId : undefined} onChange={(event) => setCustom(event.currentTarget.value)} onKeyDown={(event) => {
              // an IME's Enter commits the candidate; WebKit can send it after compositionend, as key code 229
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && custom.trim().length > 0) void answer({ custom_text: custom.trim() });
            }} />
            <button type="button" className={`btn${custom.trim().length > 0 ? " btn-primary" : ""}`} disabled={pending || custom.trim().length === 0} onClick={() => void answer({ custom_text: custom.trim() })}>
              <Send aria-hidden="true" /> {t("Send")}
            </button>
          </div>
        </div>
      )}
      {typedAnswer?.option_index !== undefined && (
        <div className="prompt-card-confirm" role="alert" ref={confirmRef}>
          <span>{t("Send {answer}?", { answer: `${typedAnswer.option_index + 1}. ${prompt.options[typedAnswer.option_index]?.label ?? ""}` })}</span>
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void answer(typedAnswer).finally(() => onTypedAnswerDone?.())}>{t("Confirm")}</button>
          <button type="button" className="btn" disabled={pending} onClick={() => onTypedAnswerDone?.()}>{t("Cancel")}</button>
        </div>
      )}
      {error !== null && <p className="prompt-card-error" role="alert">{error}</p>}
    </section>
  );
}

export interface UnreadablePromptCardProps {
  paneId: string;
  prompt: UnreadablePrompt;
  onPromptChanged(): void;
  onAnswered(): void;
  onDismiss(): void;
}

/**
 * A dialog the parsers do not read (server/unreadable-prompt.ts): its last rows as the terminal
 * shows them, with its numbered options and the keys the rows name as one-tap presses. Each press
 * is checked against the dialog still on screen before it is sent.
 */
export function UnreadablePromptCard({ paneId, prompt, onPromptChanged, onAnswered, onDismiss }: UnreadablePromptCardProps) {
  const t = useT();
  const { answerPanePrompt } = useMachineApi();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPending(false);
    setError(null);
  }, [prompt.id]);

  const press = async (action: UnreadablePromptAction): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await answerPanePrompt({ pane_id: paneId, prompt_id: prompt.id, action: action.id });
      onAnswered();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && cause.code === "prompt_changed") {
        setError(t("The screen changed; check it and press again."));
        onPromptChanged();
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setPending(false);
    }
  };

  const options = prompt.actions.filter((action) => action.id.startsWith("option-"));
  const keys = prompt.actions.filter((action) => !action.id.startsWith("option-"));

  return (
    <section className="prompt-card is-unreadable" role="region" aria-label={t("The terminal is waiting")} aria-busy={pending}>
      <header className="prompt-card-header">
        <span className="badge badge-blocked">{t("input needed")}</span>
        <h2>{t("The terminal is waiting")}</h2>
        <button type="button" className="icon-button prompt-card-dismiss" aria-label={t("Hide")} title={t("Hide")} onClick={onDismiss}>
          <X aria-hidden="true" />
        </button>
      </header>
      <p className="prompt-card-hint">{t("This dialog can't be read as a card. Its last rows, and the keys they name:")}</p>
      <pre className="prompt-card-body">{prompt.lines.join("\n")}</pre>
      {options.length > 0 && (
        <div className="prompt-card-options">
          {options.map((option) => (
            <button key={option.id} type="button" className="prompt-card-option" disabled={pending} onClick={() => void press(option)}>
              <span className="prompt-card-number">{option.text}.</span>{" "}
              <span className="prompt-card-option-text"><span className="prompt-card-option-label">{option.label.replace(/^\d+[.)]\s*/, "")}</span></span>
            </button>
          ))}
        </div>
      )}
      {keys.length > 0 && (
        <div className="prompt-card-keys" role="group" aria-label={t("Keys")}>
          {keys.map((key) => (
            <button key={key.id} type="button" className="btn prompt-card-key" disabled={pending} onClick={() => void press(key)}>{key.label}</button>
          ))}
        </div>
      )}
      {error !== null && <p className="prompt-card-error" role="alert">{error}</p>}
    </section>
  );
}
