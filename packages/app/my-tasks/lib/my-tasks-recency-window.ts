import { DOCUMENT_LIST_DEFAULT_RECENCY_DAYS } from "@repo/api/src/types/document";

/**
 * The copy for My Tasks' recency window (FEA-1626), in one place so the chip,
 * the empty state, and the day count actually sent to the endpoint can never
 * drift apart. Every string here is derived from
 * {@link DOCUMENT_LIST_DEFAULT_RECENCY_DAYS} rather than repeating "90".
 *
 * The window is a real, user-visible filter, not an invisible optimisation: a
 * board that quietly returns fewer rows publishes a bounded count as if it were
 * the whole queue, and someone back from three months of leave reads "Your queue
 * is clear" over work that is all still there. Disclosing it as a removable chip
 * and naming it in the empty state is what keeps the screen honest.
 */
export const MY_TASKS_RECENCY_CHIP_LABEL = `Last ${DOCUMENT_LIST_DEFAULT_RECENCY_DAYS} days`;

/**
 * Title for the "nothing in the window" state. Deliberately NOT "Your queue is
 * clear": an aged-out queue and an empty queue are two different facts and must
 * not share a screen.
 */
export const MY_TASKS_RECENCY_EMPTY_TITLE = `Nothing updated in the last ${DOCUMENT_LIST_DEFAULT_RECENCY_DAYS} days`;

/** Says what was left out — older work AND archived projects — not just "no results". */
export const MY_TASKS_RECENCY_EMPTY_BODY = `This board is showing the last ${DOCUMENT_LIST_DEFAULT_RECENCY_DAYS} days, excluding archived projects. Anything you were assigned before that is still here.`;

/** The way back out, offered wherever the window can hide work. */
export const MY_TASKS_RECENCY_SHOW_ALL_LABEL = "Show all time";
