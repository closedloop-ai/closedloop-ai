/**
 * Hides the browser's native drag ghost so the grid's own drag preview chip is
 * the only image under the pointer.
 *
 * The blank image must be IN the document when `setDragImage` reads it: WebKit
 * (Safari) aborts a drag whose image is a detached element, firing `dragend`
 * straight after `dragstart`, so no row could be dragged there (ISS-12901).
 * Chromium accepts either. The canvas is mounted offscreen and removed on the
 * next task, after the browser has taken its snapshot.
 */
export function hideNativeDragImage(dataTransfer: DataTransfer): void {
  if (!dataTransfer.setDragImage) {
    return;
  }
  const blankImage = globalThis.document.createElement("canvas");
  blankImage.width = 1;
  blankImage.height = 1;
  blankImage.setAttribute("aria-hidden", "true");
  blankImage.style.cssText =
    "position:fixed;left:-10px;top:-10px;pointer-events:none";
  globalThis.document.body.append(blankImage);
  dataTransfer.setDragImage(blankImage, 0, 0);
  setTimeout(() => blankImage.remove(), 0);
}
