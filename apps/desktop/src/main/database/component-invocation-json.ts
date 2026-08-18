/**
 * Narrow JSON readers shared by the invocation materializer and its stored-row
 * rebuild bridge. Extracted from `component-invocations.ts` (grandfathered,
 * shrink-only) so the stored-command module can read persisted metadata without
 * importing back into that module — see root AGENTS.md on touched
 * grandfathered files.
 */
export function parseRecord(
  value: string | null
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
