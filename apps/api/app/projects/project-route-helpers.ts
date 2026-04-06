import {
  type ProjectStatus,
  ProjectStatus as ProjectStatusValues,
} from "@repo/api/src/types/project";

/**
 * Parse a comma-delimited string of project statuses into a validated array.
 * Returns undefined if value is undefined (no filter), null if invalid, or
 * a deduplicated array of valid ProjectStatus values.
 */
export function parseProjectStatuses(
  value?: string
): ProjectStatus[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  const values = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean) as ProjectStatus[];
  if (values.length === 0) {
    return null;
  }

  const allowedValues = new Set(
    Object.values(ProjectStatusValues) as ProjectStatus[]
  );
  const hasInvalidStatus = values.some((status) => !allowedValues.has(status));
  if (hasInvalidStatus) {
    return null;
  }

  return [...new Set(values)];
}
