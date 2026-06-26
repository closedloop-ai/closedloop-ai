/**
 * Serializes JSON-like values with deterministic object-key ordering for
 * command fingerprints and signed user-intent comparisons.
 *
 * Canonical home for this serializer: it is shared runtime logic (the browser
 * signs commands, the desktop main process verifies them, the API stores and
 * compares them) and must produce byte-identical output across all of them.
 * It lives here — in a built JS package — rather than in the source-only
 * `@repo/api`, so the desktop main process (compiled by `tsc`, run by Electron
 * with no ts loader) can import it at runtime. All consumers — browser signer,
 * desktop main verifier, and API — import it directly from
 * `@closedloop-ai/loops-api/stable-stringify`.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}
