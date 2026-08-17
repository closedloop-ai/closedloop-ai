import { createElement } from "react";
import { describe, expect, test } from "vitest";
import { getTextContent } from "../utils";

describe("getTextContent", () => {
  test("returns a string leaf unchanged", () => {
    expect(getTextContent("hello")).toBe("hello");
  });

  test("converts a number leaf to its string form", () => {
    expect(getTextContent(42)).toBe("42");
  });

  test("joins an array of children depth-first", () => {
    expect(getTextContent(["foo", 1, "bar"])).toBe("foo1bar");
  });

  test("recurses into a valid React element's children", () => {
    const element = createElement(
      "span",
      null,
      "hello ",
      createElement("b", null, "world")
    );
    expect(getTextContent(element)).toBe("hello world");
  });

  test("returns an empty string for non-text, non-array, non-element nodes", () => {
    expect(getTextContent(true)).toBe("");
    expect(getTextContent(null)).toBe("");
    expect(getTextContent(undefined)).toBe("");
  });
});
