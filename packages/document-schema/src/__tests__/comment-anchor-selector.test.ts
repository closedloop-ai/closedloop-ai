import { CommentAnchorPlacementState } from "@repo/realtime-contract/doc-sync-internal";
import { describe, expect, it } from "vitest";
import { flattenTextBlocks } from "../comment-anchor-flatten";
import { resolveTextSelector } from "../comment-anchor-selector";

describe("flattenTextBlocks", () => {
  it("joins blocks with a newline and records where each begins", () => {
    expect(flattenTextBlocks(["Title", "", "one two"])).toEqual({
      text: "Title\n\none two",
      blockStarts: [0, 6, 7],
    });
  });

  it("is empty for no blocks", () => {
    expect(flattenTextBlocks([])).toEqual({ text: "", blockStarts: [] });
  });
});

describe("resolveTextSelector", () => {
  const flat = (text: string) => ({ text });

  it("is ANCHORED when prefix, suffix and position all match", () => {
    expect(
      resolveTextSelector(flat("say hello there"), {
        quote: { exact: "hello", prefix: "say ", suffix: " there" },
        position: { start: 4, end: 9 },
      })
    ).toEqual({
      start: 4,
      end: 9,
      state: CommentAnchorPlacementState.Anchored,
    });
  });

  it("picks the repeated quote whose context matches, not the first one", () => {
    const text = "a cat sat. the cat ran.";

    expect(
      resolveTextSelector(flat(text), {
        quote: { exact: "cat", prefix: "the ", suffix: " ran" },
        position: { start: 15, end: 18 },
      })
    ).toEqual({
      start: 15,
      end: 18,
      state: CommentAnchorPlacementState.Anchored,
    });
  });

  it("breaks a context tie by distance from the stored position", () => {
    expect(
      resolveTextSelector(flat("x ab ab ab"), {
        quote: { exact: "ab", prefix: "", suffix: "" },
        position: { start: 6, end: 8 },
      })
    ).toEqual({ start: 5, end: 7, state: CommentAnchorPlacementState.Moved });
  });

  it("gives an exact tie to the lowest start", () => {
    expect(
      resolveTextSelector(flat("ab  ab"), {
        quote: { exact: "ab", prefix: "", suffix: "" },
        position: { start: 2, end: 4 },
      })
    ).toEqual({ start: 0, end: 2, state: CommentAnchorPlacementState.Moved });
  });

  it("lets one character of context outweigh a distance under 1000", () => {
    const text = `ab xab${" ".repeat(900)}`;

    expect(
      resolveTextSelector(flat(text), {
        quote: { exact: "ab", prefix: "x", suffix: "" },
        position: { start: 0, end: 2 },
      })
    ).toEqual({ start: 4, end: 6, state: CommentAnchorPlacementState.Moved });
  });

  it("is MOVED at the quote's new place after text is inserted before it", () => {
    expect(
      resolveTextSelector(flat("New intro. say hello there"), {
        quote: { exact: "hello", prefix: "say ", suffix: " there" },
        position: { start: 4, end: 9 },
      })
    ).toEqual({ start: 15, end: 20, state: CommentAnchorPlacementState.Moved });
  });

  it("is MOVED when the context changed around an unmoved quote", () => {
    expect(
      resolveTextSelector(flat("say hello world"), {
        quote: { exact: "hello", prefix: "say ", suffix: " there" },
        position: { start: 4, end: 9 },
      })
    ).toEqual({ start: 4, end: 9, state: CommentAnchorPlacementState.Moved });
  });

  it("is at best MOVED with no stored position", () => {
    expect(
      resolveTextSelector(flat("say hello there"), {
        quote: { exact: "hello", prefix: "say ", suffix: " there" },
      })
    ).toEqual({ start: 4, end: 9, state: CommentAnchorPlacementState.Moved });
  });

  it("is null when the quote is absent", () => {
    expect(
      resolveTextSelector(flat("say hello there"), {
        quote: { exact: "goodbye", prefix: "say ", suffix: "" },
        position: { start: 4, end: 11 },
      })
    ).toBeNull();
  });

  it("matches context and quote across textblocks", () => {
    const { text } = flattenTextBlocks(["Intro", "First line", "second line"]);

    expect(
      resolveTextSelector(
        { text },
        {
          quote: {
            exact: "line\nsecond",
            prefix: "Intro\nFirst ",
            suffix: " line",
          },
          position: { start: 12, end: 23 },
        }
      )
    ).toEqual({
      start: 12,
      end: 23,
      state: CommentAnchorPlacementState.Anchored,
    });
  });

  it("counts overlapping occurrences as candidates", () => {
    expect(
      resolveTextSelector(flat("aaa"), {
        quote: { exact: "aa", prefix: "a", suffix: "" },
        position: { start: 1, end: 3 },
      })
    ).toEqual({
      start: 1,
      end: 3,
      state: CommentAnchorPlacementState.Anchored,
    });
  });
});
