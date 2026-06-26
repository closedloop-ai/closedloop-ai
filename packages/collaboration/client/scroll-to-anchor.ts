const SCROLL_HIGHLIGHT_DURATION_MS = 1600;
const THREAD_MARK_SELECTOR = ".lb-tiptap-thread-mark";
const SCROLL_HIGHLIGHT_ATTR = "data-scroll-highlight";

/**
 * Scrolls the document editor to the inline anchor for the given thread
 * and applies a brief highlight. Imperative — call from a click handler.
 *
 * Resolves the anchor by querying the `.lb-tiptap-thread-mark` decoration
 * painted by `@liveblocks/react-tiptap`. The CSS in
 * `packages/collaboration/comments.css` defines the highlight animation
 * triggered by `data-scroll-highlight="true"`.
 *
 * No-op when the mark is not in the DOM (editor not yet mounted, thread
 * not currently anchored, etc.) — logs a warning instead of throwing.
 *
 * Callers are responsible for gating on whether the thread is anchored.
 * Floating and artifact-level threads have no live decoration to scroll
 * to, so calling this for them would just log a warning.
 *
 * Forward-looking note: collapsible-section auto-expansion (PRD AC-US7.4)
 * is out of scope for FEA-1122. The current Tiptap schema has no
 * collapsible/details node, so the skip-when-not-supported path is the
 * active path. If a `<details>`-shaped node is added later, walk
 * `element.parentElement` ancestors and `open = true` any
 * `HTMLDetailsElement` before the `scrollIntoView` call.
 */
export function scrollToAnchor(threadId: string): void {
  const selector = `${THREAD_MARK_SELECTOR}[data-lb-thread-id="${CSS.escape(threadId)}"]`;
  const element = globalThis.document.querySelector<HTMLElement>(selector);

  if (element === null) {
    return;
  }

  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.setAttribute(SCROLL_HIGHLIGHT_ATTR, "true");
  globalThis.setTimeout(() => {
    element.removeAttribute(SCROLL_HIGHLIGHT_ATTR);
  }, SCROLL_HIGHLIGHT_DURATION_MS);
}
