import { describe, expect, it } from "vitest";
import {
  formatSessionSortRule,
  parseSessionSortRule,
} from "./agent-session-sort";

describe("formatSessionSortRule", () => {
  it("joins column and direction with the separator", () => {
    expect(formatSessionSortRule("cost", "desc")).toBe("cost:desc");
  });
});

describe("parseSessionSortRule", () => {
  it("round-trips a formatted rule", () => {
    expect(
      parseSessionSortRule(formatSessionSortRule("status", "asc"))
    ).toEqual({ column: "status", dir: "asc" });
  });

  it("splits on the first separator and keeps the rest in dir", () => {
    expect(parseSessionSortRule("cost:desc:extra")).toEqual({
      column: "cost",
      dir: "desc:extra",
    });
  });

  it.each([
    ["no separator", "cost"],
    ["empty column", ":desc"],
    ["empty dir", "cost:"],
    ["empty string", ""],
  ])("returns null for %s", (_label, raw) => {
    expect(parseSessionSortRule(raw)).toBeNull();
  });
});
