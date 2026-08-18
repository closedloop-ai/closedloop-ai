import { describe, expect, it } from "vitest";
import { reviveWithDates } from "../revive-with-dates";

/**
 * ISS-5771 gated revival to keys some type declares as a `Date`. These cases
 * therefore use REAL contract key names: `createdAt`/`updatedAt` are declared
 * `Date` and revive, while `invokedAt` and free-text keys are declared `string`
 * and must survive the parse as the strings the server sent.
 */

describe("reviveWithDates", () => {
  it("converts an ISO date string to a Date", () => {
    const result = reviveWithDates("createdAt", "2023-07-24T12:34:56Z");
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe("2023-07-24T12:34:56.000Z");
  });

  it("converts an ISO date string with fractional seconds", () => {
    const result = reviveWithDates("updatedAt", "2023-07-24T12:34:56.789Z");
    expect(result).toBeInstanceOf(Date);
  });

  it("converts an ISO date string with timezone offset", () => {
    const result = reviveWithDates("updatedAt", "2023-07-24T12:34:56+01:00");
    expect(result).toBeInstanceOf(Date);
  });

  it("leaves an ISO string under a key no type declares as a `Date`", () => {
    // `AgentComponentInvocationReadRow.invokedAt` is declared `string | null`.
    // Reviving it is what crashed the component detail page (ISS-5771).
    expect(reviveWithDates("invokedAt", "2023-07-24T12:34:56Z")).toBe(
      "2023-07-24T12:34:56Z"
    );
    expect(reviveWithDates("title", "2023-07-24T12:34:56Z")).toBe(
      "2023-07-24T12:34:56Z"
    );
  });

  it("leaves array elements alone, which JSON.parse keys by index", () => {
    expect(reviveWithDates("0", "2023-07-24T12:34:56Z")).toBe(
      "2023-07-24T12:34:56Z"
    );
  });

  it("returns non-ISO strings unchanged", () => {
    // Uses an ALLOWLISTED key so the regex is what rejects these, not the key
    // gate — otherwise the case would pass without exercising the shape check.
    expect(reviveWithDates("name", "hello")).toBe("hello");
    expect(reviveWithDates("createdAt", "2023-07-24")).toBe("2023-07-24");
    expect(reviveWithDates("createdAt", "not-a-date")).toBe("not-a-date");
  });

  it("leaves keys that only a NON-response type declares as a `Date`", () => {
    // `date`/`from`/`to` are `Date` only on `search-query.ts`'s `UpdatedFilter`,
    // a parsed-query model that never crosses the wire — while `TimeSeriesPoint`
    // and `PhaseLoopback` really do serve those names as `string`.
    // `sessionStartedAt` is `Date` only on the unserved `SessionDetail`, and
    // `string` on the token-trend payload that is actually returned.
    for (const key of ["date", "from", "to", "sessionStartedAt", "now"]) {
      expect(reviveWithDates(key, "2023-07-24T12:34:56Z"), key).toBe(
        "2023-07-24T12:34:56Z"
      );
    }
  });

  it("returns non-string values unchanged", () => {
    expect(reviveWithDates("count", 42)).toBe(42);
    expect(reviveWithDates("active", true)).toBe(true);
    expect(reviveWithDates("data", null)).toBe(null);
  });

  it("works as a JSON.parse reviver", () => {
    const json =
      '{"createdAt":"2023-07-24T12:34:56Z","invokedAt":"2023-07-24T12:34:56Z","name":"test","count":5}';
    const parsed = JSON.parse(json, reviveWithDates);
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.invokedAt).toBe("2023-07-24T12:34:56Z");
    expect(parsed.name).toBe("test");
    expect(parsed.count).toBe(5);
  });
});
