/**
 * What a value looks like after a JSON response round-trip (a `Date` becomes
 * its ISO string), for comparing a parsed response body against the fixture the
 * mocked service returned.
 */
export function toWireJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
