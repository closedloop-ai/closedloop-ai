const GRID_INTERACTION_CONTRACT_SELECTOR =
  '[data-grid-interaction-contract="pointer-hover"]';

/** Transient states that the pointer and hover contract renders consistently. */
export const GridInteractionState = {
  Dragging: "dragging",
  DragOver: "drag-over",
  Editing: "editing",
  Error: "error",
  Loading: "loading",
} as const;
export type GridInteractionState =
  (typeof GridInteractionState)[keyof typeof GridInteractionState];

/** Sets one transient interaction state without React render latency. */
export function setGridInteractionState(
  element: HTMLElement,
  state: GridInteractionState
): void {
  element.dataset.interactionState = state;
}

/** Clears one transient state only when it still owns the element. */
export function clearGridInteractionState(
  element: HTMLElement,
  state: GridInteractionState
): void {
  if (element.dataset.interactionState === state) {
    element.removeAttribute("data-interaction-state");
  }
}

/** Clears every drag-over destination inside the nearest mastered contract. */
export function clearGridDragOverStates(row: HTMLElement): void {
  const contract = row.closest<HTMLElement>(GRID_INTERACTION_CONTRACT_SELECTOR);
  contract
    ?.querySelectorAll<HTMLElement>(
      `[data-interaction-state="${GridInteractionState.DragOver}"]`
    )
    .forEach((element) =>
      clearGridInteractionState(element, GridInteractionState.DragOver)
    );
}

/** Reports whether an element is inside the mastered interaction contract. */
export function hasGridInteractionContract(element: HTMLElement): boolean {
  return element.closest(GRID_INTERACTION_CONTRACT_SELECTOR) !== null;
}

/** Makes one nested group the only painted drag-over destination. */
export function setExclusiveGridDragOverState(element: HTMLElement): void {
  const contract = element.closest<HTMLElement>(
    GRID_INTERACTION_CONTRACT_SELECTOR
  );
  contract
    ?.querySelectorAll<HTMLElement>(
      `[data-interaction-state="${GridInteractionState.DragOver}"]`
    )
    .forEach((candidate) => {
      if (candidate !== element) {
        clearGridInteractionState(candidate, GridInteractionState.DragOver);
      }
    });
  setGridInteractionState(element, GridInteractionState.DragOver);
}
