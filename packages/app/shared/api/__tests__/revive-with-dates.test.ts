import { describe, expect, it } from "vitest";
import { reviveDatesInParsedData, reviveWithDates } from "../revive-with-dates";

describe("reviveWithDates", () => {
  it("converts an ISO date string to a Date", () => {
    const result = reviveWithDates("createdAt", "2023-07-24T12:34:56Z");
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe("2023-07-24T12:34:56.000Z");
  });

  it("converts an ISO date string with fractional seconds", () => {
    const result = reviveWithDates("ts", "2023-07-24T12:34:56.789Z");
    expect(result).toBeInstanceOf(Date);
  });

  it("converts an ISO date string with timezone offset", () => {
    const result = reviveWithDates("ts", "2023-07-24T12:34:56+01:00");
    expect(result).toBeInstanceOf(Date);
  });

  it("returns non-ISO strings unchanged", () => {
    expect(reviveWithDates("name", "hello")).toBe("hello");
    expect(reviveWithDates("date", "2023-07-24")).toBe("2023-07-24");
    expect(reviveWithDates("date", "not-a-date")).toBe("not-a-date");
  });

  it("returns non-string values unchanged", () => {
    expect(reviveWithDates("count", 42)).toBe(42);
    expect(reviveWithDates("active", true)).toBe(true);
    expect(reviveWithDates("data", null)).toBe(null);
  });

  it("works as a JSON.parse reviver", () => {
    const json = '{"createdAt":"2023-07-24T12:34:56Z","name":"test","count":5}';
    const parsed = JSON.parse(json, reviveWithDates);
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.name).toBe("test");
    expect(parsed.count).toBe(5);
  });
});

describe("reviveDatesInParsedData", () => {
  it("converts a top-level ISO string to a Date", () => {
    const result = reviveDatesInParsedData("2023-07-24T12:34:56Z");
    expect(result).toBeInstanceOf(Date);
  });

  it("returns non-ISO strings unchanged", () => {
    expect(reviveDatesInParsedData("hello")).toBe("hello");
  });

  it("converts ISO strings nested in objects", () => {
    const input = {
      name: "test",
      createdAt: "2023-07-24T12:34:56Z",
      count: 5,
    };
    const result = reviveDatesInParsedData(input) as Record<string, unknown>;
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.name).toBe("test");
    expect(result.count).toBe(5);
  });

  it("converts ISO strings in arrays", () => {
    const input = ["2023-07-24T12:34:56Z", "not-a-date", 42];
    const result = reviveDatesInParsedData(input) as unknown[];
    expect(result[0]).toBeInstanceOf(Date);
    expect(result[1]).toBe("not-a-date");
    expect(result[2]).toBe(42);
  });

  it("handles deeply nested structures", () => {
    const input = {
      user: {
        profile: {
          joinedAt: "2023-07-24T12:34:56Z",
        },
        tags: ["admin", "2024-01-01T00:00:00Z"],
      },
    };
    const result = reviveDatesInParsedData(input) as Record<string, unknown>;
    const user = result.user as Record<string, unknown>;
    const profile = user.profile as Record<string, unknown>;
    const tags = user.tags as unknown[];
    expect(profile.joinedAt).toBeInstanceOf(Date);
    expect(tags[0]).toBe("admin");
    expect(tags[1]).toBeInstanceOf(Date);
  });

  it("preserves existing Date objects", () => {
    const date = new Date("2023-07-24T12:34:56Z");
    const result = reviveDatesInParsedData(date);
    expect(result).toBe(date);
  });

  it("returns primitives unchanged", () => {
    expect(reviveDatesInParsedData(42)).toBe(42);
    expect(reviveDatesInParsedData(true)).toBe(true);
    expect(reviveDatesInParsedData(null)).toBe(null);
    expect(reviveDatesInParsedData(undefined)).toBe(undefined);
  });
});
