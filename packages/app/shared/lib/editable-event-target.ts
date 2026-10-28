/**
 * Does a keystroke belong to whatever the user is typing in? (ISS-9092)
 *
 * THIS IS THE DEFECT THE UNDO LAYER IS MOST LIKELY TO SHIP. A text field, a
 * `contenteditable`, and the Liveblocks/Yjs document editor each own a native
 * or built-in undo stack of their own. Stealing Cmd+Z from one of them makes
 * the app feel broken in the most visible way possible: the user's last typed
 * word stops coming back and some unrelated row changes instead.
 *
 * So the rule is a REFUSAL, not a preference: when focus is inside an editable
 * region the app-level layer does nothing at all — it does not `preventDefault`
 * and does not consult the stack, leaving the keystroke to the field that owns
 * it. The Yjs editor needs no special case because it renders a
 * `contenteditable` host, which the `contenteditable` ATTRIBUTE check below
 * already covers — see {@link ownsNativeUndo} for why the attribute and not
 * `isContentEditable` is the primary signal;
 * `data-app-undo-ignore` is there for a future surface that owns an
 * undo stack WITHOUT being contenteditable, so it can opt out by declaration
 * rather than by this module learning its class name.
 *
 * Pure with respect to browser globals: it reads only the element it is handed
 * and that element's ancestors, never `window` or `document`, so importing it
 * from SSR-capable shared code is safe.
 */

/** Opt-out hook for a surface that owns its own undo and is not editable. */
export const APP_UNDO_IGNORE_ATTRIBUTE = "data-app-undo-ignore";

/**
 * `<input type>` values that do NOT accept free text, and therefore have no
 * native undo to protect.
 *
 * An ALLOW-list of non-text types rather than a deny-list of text ones, because
 * the deny-list is the side inventory that rots: `type="search"`, `type="url"`,
 * `type="tel"` and a bare `<input>` with no `type` at all are every bit as
 * typable as `type="text"`, and a list naming only the ones someone remembered
 * silently un-protects the rest. A type nobody anticipated is treated as
 * typable, which is the safe direction — the cost is one shortcut that does not
 * fire, not a swallowed keystroke.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isTypableInput(element: Element): boolean {
  if (element.tagName !== "INPUT") {
    return false;
  }
  const type = element.getAttribute("type")?.toLowerCase() ?? "text";
  return !NON_TEXT_INPUT_TYPES.has(type);
}

/** Hosts that may own a native or built-in undo stack. */
const EDITABLE_HOST_SELECTOR = "input, textarea, select, [contenteditable]";

/**
 * True when the event target is, or sits inside, a region that owns its own
 * undo.
 *
 * Walks the ancestor chain rather than testing the nearest match alone. The
 * nearest match can be a `contenteditable="false"` ISLAND — a real and
 * load-bearing value marking a non-editable region nested inside an editable
 * host — and that island reports `isContentEditable === false` while the editor
 * around it still owns Cmd+Z. Stopping at it would hand the chord to the app
 * layer in the middle of the Yjs editor, which is precisely the defect this
 * module exists to prevent, so the search continues upward instead.
 */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest(`[${APP_UNDO_IGNORE_ATTRIBUTE}]`)) {
    return true;
  }
  let candidate = target.closest(EDITABLE_HOST_SELECTOR);
  while (candidate) {
    if (ownsNativeUndo(candidate)) {
      return true;
    }
    candidate =
      candidate.parentElement?.closest(EDITABLE_HOST_SELECTOR) ?? null;
  }
  return false;
}

/**
 * The `contenteditable` values that mean "the user types here". Everything
 * except the explicit opt-out `false` is editable: the attribute is valid as
 * `""` and `"true"`, and `"plaintext-only"` is a real editing host too.
 */
const NON_EDITABLE_CONTENTEDITABLE_VALUE = "false";

/** Does this specific element carry a native or built-in undo stack? */
function ownsNativeUndo(element: Element): boolean {
  if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") {
    return true;
  }
  if (isTypableInput(element)) {
    return true;
  }
  const contentEditable = element.getAttribute("contenteditable");
  if (contentEditable !== null) {
    return contentEditable.toLowerCase() !== NON_EDITABLE_CONTENTEDITABLE_VALUE;
  }
  // Only reached for an element matched by a non-`contenteditable` part of the
  // selector. `isContentEditable` is the INHERITANCE backstop for a real
  // browser; it is deliberately not the primary signal, because jsdom does not
  // implement it at all — it answers `false` for every element, including a
  // `contenteditable="true"` host — so a guard resting on it is one this repo's
  // test environment cannot exercise, on exactly the Yjs editor surface this
  // module exists to protect.
  return element instanceof HTMLElement && element.isContentEditable;
}
