/**
 * ISS-5303, re-pointed by ISS-10005 — the docs heading anchor the Help reader
 * stamps is the one the bundle generator persisted.
 *
 * The reader now lives in `@repo/app` and composes two halves: `getTextContent`
 * flattens react-markdown's children, and the HOST's `slugifyHeading` turns that
 * text into the id. This asserts the composition the surface actually performs,
 * against the generator's own `slugify` — the reconciliation that keeps
 * search-jump-to-heading landing on the right section.
 */
import { getTextContent } from "@repo/app/help/lib/heading-text";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { slugify } from "../../../../../scripts/generate-docs-bundle-manifest-lib.mjs";
import { slugifyHeading } from "../help-slug";

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

  it("keeps rendered heading ids in parity with the bundle generator", () => {
    const cases: ReactNode[] = [
      "Rotating an API Key!",
      ["Pre-flight ", createElement("code", { key: "code" }, "checks")],
      "Café ☕ time",
    ];

    for (const children of cases) {
      const text = getTextContent(children);

      expect(slugifyHeading(text)).toBe(slugify(text));
    }
  });
});
