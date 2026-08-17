import { describe, expect, it } from "vitest";
import {
  commentsLayoutModeForWidth,
  shouldAutoCollapseComments,
} from "./comments-layout-model";

describe("comments layout model", () => {
  it("uses content-width thresholds that also respond to browser zoom", () => {
    expect(commentsLayoutModeForWidth(1100)).toBe("wide");
    expect(commentsLayoutModeForWidth(1099)).toBe("compact");
    expect(commentsLayoutModeForWidth(640)).toBe("compact");
    expect(commentsLayoutModeForWidth(639)).toBe("mobile");
  });

  it("collapses once when entering each narrower layout", () => {
    expect(
      shouldAutoCollapseComments({
        nextMode: "compact",
        open: true,
        previousMode: "wide",
      })
    ).toBe(true);
    expect(
      shouldAutoCollapseComments({
        nextMode: "mobile",
        open: true,
        previousMode: "compact",
      })
    ).toBe(true);
  });

  it("allows the user to reopen at the current narrowness", () => {
    expect(
      shouldAutoCollapseComments({
        nextMode: "compact",
        open: true,
        previousMode: "compact",
      })
    ).toBe(false);
    expect(
      shouldAutoCollapseComments({
        nextMode: "mobile",
        open: true,
        previousMode: "mobile",
      })
    ).toBe(false);
  });
});
