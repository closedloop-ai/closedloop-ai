/**
 * Maps the product's `ProjectWithDetails` onto the portable row the promoted
 * Projects surface renders (ISS-10476). One mapping, so the web route and any
 * later shell project the same record the same way.
 */

import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { isPriorityValue } from "@repo/design-system/lib/priority-order";
import {
  formatDateCompact,
  formatRelativeTime,
} from "../../shared/lib/date-utils";
import {
  getUserDisplayName,
  getUserInitials,
} from "../../shared/lib/user-utils";
import type {
  ProjectSummaryOwner,
  ProjectSummaryRow,
} from "./project-summary-row";

/**
 * The artifact population `completionPercentage` summarizes on the product
 * side: DOCUMENT-typed artifacts, not every child of the project (ISS-4636).
 * Named here so the ring's tooltip says what it counted.
 */
export const PROJECT_COMPLETION_POPULATION_LABEL = "documents";

export function toProjectSummaryRow(
  project: ProjectWithDetails,
  options: { now?: Date | number } = {}
): ProjectSummaryRow {
  // `completionPercentage` is ALWAYS a number on the wire — an empty population
  // serializes 0 and says so additively through `completionPopulationEmpty`
  // (ISS-4679). Carrying that 0 into the ring would render "0% done" for a
  // project that has nothing to do, so the empty case becomes the row's own
  // unavailable state instead.
  const populationEmpty = project.completionPopulationEmpty === true;
  const targetDate = validInstant(project.targetDate);
  const updatedAt = validInstant(project.updatedAt);
  return {
    childTaskCount: populationEmpty ? 0 : null,
    code: project.slug,
    completionPercentage: populationEmpty ? null : project.completionPercentage,
    completionPopulationLabel: PROJECT_COMPLETION_POPULATION_LABEL,
    dueDateLabel: targetDate ? formatDateCompact(targetDate) : null,
    dueDateMs: targetDate ? targetDate.getTime() : null,
    id: project.id,
    name: project.name,
    owner: toProjectSummaryOwner(project),
    priority:
      project.priority && isPriorityValue(project.priority)
        ? project.priority
        : null,
    updatedAtMs: updatedAt ? updatedAt.getTime() : null,
    updatedLabel: updatedAt
      ? formatRelativeTime(updatedAt, options)
      : UNKNOWN_UPDATED_LABEL,
  };
}

function toProjectSummaryOwner(
  project: ProjectWithDetails
): ProjectSummaryOwner | null {
  const assignee = project.assignee;
  if (!assignee) {
    return null;
  }
  return {
    avatarUrl: assignee.avatarUrl ?? undefined,
    id: assignee.id,
    initials: getUserInitials(assignee.firstName, assignee.lastName),
    name: getUserDisplayName(assignee),
  };
}

/** What the Updated cell says when the record carries no usable instant. */
const UNKNOWN_UPDATED_LABEL = "Unknown";

/**
 * A record that reaches this adapter without a parsable instant is a corrupt or
 * version-skewed row, not a date. `new Date(undefined)` is an Invalid Date whose
 * every formatter THROWS, which took the whole Projects render down rather than
 * losing one cell; the row keeps its other values and reports the instant as
 * unknown instead.
 */
function validInstant(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
