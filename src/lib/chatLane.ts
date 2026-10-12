import { useLayoutEffect, type RefObject } from "react";

import { chatLaneLength, useSettings } from "./settings.ts";

/**
 * Settings → Chat width, Default: the lane follows the pane. It is one length, written as
 * `--chat-w` on the element whose columns share it: the transcript, the composer column, the held
 * list and the menus inherit it from their pane's `.terminal-stack`, and a file viewer's Markdown
 * preview from the viewer. A percentage would resolve against each column's own box and leave them
 * a gutter apart. The other steps are fixed and stay with the stylesheet (styles.css), so the
 * length is removed for them. The lane's ceiling stays 60rem inside the length, so a change of the
 * browser's font size moves it at once, as it moves Wide's 72rem.
 *
 * Writes the lane of the pane `locate` finds on `target`, and keeps it as that pane is resized.
 * `locate` is read when `key` or the setting changes, so `key` names the pane it finds. A pane
 * mounted anew leaves the one observed detached and 0 wide: the stylesheet's floor then stands.
 */
function useLaneOf(target: RefObject<HTMLElement | null>, locate: () => HTMLElement | null, key: string | null): void {
  const { settings } = useSettings();
  useLayoutEffect(() => {
    const surface = target.current;
    if (!surface) return;
    const pane = settings.chatWidth === "default" ? locate() : null;
    if (!pane) {
      surface.style.removeProperty("--chat-w");
      return;
    }
    const apply = (): void => {
      if (pane.isConnected) surface.style.setProperty("--chat-w", chatLaneLength(pane.clientWidth));
      else surface.style.removeProperty("--chat-w");
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(pane);
    return () => observer.disconnect();
    // `locate` is a new function each render; `key` stands for what it finds
  }, [target, key, settings.chatWidth]);
}

/** The lane of the pane whose `.terminal-stack` this is, written on that stack for its columns. */
export function usePaneLane(stack: RefObject<HTMLElement | null>): void {
  useLaneOf(stack, () => stack.current, null);
}

/**
 * The lane of the pane `owner` (`paneStorageId`, the stack's `data-pane-owner` in PaneTerminal),
 * written on `target`: an overlay outside every stack, such as the file viewer, as wide as that
 * pane's chat, also with a second pane open beside it. No `owner`, or no such pane mounted: the
 * stylesheet's Default stands.
 */
export function useOpeningPaneLane(target: RefObject<HTMLElement | null>, owner: string | null): void {
  useLaneOf(target, () => owner === null ? null : document.querySelector<HTMLElement>(`.terminal-stack[data-pane-owner="${CSS.escape(owner)}"]`), owner);
}
