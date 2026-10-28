const ARTIFACT_SELECTION_PRESERVE_SELECTOR =
  "[data-preserve-artifact-selection], [data-grid-group-toggle]";

type ArtifactSelectionPointer = Readonly<{
  ctrlKey?: boolean;
  metaKey?: boolean;
  offsetX?: number;
  offsetY?: number;
  shiftKey?: boolean;
}>;

/**
 * The dismissal boundary in `project-hierarchy-spec.ts`: an ordinary primary
 * click anywhere clears the selected set before its own handler runs, so a row
 * click then replaces the set with its item. Modifier gestures extend the set,
 * controls marked `data-preserve-artifact-selection` act on it, and grabbing a
 * scrollbar scrolls rather than clicks.
 */
export function shouldClearArtifactSelectionFromPointerTarget(
  target: EventTarget | null,
  pointer: ArtifactSelectionPointer = {}
): boolean {
  if (pointer.shiftKey || pointer.metaKey || pointer.ctrlKey) {
    return false;
  }
  if (!(target instanceof Element) || isScrollbarPointer(target, pointer)) {
    return false;
  }
  return target.closest(ARTIFACT_SELECTION_PRESERVE_SELECTOR) === null;
}

// A scrollbar press targets the scrolling element, at an offset past its
// client box (which excludes the scrollbar).
function isScrollbarPointer(
  target: Element,
  { offsetX = 0, offsetY = 0 }: ArtifactSelectionPointer
): boolean {
  const verticalScrollbar =
    target.scrollHeight > target.clientHeight && offsetX > target.clientWidth;
  const horizontalScrollbar =
    target.scrollWidth > target.clientWidth && offsetY > target.clientHeight;
  return verticalScrollbar || horizontalScrollbar;
}
