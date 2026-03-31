export function reviveWithDates(_key: string, value: unknown): unknown {
  if (typeof value === "string") {
    const result = RegEx.isoDate.exec(value);
    if (result) {
      return new Date(value);
    }
  }
  return value;
}

/**
 * Simple function to convert ISO date strings to Date objects in already-parsed data.
 * Uses date-fns parseISO which handles ISO date string detection and parsing.
 *
 * Unlike reviveWithDates which is designed as a JSON.parse reviver function,
 * this function works directly on parsed objects to avoid the overhead of
 * re-serialization and re-parsing.
 *
 * @param obj - The parsed object/value to process for date conversion
 * @returns The same object with ISO date strings converted to Date objects
 */
export function reviveDatesInParsedData(obj: unknown): unknown {
  if (typeof obj === "string") {
    const result = RegEx.isoDate.exec(obj);
    if (result) {
      return new Date(obj);
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(reviveDatesInParsedData);
  }

  // Return Date objects as-is to avoid corruption
  if (obj instanceof Date) {
    return obj;
  }

  if (obj && typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    // Use Object.keys() to only iterate over own enumerable properties
    for (const key of Object.keys(obj)) {
      result[key] = reviveDatesInParsedData(
        (obj as Record<string, unknown>)[key]
      );
    }
    return result;
  }

  return obj;
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
