/** ISS-10713: omitted timing is unknown; zero is a measured instant. */
export function invocationDurationFields(
  value: unknown
): AgentComponentInvocationDurationFields {
  if (value === undefined || value === null) {
    return {};
  }
  const durationMs = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof durationMs !== "number" ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0
  ) {
    throw new RangeError("Invalid measured invocation duration");
  }
  return { durationMs };
}

/** Shared timing shape for invocation sync and both read adapters. */
export type AgentComponentInvocationDurationFields = {
  /** ISS-10713: elapsed milliseconds between this call and its matched result. */
  durationMs?: number;
};
