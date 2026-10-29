import { describe, expect, it } from "vitest";
import { gridLayoutSchema, gridPositionSchema } from "../dashboard-schema";

const VALID = { x: 0, y: 0, w: 3, h: 2 };

describe("gridPositionSchema", () => {
  it("accepts a positive integer width and height", () => {
    expect(gridPositionSchema.safeParse(VALID).success).toBe(true);
    expect(
      gridPositionSchema.safeParse({ x: 0, y: 0, w: 12, h: 1 }).success
    ).toBe(true);
  });

  it.each([
    ["h:0", { ...VALID, h: 0 }],
    ["h:-3", { ...VALID, h: -3 }],
    ["h:0.4", { ...VALID, h: 0.4 }],
    ["w:0", { ...VALID, w: 0 }],
    ["w:-1", { ...VALID, w: -1 }],
    ["w:2.5", { ...VALID, w: 2.5 }],
    ["missing x", { y: 0, w: 3, h: 2 }],
  ])("rejects %s", (_label, position) => {
    expect(gridPositionSchema.safeParse(position).success).toBe(false);
  });
});

describe("gridLayoutSchema", () => {
  it("drops only the invalid entries and keeps their siblings", () => {
    const parsed = gridLayoutSchema.parse({
      "kpi:merged": { x: 0, y: 0, w: 12, h: 0 },
      "chart:prTrend": { x: 3, y: 0, w: 6, h: 4 },
      "kpi:sessions": { x: 0, y: 4, w: 3, h: 0.4 },
      "kpi:input-tokens": { x: 3, y: 4, w: 3, h: -3 },
      "chart:toolUsage": "junk",
      "kpi:output-tokens": { y: 4, w: 3, h: 2 },
    });

    expect(parsed).toEqual({ "chart:prTrend": { x: 3, y: 0, w: 6, h: 4 } });
    // `toEqual` ignores an own key holding `undefined`, so pin the key set too:
    // a rejected entry must be absent, not present-and-undefined.
    expect(Object.keys(parsed)).toEqual(["chart:prTrend"]);
  });

  it("round-trips a valid layout byte-identically", () => {
    const layout = {
      "kpi:merged": { x: 0, y: 0, w: 3, h: 2 },
      "chart:prTrend": { x: 3, y: 0, w: 6, h: 4 },
    };
    const parsed = gridLayoutSchema.parse(layout);

    expect(parsed).toEqual(layout);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(layout));
  });

  it("keeps a valid entry under an own __proto__ key", () => {
    // A JSON-parsed record can carry an own "__proto__" key; z.record would
    // silently drop it (ISS-8565). Only JSON.parse produces the own key — an
    // object literal would write the prototype instead.
    const input = JSON.parse(
      '{"__proto__":{"x":0,"y":0,"w":3,"h":2},"kpi:merged":{"x":3,"y":0,"w":3,"h":2}}'
    );
    const parsed = gridLayoutSchema.parse(input);

    expect(Object.keys(parsed)).toEqual(["__proto__", "kpi:merged"]);
    expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value).toEqual(
      { x: 0, y: 0, w: 3, h: 2 }
    );
  });

  it("returns an empty layout when every entry is invalid", () => {
    expect(
      gridLayoutSchema.parse({
        a: { x: 0, y: 0, w: 12, h: 0 },
        b: null,
      })
    ).toEqual({});
  });

  it("rejects a layout that is not a plain object", () => {
    expect(gridLayoutSchema.safeParse("nope").success).toBe(false);
    expect(gridLayoutSchema.safeParse([VALID]).success).toBe(false);
    expect(gridLayoutSchema.safeParse(null).success).toBe(false);
  });
});
