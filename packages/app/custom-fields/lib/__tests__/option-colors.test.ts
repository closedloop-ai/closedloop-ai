/**
 * ISS-8215 — the canonical custom-field option colour vocabulary and the
 * translation at the design-system boundary.
 *
 * Every expectation here is an INDEPENDENT literal rather than a re-read of the
 * module under test: a test that spells its expectation with the same constant
 * it guards cannot fail when a member is renamed or dropped, which is the only
 * way this vocabulary breaks. The duplication is the point.
 */

import {
  CUSTOM_FIELD_OPTION_COLOR_CLASSES,
  customFieldOptionColorFromDialogClass,
  isCustomFieldOptionColor,
  knownCustomFieldOptionColorClass,
  resolveCustomFieldOptionColor,
} from "@repo/app/custom-fields/lib/option-colors";
import { describe, expect, it } from "vitest";

describe("custom-field option colour vocabulary", () => {
  it("renders each canonical id as the palette class the picker has always shown", () => {
    expect(CUSTOM_FIELD_OPTION_COLOR_CLASSES).toEqual({
      none: "bg-gray-300",
      red: "bg-red-500",
      orange: "bg-orange-500",
      yellow: "bg-yellow-400",
      green: "bg-green-500",
      teal: "bg-teal-500",
      blue: "bg-blue-500",
      purple: "bg-purple-500",
      pink: "bg-pink-500",
    });
  });

  it("recognises a canonical id and rejects a Tailwind class", () => {
    expect(isCustomFieldOptionColor("teal")).toBe(true);
    expect(isCustomFieldOptionColor("bg-teal-500")).toBe(false);
  });
});

describe("customFieldOptionColorFromDialogClass", () => {
  it("maps every add-field dialog swatch onto the id of the same hue", () => {
    const translated = ["bg-success", "bg-warning", "bg-primary"].map(
      customFieldOptionColorFromDialogClass
    );

    expect(translated).toEqual(["green", "yellow", "blue"]);
  });

  it("returns undefined for a class it was never taught, so the optional stays omitted", () => {
    expect(customFieldOptionColorFromDialogClass("bg-chart-1")).toBeUndefined();
    expect(customFieldOptionColorFromDialogClass(undefined)).toBeUndefined();
  });

  it("refuses an inherited object key, so a prototype-polluted input stays undefined", () => {
    const hostile = JSON.parse('{"__proto__": true}');
    expect(
      customFieldOptionColorFromDialogClass(Object.keys(hostile)[0])
    ).toBeUndefined();
    expect(
      customFieldOptionColorFromDialogClass("constructor")
    ).toBeUndefined();
  });
});

describe("knownCustomFieldOptionColorClass", () => {
  it("returns the palette class for a canonical id and for a legacy dialog class", () => {
    expect(knownCustomFieldOptionColorClass("green")).toBe("bg-green-500");
    expect(knownCustomFieldOptionColorClass("bg-warning")).toBe(
      "bg-yellow-400"
    );
  });

  it("declines a value it does not own, so a caller keeps rendering its raw colour", () => {
    expect(knownCustomFieldOptionColorClass("#ff0000")).toBeUndefined();
    expect(knownCustomFieldOptionColorClass("rebeccapurple")).toBeUndefined();
  });

  it("declines `none` too, so an uncoloured option does not gain a grey dot", () => {
    expect(knownCustomFieldOptionColorClass("none")).toBeUndefined();
    expect(knownCustomFieldOptionColorClass(null)).toBeUndefined();
  });
});

describe("resolveCustomFieldOptionColor", () => {
  it("passes a canonical id through unchanged", () => {
    expect(resolveCustomFieldOptionColor("purple")).toBe("purple");
  });

  it("accepts a row persisted with the old Tailwind class as its compatibility alias", () => {
    expect(resolveCustomFieldOptionColor("bg-success")).toBe("green");
    expect(resolveCustomFieldOptionColor("bg-warning")).toBe("yellow");
    expect(resolveCustomFieldOptionColor("bg-primary")).toBe("blue");
  });

  it("falls back to the grey none rather than throwing on a value it cannot read", () => {
    expect(resolveCustomFieldOptionColor("chartreuse")).toBe("none");
    expect(resolveCustomFieldOptionColor("bg-chart-1")).toBe("none");
    expect(resolveCustomFieldOptionColor(null)).toBe("none");
    expect(resolveCustomFieldOptionColor(undefined)).toBe("none");
    expect(resolveCustomFieldOptionColor("")).toBe("none");
  });

  it("maps an inherited object key to the grey fallback", () => {
    expect(resolveCustomFieldOptionColor("__proto__")).toBe("none");
    expect(resolveCustomFieldOptionColor("constructor")).toBe("none");
  });
});
