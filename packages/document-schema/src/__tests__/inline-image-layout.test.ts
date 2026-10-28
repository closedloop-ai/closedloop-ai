import { describe, expect, it } from "vitest";
import {
  clampInlineImageWidth,
  formatInlineImageLayoutTitle,
  InlineImageLayout,
  MAX_INLINE_IMAGE_WIDTH,
  MIN_INLINE_IMAGE_WIDTH,
  parseInlineImageLayoutTitle,
  parseInlineImageWidth,
} from "../inline-image-layout";

describe("inline image layout title", () => {
  it.each([
    [InlineImageLayout.WrapLeft, "width=480 align=left"],
    [InlineImageLayout.Center, "width=480 align=center"],
    [InlineImageLayout.WrapRight, "width=480 align=right"],
  ])("round-trips %s with a width", (layout, title) => {
    expect(formatInlineImageLayoutTitle({ width: 480, layout })).toBe(title);
    expect(parseInlineImageLayoutTitle(title)).toEqual({ width: 480, layout });
  });

  it("omits the align token for the inline layout and an empty title entirely", () => {
    expect(
      formatInlineImageLayoutTitle({
        width: 320,
        layout: InlineImageLayout.Inline,
      })
    ).toBe("width=320");
    expect(
      formatInlineImageLayoutTitle({
        width: null,
        layout: InlineImageLayout.Inline,
      })
    ).toBeNull();
    expect(formatInlineImageLayoutTitle({})).toBeNull();
  });

  it("ignores titles and tokens it does not own", () => {
    expect(parseInlineImageLayoutTitle(undefined)).toEqual({
      width: null,
      layout: null,
    });
    expect(parseInlineImageLayoutTitle("A screenshot of the card")).toEqual({
      width: null,
      layout: null,
    });
    expect(parseInlineImageLayoutTitle("align=diagonal width=640")).toEqual({
      width: 640,
      layout: null,
    });
    expect(parseInlineImageLayoutTitle("align width=640")).toEqual({
      width: 640,
      layout: null,
    });
    expect(parseInlineImageLayoutTitle("float=right width=640")).toEqual({
      width: 640,
      layout: null,
    });
  });
});

describe("parseInlineImageWidth", () => {
  it.each([
    "",
    "-480",
    "480.5",
    "1e3",
    " 480",
    "0",
    String(MIN_INLINE_IMAGE_WIDTH - 1),
    String(MAX_INLINE_IMAGE_WIDTH + 1),
    "99999999999999999999",
  ])("rejects %j", (value) => {
    expect(parseInlineImageWidth(value)).toBeNull();
  });

  it("rejects non-finite and fractional numbers", () => {
    expect(parseInlineImageWidth(Number.NaN)).toBeNull();
    expect(parseInlineImageWidth(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseInlineImageWidth(240.5)).toBeNull();
  });

  it("accepts integer widths inside the bounds from strings and numbers", () => {
    expect(parseInlineImageWidth("480")).toBe(480);
    expect(parseInlineImageWidth(MIN_INLINE_IMAGE_WIDTH)).toBe(
      MIN_INLINE_IMAGE_WIDTH
    );
    expect(parseInlineImageWidth(MAX_INLINE_IMAGE_WIDTH)).toBe(
      MAX_INLINE_IMAGE_WIDTH
    );
  });
});

describe("clampInlineImageWidth", () => {
  it("clamps at both ends and rounds to whole pixels", () => {
    expect(clampInlineImageWidth(-50, 800)).toBe(MIN_INLINE_IMAGE_WIDTH);
    expect(clampInlineImageWidth(1200, 800)).toBe(800);
    expect(clampInlineImageWidth(300.6, 800)).toBe(301);
    expect(clampInlineImageWidth(9000, Number.POSITIVE_INFINITY)).toBe(
      MAX_INLINE_IMAGE_WIDTH
    );
  });

  it("never returns less than the minimum when the container is narrower", () => {
    expect(clampInlineImageWidth(200, 10)).toBe(MIN_INLINE_IMAGE_WIDTH);
  });
});
