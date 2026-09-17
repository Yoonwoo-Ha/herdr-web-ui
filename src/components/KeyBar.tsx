import type { MouseEvent, PointerEvent, ReactNode } from "react";

import "./KeyBar.css";

import type { KeyBarKey } from "../lib/keys.ts";

export type { KeyBarKey };

export interface KeyBarProps {
  /** Fires for every key except Control, which toggles the one-shot modifier instead. */
  onKey: (key: KeyBarKey) => void;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
}

/**
 * Cancelling pointerdown AND mousedown keeps focus, and with it the soft
 * keyboard, on xterm's textarea; the click still fires.
 */
function keepFocus(event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

interface KeyProps {
  dataKey: string;
  label?: string;
  pressed?: boolean;
  onPress: () => void;
  children: ReactNode;
}

function Key({ dataKey, label, pressed, onPress, children }: KeyProps) {
  return (
    <button
      type="button"
      className={`key${pressed ? " is-armed" : ""}`}
      data-key={dataKey}
      aria-label={label}
      aria-pressed={pressed}
      tabIndex={-1}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

type Direction = "up" | "down" | "left" | "right";

const CHEVRON: Record<Direction, string> = {
  up: "M5 12.5l5-5 5 5",
  down: "M5 7.5l5 5 5-5",
  left: "M12.5 5l-5 5 5 5",
  right: "M7.5 5l5 5-5 5",
};

function Chevron({ direction }: { direction: Direction }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={CHEVRON[direction]} />
    </svg>
  );
}

const ARROWS: ReadonlyArray<{ key: KeyBarKey; label: string; direction: Direction }> = [
  { key: "ArrowUp", label: "Up", direction: "up" },
  { key: "ArrowDown", label: "Down", direction: "down" },
  { key: "ArrowLeft", label: "Left", direction: "left" },
  { key: "ArrowRight", label: "Right", direction: "right" },
];

/**
 * Touch key bar under the terminal. Keys are tabIndex -1 on purpose: they exist
 * for touch, a hardware keyboard already has all of them.
 */
export function KeyBar({ onKey, ctrlArmed, onToggleCtrl }: KeyBarProps) {
  return (
    <div className="key-bar" role="toolbar" aria-label="Terminal keys">
      <Key dataKey="Escape" onPress={() => onKey("Escape")}>
        Esc
      </Key>
      <Key dataKey="Tab" onPress={() => onKey("Tab")}>
        Tab
      </Key>
      <Key dataKey="Control" pressed={ctrlArmed} onPress={onToggleCtrl}>
        Ctrl
      </Key>
      {ARROWS.map((arrow) => (
        <Key key={arrow.key} dataKey={arrow.key} label={arrow.label} onPress={() => onKey(arrow.key)}>
          <Chevron direction={arrow.direction} />
        </Key>
      ))}
      <Key dataKey="ctrl-c" label="Control C" onPress={() => onKey("ctrl-c")}>
        ^C
      </Key>
    </div>
  );
}
