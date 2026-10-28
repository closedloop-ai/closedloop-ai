/**
 * ISS-6385: the shared tag-colour vocabulary has exactly ONE definition, and this
 * pins it.
 *
 * The repo had grown THREE incompatible tag palettes — the canonical
 * `TagColor`, the `TAG_COLOR_STYLES` that renders it, and a `generic-artifact`
 * prototype set that shared only eight of its sixteen names with either. This
 * suite is what stops a fourth, and what stops the canonical set quietly
 * losing a member while every render map still typechecks against the smaller
 * union.
 *
 * {@link CANONICAL_TAG_COLORS} is written out INDEPENDENTLY, on purpose. An
 * expectation derived from `TagColor` — `Object.values(TagColor)`, or a length
 * check — stays green when a member is deleted or the const is emptied, which
 * is the exact regression this exists to catch. The duplication IS the test.
 * Change it only alongside a deliberate vocabulary change, and never to make a
 * red run go green.
 */

import { TAG_COLORS } from "@repo/api/src/types/tag";
import { describe, expect, it } from "vitest";
import { tagChipClassName } from "../tag-chip";
import { TAG_COLOR_CLASSES, TAG_COLOR_PALETTE } from "../tag-color-picker";

/** The sixteen canonical tag colours, in canonical order. Hand-written. */
const CANONICAL_TAG_COLORS = [
  "red",
  "rose",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "pink",
];

describe("tag colour vocabulary", () => {
  it("TAG_COLORS is exactly the canonical sixteen, in order", () => {
    expect(TAG_COLORS).toEqual(CANONICAL_TAG_COLORS);
  });

  it("the shared swatch palette covers exactly the canonical vocabulary", () => {
    expect(TAG_COLOR_PALETTE.map((swatch) => swatch.name)).toEqual(
      CANONICAL_TAG_COLORS
    );
  });

  it("the swatch class map covers exactly the canonical vocabulary", () => {
    expect(Object.keys(TAG_COLOR_CLASSES).sort()).toEqual(
      [...CANONICAL_TAG_COLORS].sort()
    );
  });

  it("gives every canonical colour its own chip classes", () => {
    // Distinctness, not just presence: a `tagChipClassName` that fell back to
    // one colour for every input would satisfy a "returns a non-empty string"
    // assertion while rendering sixteen identical chips.
    const rendered = CANONICAL_TAG_COLORS.map((color) =>
      tagChipClassName(color as (typeof TAG_COLORS)[number])
    );
    expect(new Set(rendered).size).toBe(CANONICAL_TAG_COLORS.length);
  });
});
