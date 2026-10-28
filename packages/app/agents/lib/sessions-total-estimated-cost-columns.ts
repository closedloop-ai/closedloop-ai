import { TOTAL_ESTIMATED_COST_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import {
  SESSIONS_COLUMN_SPECS,
  SESSIONS_COLUMN_WIDTH_PX,
  SESSIONS_COST_COLUMN_ID,
} from "./sessions-table-columns";

/** Every column's header label, keyed by id — the spec's own word, unchanged. */
export const SESSIONS_COLUMN_LABELS: Readonly<Record<string, string>> =
  Object.fromEntries(
    SESSIONS_COLUMN_SPECS.map((spec) => [spec.id, spec.label])
  );

/**
 * The list surface's header labels: the spec's own word for every column, with
 * the Cost column on the one dollar phrase the card beside it headlines.
 *
 * Deliberately NOT folded into the spec's own `label`. That label is also what
 * the columns menu (`sessionsToggleableColumns`) offers, and the Options menu
 * already carries a SUMMARY-CARD row under this same phrase — two menu rows with
 * one accessible name. Which of the two should be renamed is a product question
 * this module does not get to answer, so the header takes the phrase and the
 * menu keeps the spec's word until someone rules on it.
 */
export const TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_LABELS: Readonly<
  Record<string, string>
> = {
  ...SESSIONS_COLUMN_LABELS,
  [SESSIONS_COST_COLUMN_ID]: TOTAL_ESTIMATED_COST_LABEL,
};

/**
 * "Total estimated cost" needs ~114px of label at the header's type scale; the
 * 124px track `SESSIONS_COLUMN_WIDTH_PX` declares leaves 108px after padding and
 * truncates it to "Total estimated c…" with no tooltip to recover the rest.
 *
 * A separate map rather than an edit to that declaration: `SESSIONS_COLUMN_SPECS`
 * is the spec's own geometry, and the surfaces that must agree with what the
 * table DRAWS read this map instead — `SessionsTable`, `useSessionsListColumns`,
 * and the saved-view fold budget in `use-sessions-view-state.ts`, which charges
 * 168 so a placement it calls legible cannot end past the fold.
 */
export const TOTAL_ESTIMATED_COST_SESSIONS_COST_COLUMN_WIDTH_PX = 168;

/** `SESSIONS_COLUMN_WIDTH_PX` with the Cost track widened for that label. */
export const TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_WIDTH_PX: Readonly<
  Record<string, number>
> = {
  ...SESSIONS_COLUMN_WIDTH_PX,
  [SESSIONS_COST_COLUMN_ID]: TOTAL_ESTIMATED_COST_SESSIONS_COST_COLUMN_WIDTH_PX,
};
