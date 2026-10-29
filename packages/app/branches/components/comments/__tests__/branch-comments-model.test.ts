import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BranchCommentsPanelState,
  formatBranchCommentTime,
  resolveBranchCommentsPanelState,
} from "../branch-comments-model";

describe("formatBranchCommentTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Asserted as an exact string against a pinned clock. The offset is measured
   * in minutes, which is a pure difference of instants rather than a local
   * calendar comparison, so the expectation holds in every process time zone.
   */
  it("renders a readable timestamp relative to the viewer's clock", () => {
    expect(formatBranchCommentTime("2026-01-15T11:55:00.000Z")).toBe(
      "5 min ago"
    );
    expect(formatBranchCommentTime("2026-01-15T11:00:00.000Z")).toBe(
      "1 hour ago"
    );
  });

  /**
   * The native rail and the provider rail render into one list. Both had
   * declared this fallback privately, so a change to one wording would have left
   * the two halves of a single list disagreeing about what a missing timestamp
   * is called. One owner, one word.
   */
  it("names an unparseable timestamp the same way for both comment sources", () => {
    expect(formatBranchCommentTime("not-a-timestamp")).toBe("Unknown time");
    expect(formatBranchCommentTime("")).toBe("Unknown time");
  });
});

describe("resolveBranchCommentsPanelState", () => {
  /**
   * ISS-7370: an in-flight read has not failed. Loading must outrank the error
   * flag so the heading and the body cannot describe the same read differently.
   */
  it("calls a read that is both loading and errored Loading, not Error", () => {
    expect(
      resolveBranchCommentsPanelState({
        hasError: true,
        hasVisibleComments: false,
        isLoading: true,
      })
    ).toBe(BranchCommentsPanelState.Loading);
  });

  it("calls a settled failed read Error", () => {
    expect(
      resolveBranchCommentsPanelState({
        hasError: true,
        hasVisibleComments: false,
        isLoading: false,
      })
    ).toBe(BranchCommentsPanelState.Error);
  });

  it("calls a settled empty read Ready so a real zero is not mistaken for a failure", () => {
    expect(
      resolveBranchCommentsPanelState({
        hasError: false,
        hasVisibleComments: false,
        isLoading: false,
      })
    ).toBe(BranchCommentsPanelState.Ready);
  });

  it("lets comments already on screen outrank both flags", () => {
    expect(
      resolveBranchCommentsPanelState({
        hasError: true,
        hasVisibleComments: true,
        isLoading: true,
      })
    ).toBe(BranchCommentsPanelState.Ready);
  });
});
