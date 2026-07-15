import type { KeyboardEvent, KeyboardEventHandler } from "react";

/**
 * Returns an `onKeyDown` handler that activates a keyboard-focusable element
 * (one carrying `role="button"` + `tabIndex={0}`) on Enter or Space, matching
 * native button semantics.
 *
 * The activation only fires when the event originates on the element itself
 * (`currentTarget === target`), so keydowns bubbling up from any nested
 * interactive control (links, buttons) are ignored and keep their own behavior.
 *
 * A product-agnostic UI primitive: the desktop renderer and the shared
 * `@repo/app` feature slices both hand-rolled this identical click-affordance
 * keyboard handling, so it lives here to stay in one place.
 */
export function activateOnEnterOrSpace<T extends Element>(
  onActivate: () => void
): KeyboardEventHandler<T> {
  return (event: KeyboardEvent<T>) => {
    if (event.currentTarget !== event.target) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate();
    }
  };
}
