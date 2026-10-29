import { DocumentColumn } from "../use-column-visibility";

/**
 * The one table configuration every `useColumnVisibility` suite drives.
 *
 * Extracted (ISS-9908, PR #6970 review) so the carried-id cases live in their own
 * file without re-declaring a second, subtly different subject — two suites
 * configuring the same hook slightly differently is how a shared machine's tests
 * come to disagree about what it does.
 */
export const STORAGE_KEY = "test:columns";
export const ORDER_KEY = "test:column-order";

/** A small canonical column list so the reorder math is easy to assert against. */
export const COLUMNS = [
  DocumentColumn.Type,
  DocumentColumn.Assignee,
  DocumentColumn.Priority,
] as const;
