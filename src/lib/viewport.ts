/*
 * Sizes the shell to the VISUAL viewport. When the soft keyboard opens, iOS
 * Safari shrinks window.visualViewport but leaves the layout viewport (and so
 * 100dvh) at full height and scrolls the page to reveal the focused textarea,
 * which drags the header off-screen and puts the key bar under the keyboard.
 * Publishing the visual height as --app-height (read by .app in styles.css)
 * and pinning the page at (0, 0) keeps header, terminal and key bar in view.
 * Chrome resizes the layout viewport itself (interactive-widget=resizes-content
 * in index.html), so there the same value changes nothing.
 *
 * Only the shell (.app) is pinned. The token gate sizes itself to the same height
 * and is otherwise a plain page: pinning it fought iOS scrolling the focused field
 * into view, and a second tap on the field (to paste) landed after the page jumped,
 * off the field, which dismissed the keyboard.
 */

const viewport = window.visualViewport;

if (viewport) {
  const sync = (): void => {
    document.documentElement.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
    if (document.querySelector(".app") !== null) window.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  sync();
}

/**
 * Marks the page while a phone's soft keyboard is up, so the composer drops the
 * home-indicator space the keyboard covers (Composer.css). Viewport sizes do not
 * tell: iOS Safari 26 resizes both viewports with the keyboard. A touch device
 * with a text field focused has its keyboard up - except xterm's own hidden field,
 * which the app focuses on its own, and which never raises a keyboard that way.
 */
const touch = window.matchMedia("(pointer: coarse)");
const typing = (element: Element | null): boolean =>
  (element instanceof HTMLTextAreaElement && !element.classList.contains("xterm-helper-textarea"))
  || (element instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(element.type))
  || (element instanceof HTMLElement && element.isContentEditable);
const syncKeyboard = (): void => {
  document.documentElement.toggleAttribute("data-keyboard", touch.matches && typing(document.activeElement));
};
document.addEventListener("focusin", syncKeyboard);
// focus moving from one field to the next blurs first: read where it landed
document.addEventListener("focusout", () => window.setTimeout(syncKeyboard, 0));
syncKeyboard();
