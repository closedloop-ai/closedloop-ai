/**
 * Stable per-occurrence key for repeated trace rows — tool rows in the session
 * trace and sub-agent body lines in the collapsed sub-agent box. Disambiguates
 * otherwise-identical rows by appending an occurrence index so React keys stay
 * unique across duplicates. Lives in its own lightweight module so both
 * `session-trace` and `session-trace-subagent` can import it without a cycle.
 */
export function getTraceOccurrenceKey(
  baseKey: string,
  keyCounts: Map<string, number>
): string {
  const occurrence = keyCounts.get(baseKey) ?? 0;
  keyCounts.set(baseKey, occurrence + 1);
  return `${baseKey}-${occurrence}`;
}
