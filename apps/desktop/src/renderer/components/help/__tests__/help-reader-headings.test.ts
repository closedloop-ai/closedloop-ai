import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { slugify } from "../../../../../scripts/generate-docs-bundle-manifest-lib.mjs";
import { getTextContent, slugHeadingProps } from "../help-reader-headings";

describe("Help reader heading ids", () => {
  it("flattens the valid React child shapes emitted by react-markdown", () => {
    const children: ReactNode = [
      "Plan ",
      2,
      createElement("em", { key: "emphasis" }, "Today"),
      createElement("span", { key: "empty" }),
      null,
      false,
    ];

    expect(getTextContent(children)).toBe("Plan 2Today");
  });

  it("keeps renderer heading ids in parity with the bundle generator", () => {
    const cases: ReactNode[] = [
      "Rotating an API Key!",
      ["Pre-flight ", createElement("code", { key: "code" }, "checks")],
      "Café ☕ time",
    ];

    for (const children of cases) {
      const text = getTextContent(children);

      expect(slugHeadingProps(children).id).toBe(slugify(text));
    }
  });
});
