import { describe, expect, it } from "vitest";

import { formatToolResultContent } from "./stream-types";

describe("formatToolResultContent", () => {
  it("renders absent and string content without fabrication", () => {
    expect(formatToolResultContent(null)).toBe("");
    expect(formatToolResultContent(undefined)).toBe("");
    expect(formatToolResultContent("plain text")).toBe("plain text");
  });

  it("renders arrays entry by entry", () => {
    expect(formatToolResultContent(["first", { ok: true }])).toBe(
      'first\n{\n  "ok": true\n}'
    );
  });

  it("pretty-prints structured content", () => {
    expect(formatToolResultContent({ nested: { count: 1 } })).toBe(
      '{\n  "nested": {\n    "count": 1\n  }\n}'
    );
  });
});
