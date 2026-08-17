import { describe, expect, it } from "vitest";
import { type CommentAuthor, CommentAuthorKind } from "../mock";
import {
  applyMentionSelection,
  findActiveMentionQuery,
  insertMentionTrigger,
  resolveMentions,
} from "./mentions";

const marcus: CommentAuthor = {
  id: "u-marcus",
  name: "Marcus Lee",
  email: "marcus@closedloop.ai",
  avatarUrl: null,
  kind: CommentAuthorKind.Human,
};

const marcusLeeway: CommentAuthor = {
  id: "u-marcus-leeway",
  name: "Marcus Leeway",
  email: "leeway@closedloop.ai",
  avatarUrl: null,
  kind: CommentAuthorKind.Human,
};

describe("findActiveMentionQuery", () => {
  it("detects an @query at the caret after whitespace", () => {
    const value = "hey @mar";
    expect(findActiveMentionQuery(value, value.length)).toEqual({
      start: 4,
      query: "mar",
    });
  });

  it("detects an @query at the start of input", () => {
    expect(findActiveMentionQuery("@da", 3)).toEqual({ start: 0, query: "da" });
  });

  it("does not trigger on a mid-word @ (an email)", () => {
    const value = "ping me at dana@clo";
    expect(findActiveMentionQuery(value, value.length)).toBeNull();
  });

  it("closes the token once whitespace follows the @", () => {
    const value = "@dana ";
    expect(findActiveMentionQuery(value, value.length)).toBeNull();
  });
});

describe("insertMentionTrigger", () => {
  it("inserts a bare @ at the caret at start of input", () => {
    expect(insertMentionTrigger({ value: "", caret: 0 })).toEqual({
      value: "@",
      caret: 1,
    });
  });

  it("prefixes a space when mid-line and not on whitespace", () => {
    expect(insertMentionTrigger({ value: "hi", caret: 2 })).toEqual({
      value: "hi @",
      caret: 4,
    });
  });

  it("does not add a space when the caret already follows whitespace", () => {
    expect(insertMentionTrigger({ value: "hi ", caret: 3 })).toEqual({
      value: "hi @",
      caret: 4,
    });
  });

  it("splices at a mid-string caret without appending to the end", () => {
    // Caret sits after "hi " (index 3), before "there".
    expect(insertMentionTrigger({ value: "hi there", caret: 3 })).toEqual({
      value: "hi @there",
      caret: 4,
    });
  });
});

describe("applyMentionSelection", () => {
  it("replaces only the active token and preserves a preceding newline", () => {
    // Caret after "@mar" on the second line; the newline must survive.
    const value = "line one\n@mar";
    const result = applyMentionSelection({
      value,
      caret: value.length,
      start: value.indexOf("@"),
      label: "Marcus Lee",
    });
    expect(result.value).toBe("line one\n@Marcus Lee ");
    expect(result.caret).toBe(result.value.length);
  });

  it("splices a mention mid-string, keeping trailing text", () => {
    const value = "hey @da and Priya";
    const result = applyMentionSelection({
      value,
      caret: 7, // after "@da"
      start: 4,
      label: "Dana Cole",
    });
    expect(result.value).toBe("hey @Dana Cole  and Priya");
    expect(result.caret).toBe("hey @Dana Cole ".length);
  });
});

describe("resolveMentions", () => {
  const picked = new Map<string, CommentAuthor>([[marcus.id, marcus]]);

  it("returns the id when the exact token is followed by whitespace", () => {
    expect(resolveMentions("hi @Marcus Lee there", picked)).toEqual([
      marcus.id,
    ]);
  });

  it("returns the id when the token ends the body", () => {
    expect(resolveMentions("thanks @Marcus Lee", picked)).toEqual([marcus.id]);
  });

  it("drops the mention when the token was edited away", () => {
    expect(resolveMentions("hi @Marc there", picked)).toEqual([]);
  });

  it("does not match a shorter name inside a longer one", () => {
    // "@Marcus Lee" must not match inside "@Marcus Leeway".
    const both = new Map<string, CommentAuthor>([
      [marcus.id, marcus],
      [marcusLeeway.id, marcusLeeway],
    ]);
    expect(resolveMentions("ping @Marcus Leeway now", both)).toEqual([
      marcusLeeway.id,
    ]);
  });

  it("dedupes a repeated mention of the same user", () => {
    expect(
      resolveMentions("@Marcus Lee and again @Marcus Lee", picked)
    ).toEqual([marcus.id]);
  });
});
