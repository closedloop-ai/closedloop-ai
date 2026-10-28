type GridRowDragPointerIntent = {
  pointerId: number;
  target: EventTarget | null;
};

type GridRowDragPointerEvent = {
  button: number;
  currentTarget: HTMLElement;
  pointerId: number;
  pointerType: string;
  target: EventTarget | null;
};

const gridRowDragPointerIntents = new WeakMap<
  HTMLElement,
  GridRowDragPointerIntent
>();
const canceledGridRowDragPointers = new WeakSet<HTMLElement>();
const capturedGridRowDragPointers = new WeakMap<HTMLElement, number>();

/** Records an eligible potential row drag without taking pointer ownership. */
export function beginGridRowDragPointerIntent(
  event: GridRowDragPointerEvent,
  canStartRowDrag: boolean
): void {
  cancelGridRowDragPointerIntent(event.currentTarget);
  if (
    !canStartRowDrag ||
    event.button !== 0 ||
    event.pointerType === "touch"
  ) {
    cancelGridRowDragPointerIntent(event.currentTarget);
    canceledGridRowDragPointers.add(event.currentTarget);
    return;
  }
  canceledGridRowDragPointers.delete(event.currentTarget);
  gridRowDragPointerIntents.set(event.currentTarget, {
    pointerId: event.pointerId,
    target: event.target,
  });
}

/** Cancels the matching pointer stream and releases any accepted drag capture. */
export function cancelGridRowDragPointerIntent(
  element: HTMLElement,
  pointerId?: number
): void {
  const intent = gridRowDragPointerIntents.get(element);
  const capturedPointerId = capturedGridRowDragPointers.get(element);
  if (
    pointerId !== undefined &&
    intent?.pointerId !== pointerId &&
    capturedPointerId !== pointerId
  ) {
    return;
  }
  gridRowDragPointerIntents.delete(element);
  capturedGridRowDragPointers.delete(element);
  if (intent || capturedPointerId !== undefined) {
    canceledGridRowDragPointers.add(element);
  }
  if (
    capturedPointerId !== undefined &&
    element.hasPointerCapture?.(capturedPointerId)
  ) {
    element.releasePointerCapture(capturedPointerId);
  }
}

/** Consumes the originating target and cancellation result for native dragstart. */
export function consumeGridRowDragPointerIntent(
  element: HTMLElement
):
  | { canceled: boolean; pointerId?: number; target: EventTarget | null }
  | undefined {
  const intent = gridRowDragPointerIntents.get(element);
  if (!intent) {
    if (canceledGridRowDragPointers.delete(element)) {
      return { canceled: true, target: null };
    }
    return undefined;
  }
  gridRowDragPointerIntents.delete(element);
  return { canceled: false, pointerId: intent.pointerId, target: intent.target };
}

/** Acquires capture only after an accepted native dragstart crosses the platform threshold. */
export function captureGridRowDragPointerIntent(
  element: HTMLElement,
  pointerId: number | undefined
): void {
  if (pointerId === undefined || !element.setPointerCapture) {
    return;
  }
  element.setPointerCapture(pointerId);
  capturedGridRowDragPointers.set(element, pointerId);
}
