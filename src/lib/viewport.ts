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
    // iOS keeps the layout viewport when the soft keyboard opens and shrinks only the
    // visual one: a shortfall that large at scale 1 is the keyboard (a pinch zoom scales
    // instead). The composer then drops the home-indicator space the keyboard covers.
    const keyboard = Math.abs(viewport.scale - 1) < 0.01 && window.innerHeight - viewport.height > 120;
    document.documentElement.toggleAttribute("data-keyboard", keyboard);
    if (document.querySelector(".app") !== null) window.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  sync();
}
