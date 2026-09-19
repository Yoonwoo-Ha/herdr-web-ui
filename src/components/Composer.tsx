import { useCallback, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";

import "./Composer.css";

import { imageMention, MAX_COMPOSER_CHARS } from "../lib/compose.ts";

export interface ComposerProps {
  /** false while the socket is down: text is kept in the textarea, sending waits */
  connected: boolean;
  /** One send = one bracketed-paste payload for the pane (PaneTerminal owns the pty path). */
  onSend: (text: string) => void;
  /** Stores one image next to the pane; resolves to its absolute path. */
  onUploadImage: (file: File) => Promise<string>;
}

/** A pick or paste uploads at most this many images in one go. */
const MAX_IMAGES_PER_ACTION = 4;

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/**
 * Chat-style composer under the terminal. A textarea, not the pty, receives the
 * keystrokes: multiline paste stays literal, images become server-side files the
 * prompt references by path, and nothing is queued while disconnected - Send simply
 * waits, exactly like the terminal's held-input draft policy.
 */
export function Composer({ connected, onSend, onUploadImage }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState<{ kind: "info" | "error"; message: string } | null>(null);

  // the box grows with its text but stops at 10 lines; beyond that it scrolls
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);

  const insertAtCursor = useCallback((snippet: string) => {
    const element = textareaRef.current;
    if (!element) {
      setText((previous) => previous + snippet);
      return;
    }
    const start = element.selectionStart ?? element.textLength;
    const end = element.selectionEnd ?? start;
    setText(element.value.slice(0, start) + snippet + element.value.slice(end));
    requestAnimationFrame(() => {
      element.selectionStart = element.selectionEnd = start + snippet.length;
      element.focus();
    });
  }, []);

  const uploadImages = useCallback(
    async (files: readonly File[]) => {
      const images = files.filter((file) => (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type));
      if (images.length === 0) return;
      setUploading(true);
      setNote(null);
      try {
        for (const image of images.slice(0, MAX_IMAGES_PER_ACTION)) {
          const path = await onUploadImage(image);
          insertAtCursor(imageMention(path));
        }
      } catch (error) {
        setNote({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        setUploading(false);
      }
    },
    [insertAtCursor, onUploadImage],
  );

  // images pasted into the box go to the server, never into the text
  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const images = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file" && (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(item.type))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (images.length === 0) return; // plain text paste: the textarea handles it
      event.preventDefault();
      void uploadImages(images);
    },
    [uploadImages],
  );

  const onPick = useCallback(() => {
    const input = fileInputRef.current;
    if (!input || !input.files || input.files.length === 0) return;
    const picked = Array.from(input.files);
    input.value = ""; // let the same file be picked again next time
    void uploadImages(picked);
  }, [uploadImages]);

  const send = useCallback(() => {
    const current = text;
    if (!connected || uploading || current.trim().length === 0) return;
    onSend(current);
    setText("");
    setNote(null);
  }, [connected, onSend, text, uploading]);

  // Enter sends, Shift+Enter breaks the line; an IME composition's Enter (Korean
  // input) confirms the composition instead - never a premature send
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      send();
    },
    [send],
  );

  const hint = !connected
    ? "reconnecting… held here, never queued"
    : uploading
      ? "uploading image…"
      : null;

  return (
    <div className="composer" role="group" aria-label="Message composer">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        multiple
        hidden
        onChange={onPick}
      />
      <textarea
        ref={textareaRef}
        className="composer-text"
        rows={1}
        maxLength={MAX_COMPOSER_CHARS}
        value={text}
        placeholder={connected ? "Message — paste an image or type @/path" : "reconnecting…"}
        aria-label="Message"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={!connected}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          setText(event.target.value);
          if (note?.kind === "error") setNote(null);
        }}
      />
      <button
        type="button"
        className="composer-button composer-attach"
        aria-label="Attach images"
        disabled={!connected || uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21.4 11.05l-8.49 8.49a5 5 0 01-7.07-7.07l8.49-8.49a3 3 0 014.24 4.24l-8.49 8.49a1 1 0 01-1.41-1.41l7.78-7.78" />
        </svg>
      </button>
      <button
        type="button"
        className="composer-button composer-send"
        disabled={!connected || uploading || text.trim().length === 0}
        onClick={send}
      >
        Send
      </button>
      {(note || hint) && (
        <div className={`composer-note${note?.kind === "error" ? " is-error" : ""}`} role={note?.kind === "error" ? "alert" : "status"}>
          {note ? note.message : hint}
        </div>
      )}
    </div>
  );
}
