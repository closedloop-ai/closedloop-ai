/**
 * The swatch classes the add-field dialog offers for an enum option.
 *
 * Split out of `table-add-field-dialog-fields.tsx` so a consumer that needs the
 * VOCABULARY rather than the editor can import it without pulling the dialog's
 * React tree in. A consumer that PERSISTS an option's colour is expected to map
 * this tuple onto its own stored vocabulary rather than write a class into a
 * record — key that map by {@link TableFieldOptionColorClass} and adding a
 * swatch here fails the consumer's `tsc` until it has been given a value.
 */
export const TABLE_FIELD_OPTION_COLORS = [
  "bg-success",
  "bg-warning",
  "bg-primary",
] as const;

/** One swatch class the dialog can hand back on a draft. */
export type TableFieldOptionColorClass =
  (typeof TABLE_FIELD_OPTION_COLORS)[number];
