import { describe, expect, it } from "vitest";
import { truncateUtf8 } from "./truncate-utf8";

describe("truncateUtf8", () => {
  it("returns the input unchanged when it fits within maxBytes", () => {
    expect(truncateUtf8("hello", 10)).toBe("hello");
    expect(truncateUtf8("hello", 5)).toBe("hello");
  });

  it("truncates ASCII at the byte boundary", () => {
    expect(truncateUtf8("hello world", 5)).toBe("hello");
  });

  it("never splits a multi-byte codepoint", () => {
    // "é" is 2 bytes (0xC3 0xA9); a 1-byte budget must drop it entirely.
    expect(truncateUtf8("é", 1)).toBe("");
    expect(truncateUtf8("é", 2)).toBe("é");
    // "😀" is 4 bytes; budgets of 1-3 yield empty, 4 keeps it.
    expect(truncateUtf8("😀", 3)).toBe("");
    expect(truncateUtf8("😀", 4)).toBe("😀");
  });

  it("keeps complete leading codepoints and drops a trailing partial one", () => {
    // "aé" = 0x61 0xC3 0xA9 (3 bytes). Budget 2 keeps "a", drops partial "é".
    expect(truncateUtf8("aé", 2)).toBe("a");
    expect(truncateUtf8("aé", 3)).toBe("aé");
  });

  it("handles an empty string and a zero budget", () => {
    expect(truncateUtf8("", 0)).toBe("");
    expect(truncateUtf8("abc", 0)).toBe("");
  });
});
