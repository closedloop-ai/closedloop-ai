import { describe, expect, it } from "vitest";
import { getTextContent } from "../heading-text";

describe("getTextContent", () => {
  it("returns a string child as-is", () => {
    expect(getTextContent("Getting started")).toBe("Getting started");
  });

  it("stringifies a number child", () => {
    expect(getTextContent(42)).toBe("42");
  });

  it("joins an array of children in order", () => {
    expect(getTextContent(["Step ", 2, ": run"])).toBe("Step 2: run");
  });

  it("flattens nested elements down to their text", () => {
    expect(
      getTextContent(
        <span>
          Use <code>pnpm</code> <em>{["now", "!"]}</em>
        </span>
      )
    ).toBe("Use pnpm now!");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["an element with no children", <br key="br" />],
  ])("returns an empty string for %s", (_label, children) => {
    expect(getTextContent(children)).toBe("");
  });

  it("contributes nothing for empty values mixed into an array", () => {
    expect(getTextContent(["a", null, false, <i key="i">b</i>])).toBe("ab");
  });
});
