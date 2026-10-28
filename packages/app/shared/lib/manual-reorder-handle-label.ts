const MANUAL_REORDER_HANDLE_LABEL_PREFIX = "Drag to reorder ";

/** Match the row-specific accessible names used by manual reorder handles. */
export const MANUAL_REORDER_HANDLE_NAME_PATTERN = new RegExp(
  `^${MANUAL_REORDER_HANDLE_LABEL_PREFIX}.+$`
);

/** Build the accessible name for one manual reorder handle. */
export function manualReorderHandleLabel(rowLabel: string): string {
  return `${MANUAL_REORDER_HANDLE_LABEL_PREFIX}${rowLabel}`;
}
