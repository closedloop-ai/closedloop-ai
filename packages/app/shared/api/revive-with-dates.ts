import { isDateRevivalKey } from "./date-revival-keys";
import { stringOnlyDateKeysForPath } from "./endpoint-date-revival";

/**
 * `JSON.parse` reviver for API responses.
 *
 * Converts an ISO-8601 string to a `Date` ONLY under a key that a type an API
 * route serializes declares as a `Date` (ISS-5771). Before that gate this keyed
 * off value shape alone, so every response field typed `string` but carrying an
 * ISO timestamp — and every user-authored string that happened to look like one
 * — became a `Date` at runtime while `tsc` still saw a `string`. See
 * `date-revival-keys.ts` for what qualifies as a response contract, and for why
 * a key allowlist is the only sound axis available to a JSON reviver.
 */
export function reviveWithDates(key: string, value: unknown): unknown {
  if (typeof value === "string" && isDateRevivalKey(key)) {
    const result = RegEx.isoDate.exec(value);
    if (result) {
      return new Date(value);
    }
  }
  return value;
}

const RegEx = {
  /**
   * Matches an ISO 8601 date string.
   *
   * This regex is useful for validating and parsing ISO 8601 date strings, which are commonly used in APIs and data interchange formats.
   *
   * - `^`: Anchors the match to the beginning of the string.
   * - `(\d{4})`: Matches a four-digit year.
   * - `-(\d{2})`: Matches a hyphen followed by a two-digit month.
   * - `-(\d{2})`: Matches a hyphen followed by a two-digit day.
   * - `T`: Matches the literal character "T".
   * - `(\d{2})`: Matches a two-digit hour.
   * - `:(\d{2})`: Matches a colon followed by a two-digit minute.
   * - `:(\d{2}(?:\.\d*)?)`: Matches a colon followed by a two-digit second and optional fractional seconds.
   * - `(?:Z|(\+|-)([\d|:]*))?$`: Matches either "Z" (for UTC) or a timezone offset (+ or -) followed by hours and optional minutes.
   * - `$`: Anchors the match to the end of the string.
   *
   * Examples:
   * - "2023-07-24T12:34:56Z" => matches
   * - "2023-07-24T12:34:56.789+01:00" => matches
   * - "2023-07-24" => does not match
   *
   * @type {RegExp}
   */
  isoDate:
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)(?:Z|(\+|-)([\d|:]*))?$/,
};

/**
 * A `JSON.parse` reviver scoped to the endpoint the body came from (ISS-6208).
 *
 * The key allowlist answers "does SOME response contract declare this key a
 * `Date`?", which is a repo-wide answer to a per-endpoint question: half those
 * keys are declared `string` on other contracts and were being converted against
 * them. Knowing the requested path lets the reviver drop a key that THIS
 * endpoint declares only as a `string`. Anything the table does not describe
 * keeps the unscoped behavior, so an unmatched path costs a fix, never a
 * regression.
 */
export function createDateReviver(
  requestPath: string
): (key: string, value: unknown) => unknown {
  const stringOnlyKeys = stringOnlyDateKeysForPath(requestPath);
  if (stringOnlyKeys.size === 0) {
    return reviveWithDates;
  }
  return (key: string, value: unknown): unknown =>
    stringOnlyKeys.has(key) ? value : reviveWithDates(key, value);
}
