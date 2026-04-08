import {
  type ProjectStatus,
  ProjectStatus as ProjectStatusValues,
} from "@repo/api/src/types/project";

/**
 * Parse a comma-delimited string of project statuses into a validated array.
 * Returns undefined when no valid statuses are present (missing param, empty
 * string, or all-invalid values) so callers can fall through to the default
 * exclude-archived behaviour. This keeps the endpoint lenient — important for
 * MCP and other programmatic clients that may omit or send empty params.
 */
export function parseProjectStatuses(
  value?: string
): ProjectStatus[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const allowedValues = new Set(
    Object.values(ProjectStatusValues) as ProjectStatus[]
  );
  const values = value
    .split(",")
    .map((part) => part.trim())
    .filter((v): v is ProjectStatus => allowedValues.has(v as ProjectStatus));

  return values.length > 0 ? [...new Set(values)] : undefined;
}
