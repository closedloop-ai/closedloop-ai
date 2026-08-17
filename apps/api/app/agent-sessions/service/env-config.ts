/**
 * Reads a positive numeric value from `process.env[envVarName]`, returning
 * `fallback` when the variable is unset, empty, non-finite, or non-positive.
 * Read at sweep time so ops can tune thresholds without a code change.
 */
export function resolvePositiveEnvNumber(
  envVarName: string,
  fallback: number
): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
