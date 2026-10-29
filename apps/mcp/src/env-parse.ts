import { log } from "@repo/observability/log";

/**
 * Reads a positive-integer setting from the environment, falling back to a
 * default when the variable is absent, unparseable, or outside
 * `[minimumValue, maximumValue]`.
 *
 * Split out of `index.ts` so modules other than the HTTP entrypoint can read
 * their own tunables without importing it (which would be circular).
 *
 * The whole string is validated, not a prefix of it. `Number.parseInt` stops at
 * the first character it cannot use, so `"1e3"` became `1` and `"200abc"` became
 * `200` — a setting an operator would reasonably expect to be honored or
 * rejected instead silently became a different, much smaller number.
 */
export function parsePositiveIntegerEnv(
  name: string,
  defaultValue: number,
  minimumValue = 1,
  maximumValue = Number.MAX_SAFE_INTEGER
): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return defaultValue;
  }

  // `Number` rejects any trailing garbage outright and reads exponent notation,
  // so `"1e3"` is 1000 and `"200abc"` is NaN. `isSafeInteger` then excludes
  // fractions, infinities, and magnitudes past the exactly-representable range.
  const parsedValue = Number(rawValue);
  if (
    !Number.isSafeInteger(parsedValue) ||
    parsedValue < minimumValue ||
    parsedValue > maximumValue
  ) {
    log.warn(
      `${name}="${rawValue}" is invalid. Using default value ${defaultValue}.`
    );
    return defaultValue;
  }

  return parsedValue;
}
