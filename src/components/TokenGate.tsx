import "./TokenGate.css";

import { type FormEvent, useRef, useState } from "react";

import { ApiError, authenticate } from "../lib/api.ts";

const MISMATCH = "Token does not match.";

export interface TokenGateProps {
  /** Fires once POST /api/auth answered 204: the cookie is set and the shell can mount. */
  onUnlocked: () => void;
}

/**
 * Sign-in screen rendered instead of the shell while the server requires a token
 * the browser does not hold. The token is never stored here: the server answers
 * with an HttpOnly cookie, so a successful submit only has to tell App to mount
 * the shell, and every later fetch and the WebSocket upgrade carry the cookie.
 */
export function TokenGate({ onUnlocked }: TokenGateProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    if (token === "") {
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await authenticate(token);
      onUnlocked();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? MISMATCH : err instanceof Error ? err.message : String(err));
      setSubmitting(false);
      // a click on the button moved focus there and disabling it dropped focus: hand it back, ready to retype
      inputRef.current?.select();
    }
  };

  return (
    <main className="token-gate-screen">
      <form className="token-gate" data-testid="token-gate" aria-labelledby="token-gate-title" onSubmit={(event) => void submit(event)}>
        <img src="/icons/icon.svg" alt="" width="44" height="44" className="token-gate-mark" />
        <h1 id="token-gate-title" className="token-gate-title">
          herdr <span className="brand-sub">web ui</span>
        </h1>
        <p className="token-gate-copy">This server requires an access token.</p>
        <label className="token-gate-label" htmlFor="token-gate-input">
          Access token
        </label>
        <input
          ref={inputRef}
          id="token-gate-input"
          className="token-gate-input"
          type="password"
          name="token"
          autoComplete="current-password"
          autoFocus
          aria-label="Access token"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? "token-gate-error" : undefined}
          inputMode="text"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <button type="submit" className="token-gate-submit" disabled={submitting}>
          {submitting ? "Unlocking…" : "Unlock"}
        </button>
        {error !== null && (
          <p id="token-gate-error" className="token-gate-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
