import { describe, expect, it } from "vitest";
import {
  extractErrorMessage,
  flattenTextValues,
  safeJson,
  toolResultText,
} from "./parser-utils";

// ---------------------------------------------------------------------------
// safeJson — lines 105-120
// ---------------------------------------------------------------------------

describe("safeJson — object passthrough (line 109)", () => {
  it("returns an object reference as-is (no serialization roundtrip)", () => {
    const obj = { nested: { a: 1 } };
    expect(safeJson(obj)).toBe(obj); // identity check, not deep equality
  });

  it("returns an array as-is (Array.isArray ⊂ typeof==='object')", () => {
    const arr = [1, 2, 3];
    expect(safeJson(arr)).toBe(arr);
  });
});

describe("safeJson — non-string non-object non-null fallthrough (line 119)", () => {
  it("returns a number unchanged", () => {
    expect(safeJson(42)).toBe(42);
  });

  it("returns a boolean unchanged", () => {
    expect(safeJson(true)).toBe(true);
    expect(safeJson(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractErrorMessage — lines 128-155
// ---------------------------------------------------------------------------

describe("extractErrorMessage — null/depth guard (lines 129-131)", () => {
  it("returns null for null value", () => {
    expect(extractErrorMessage(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(extractErrorMessage(undefined)).toBeNull();
  });

  it("returns a string at depth 4 (not yet truncated)", () => {
    // depth 4 is still <= 4, so the guard does not fire
    expect(extractErrorMessage("valid at depth 4", 4)).toBe("valid at depth 4");
  });

  it("returns null when depth exceeds 4 regardless of value type", () => {
    // depth 5 > 4 → early return null even for a non-empty string
    expect(extractErrorMessage("cut off at depth 5", 5)).toBeNull();
  });

  it("uses default depth 0 so top-level values are always processed", () => {
    // If the default were anything > 4, this would incorrectly return null
    expect(extractErrorMessage("hello")).toBe("hello");
  });
});

describe("extractErrorMessage — string branch (lines 132-135)", () => {
  it("returns the trimmed string for a non-empty string value", () => {
    expect(extractErrorMessage("  network timeout  ")).toBe("network timeout");
  });

  it("returns null for a whitespace-only string", () => {
    expect(extractErrorMessage("   \t\n  ")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractErrorMessage("")).toBeNull();
  });
});

describe("extractErrorMessage — number / non-object value fallthrough (line 154)", () => {
  it("returns null for a number (no string, no array, no object branch taken)", () => {
    // Ensures the final 'return null' is reached when no branch applies
    expect(extractErrorMessage(42)).toBeNull();
  });

  it("returns null for a boolean", () => {
    expect(extractErrorMessage(false)).toBeNull();
  });
});

describe("extractErrorMessage — array branch (lines 136-143)", () => {
  it("returns the first extractable message from an array", () => {
    // null entry → skip; empty string → skip; "found it" → return
    expect(extractErrorMessage([null, "", "found it"])).toBe("found it");
  });

  it("returns null when all array entries yield no message", () => {
    expect(extractErrorMessage([null, "   ", ""])).toBeNull();
  });

  it("recurses into nested arrays (depth increments per level)", () => {
    expect(extractErrorMessage([["deep message"]])).toBe("deep message");
  });
});

describe("extractErrorMessage — object branch (lines 145-153)", () => {
  it("extracts the value of the 'message' key", () => {
    expect(extractErrorMessage({ message: "something went wrong" })).toBe(
      "something went wrong"
    );
  });

  it("falls through to 'error' key when 'message' is absent", () => {
    expect(extractErrorMessage({ error: "timeout after 30s" })).toBe(
      "timeout after 30s"
    );
  });

  it("falls through to 'details' key", () => {
    expect(extractErrorMessage({ details: "see logs" })).toBe("see logs");
  });

  it("falls through to 'text' key", () => {
    expect(extractErrorMessage({ text: "operation failed" })).toBe(
      "operation failed"
    );
  });

  it("falls through to 'content' key", () => {
    expect(extractErrorMessage({ content: "access denied" })).toBe(
      "access denied"
    );
  });

  it("returns null when no recognized key yields a non-null message", () => {
    expect(extractErrorMessage({ unrelated: "irrelevant" })).toBeNull();
    expect(extractErrorMessage({})).toBeNull();
  });

  it("returns null when all recognized keys hold empty strings", () => {
    expect(extractErrorMessage({ message: "", error: "   " })).toBeNull();
  });

  it("uses first key with a message; skips later keys", () => {
    // 'message' succeeds first; 'error' is never tried
    expect(extractErrorMessage({ message: "first", error: "second" })).toBe(
      "first"
    );
  });
});

// ---------------------------------------------------------------------------
// flattenTextValues — lines 314-333
// ---------------------------------------------------------------------------

describe("flattenTextValues — empty string (line 319)", () => {
  it("returns [] for an empty string (length === 0 → false branch of length>0)", () => {
    expect(flattenTextValues("")).toEqual([]);
  });
});

describe("flattenTextValues — exotic value fallthrough (line 332)", () => {
  it("returns [] for a Symbol (typeof 'symbol', not matched by any branch)", () => {
    // Symbol is not null, not string, not number/boolean, not array, not object
    // → reaches the final 'return []'
    expect(flattenTextValues(Symbol("tag"))).toEqual([]);
  });
});

describe("flattenTextValues — other branches (smoke)", () => {
  it("converts a number to its string form", () => {
    expect(flattenTextValues(0)).toEqual(["0"]);
    expect(flattenTextValues(3.14)).toEqual(["3.14"]);
  });

  it("converts a boolean to its string form", () => {
    expect(flattenTextValues(true)).toEqual(["true"]);
    expect(flattenTextValues(false)).toEqual(["false"]);
  });

  it("recursively flattens a plain object's values", () => {
    expect(flattenTextValues({ a: "hello", b: "world" })).toEqual([
      "hello",
      "world",
    ]);
  });

  it("returns [] when depth exceeds 4 (depth guard)", () => {
    // An array nested 5 levels deep — innermost value is at depth 5
    const level5 = [[[[[["deepest"]]]]]];
    // Traversal: depth0→array, depth1→array, depth2→array, depth3→array,
    //            depth4→array, depth5→"deepest" but depth>4 → []
    expect(flattenTextValues(level5)).toEqual([]);
  });

  it("returns [] for null (null branch, depth 0)", () => {
    expect(flattenTextValues(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toolResultText — lines 650-662
// ---------------------------------------------------------------------------

describe("toolResultText", () => {
  it("returns block.content when it is a plain string", () => {
    expect(toolResultText({ content: "output text" })).toBe("output text");
  });

  it("joins .text fields from an array content block with newlines", () => {
    const block = {
      content: [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ],
    };
    expect(toolResultText(block)).toBe("part one\npart two");
  });

  it("skips array entries that lack a string .text field", () => {
    const block = {
      content: [
        { type: "image", data: "base64" },
        { type: "text", text: "ok" },
      ],
    };
    expect(toolResultText(block)).toBe("ok");
  });

  it("returns empty string when content is an empty array", () => {
    expect(toolResultText({ content: [] })).toBe("");
  });

  it("returns empty string when content key is absent", () => {
    expect(toolResultText({})).toBe("");
  });

  it("returns empty string when content is null (treated as non-string, non-array)", () => {
    expect(toolResultText({ content: null })).toBe("");
  });
});
