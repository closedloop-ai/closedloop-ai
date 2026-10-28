import { describe, expect, it } from "vitest";
import { escapeSqlLikeLiteral } from "./sql-like";

describe("escapeSqlLikeLiteral (ISS-6757)", () => {
  it("escapes the three characters a LIKE pattern treats specially", () => {
    expect(escapeSqlLikeLiteral("mcp__closedloop__ping")).toBe(
      String.raw`mcp\_\_closedloop\_\_ping`
    );
    expect(escapeSqlLikeLiteral("100%")).toBe(String.raw`100\%`);
    // The escape character itself, or a pattern built from this value would
    // read the NEXT character as escaped.
    expect(escapeSqlLikeLiteral(String.raw`a\b`)).toBe(String.raw`a\\b`);
  });

  it("leaves a value with no metacharacters untouched", () => {
    expect(escapeSqlLikeLiteral("code-review")).toBe("code-review");
    expect(escapeSqlLikeLiteral("")).toBe("");
  });
});
