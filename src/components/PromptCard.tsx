import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";

import "./PromptCard.css";

import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import type { InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import type { TypedAnswer } from "../lib/promptAnswer.ts";

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

  return (
    <section className="prompt-card" role="region" aria-label="Agent is asking" aria-busy={pending}>
      <header className="prompt-card-header">
        <span className="badge badge-blocked">input needed</span>
        <h2>{prompt.title}</h2>
      </header>
      <p className="prompt-card-question">{prompt.question}</p>
      {prompt.queued && <p className="prompt-card-hint">Codex keeps working meanwhile. Answer here; the message box still talks to Codex.</p>}
      {prompt.body !== null && prompt.body.length > 0 && <pre className="prompt-card-body">{prompt.body}</pre>}
      <div className="prompt-card-options">
        {prompt.options.map((option, index) => {
          if (index === prompt.custom_option_index) return null;
          if (prompt.multi_select) {
            return (
              <label className="prompt-card-check" key={index}>
                <input type="checkbox" checked={selected.has(index)} disabled={pending} onChange={() => toggle(index)} />
                <span><strong><span className="prompt-card-number">{index + 1}.</span> {option.label}</strong>{option.description !== null && <small>{option.description}</small>}</span>
              </label>
            );
          }
          return (
            <button key={index} type="button" className={`${index === 0 ? "btn btn-primary" : "btn"}${typedAnswer?.option_index === index ? " is-typed" : ""}`} disabled={pending} onClick={() => void answer({ option_index: index })}>
              <span><span className="prompt-card-number">{index + 1}.</span> {option.label}</span>{option.description !== null && <small>{option.description}</small>}
            </button>
          );
        })}
      </div>
      {prompt.multi_select && (
        <button type="button" className="btn btn-primary prompt-card-submit" disabled={pending || selected.size === 0} onClick={() => void answer({ option_indices: [...selected].sort((a, b) => a - b) })}>
          Submit
        </button>
      )}
      {prompt.custom_option_index !== null && (
        <div className="prompt-card-custom">
          <input className="input" value={custom} disabled={pending} placeholder={prompt.options[prompt.custom_option_index]?.label ?? "Type an answer"} aria-label="Custom answer" onChange={(event) => setCustom(event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && custom.trim().length > 0) void answer({ custom_text: custom.trim() });
          }} />
          <button type="button" className="btn btn-primary" disabled={pending || custom.trim().length === 0} onClick={() => void answer({ custom_text: custom.trim() })}>
            <Send aria-hidden="true" /> Send
          </button>
        </div>
      )}
      {typedAnswer?.option_index !== undefined && (
        <div className="prompt-card-confirm" role="alert" ref={confirmRef}>
          <span>Send <strong>{typedAnswer.option_index + 1}. {prompt.options[typedAnswer.option_index]?.label}</strong>?</span>
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void answer(typedAnswer).finally(() => onTypedAnswerDone?.())}>Confirm</button>
          <button type="button" className="btn" disabled={pending} onClick={() => onTypedAnswerDone?.()}>Cancel</button>
        </div>
      )}
      {error !== null && <p className="prompt-card-error" role="alert">{error}</p>}
    </section>
  );
}
