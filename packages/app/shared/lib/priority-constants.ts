import { Priority } from "@repo/api/src/types/common";
import {
  PRIORITY_VALUES_HIGHEST_FIRST,
  PRIORITY_LABELS as SHARED_PRIORITY_LABELS,
  PRIORITY_VALUES_LOWEST_FIRST as SHARED_PRIORITY_VALUES_LOWEST_FIRST,
} from "@repo/design-system/lib/priority-order";

// Priority display configuration, unified across all entities (documents,
// projects, …). Keyed by the shared `Priority` enum, so it belongs in a
// cross-feature module rather than any one slice.
//
// Sourced from the design system's model. The annotation catches the enum
// gaining a value; `Readonly` stops a write reaching every other surface.
export const PRIORITY_LABELS: Readonly<Record<Priority, string>> =
  SHARED_PRIORITY_LABELS;

export const PRIORITY_VALUES_LOWEST_FIRST: readonly Priority[] =
  SHARED_PRIORITY_VALUES_LOWEST_FIRST;

export const PRIORITY_COLORS: Record<Priority, string> = {
  [Priority.Low]: "text-blue-600 dark:text-blue-400",
  [Priority.Medium]: "text-yellow-600 dark:text-yellow-400",
  [Priority.High]: "text-red-600 dark:text-red-400",
  [Priority.Urgent]: "text-red-800 dark:text-red-300",
};

/**
 * The priority every artifact is created with (see `artifact-row-adapter`).
 * A row still at this value carries no signal, so decluttering surfaces
 * (compact priority cell, constant-priority column collapse) treat it as the
 * "no meaningful priority" sentinel. Single source of truth so the cell and the
 * collapse rule can't disagree on what "default" means.
 */
export const DEFAULT_PRIORITY = Priority.Medium;

/**
 * Urgent-first: the same rank sorting and grouping use, so a menu and the band
 * headers above it cannot present the vocabulary in opposite directions.
 */
export const PRIORITY_OPTIONS_HIGHEST_FIRST: readonly Priority[] =
  PRIORITY_VALUES_HIGHEST_FIRST;

/**
 * The reading order every priority menu shipped before ISS-9094. The design
 * system's explicit array, not the label map's key order — that order is the
 * authoring accident this ticket exists to stop depending on.
 */
export const PRIORITY_OPTIONS_LOWEST_FIRST: readonly Priority[] =
  SHARED_PRIORITY_VALUES_LOWEST_FIRST;

/**
 * The header every priority column renders (ISS-10332 / PLN-2086). Lifted from
 * the artifact column-label map so the Sessions and Branches grids reuse the
 * approved word rather than re-spelling it; `ARTIFACT_COLUMN_LABELS` reads it
 * back for the Documents grid.
 */
export const PRIORITY_COLUMN_LABEL = "Priority";
