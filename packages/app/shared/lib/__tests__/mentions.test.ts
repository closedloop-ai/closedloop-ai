import { describe, expect, it } from "vitest";
import {
  applyMentionSelection,
  filterMentionCandidates,
  findActiveMentionQuery,
  type MentionUser,
  mentionDisplayName,
  resolveMentionLabel,
} from "../mentions";

const ada: MentionUser = {
  id: "u-ada",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  active: true,
};
const grace: MentionUser = {
  id: "u-grace",
  firstName: null,
  lastName: null,
  email: "grace@example.com",
  active: true,
};
const inactive: MentionUser = {
  id: "u-old",
  firstName: "Old",
  lastName: "Account",
  email: "old@example.com",
  active: false,
};

describe("mentionDisplayName", () => {
  it("prefers 'First Last', falling back to email", () => {
    expect(mentionDisplayName(ada)).toBe("Ada Lovelace");
    expect(mentionDisplayName(grace)).toBe("grace@example.com");
  });
});

describe("filterMentionCandidates", () => {
  it("returns all active members for an empty query and drops inactive", () => {
    const result = filterMentionCandidates([ada, grace, inactive], "");
    expect(result.map((u) => u.id)).toEqual(["u-ada", "u-grace"]);
  });

  it("matches on name (case-insensitive)", () => {
    const result = filterMentionCandidates([ada, grace], "love");
    expect(result.map((u) => u.id)).toEqual(["u-ada"]);
  });

  it("matches on email when the name does not match", () => {
    const result = filterMentionCandidates([ada, grace], "grace@");
    expect(result.map((u) => u.id)).toEqual(["u-grace"]);
  });

  it("never surfaces inactive members even on a matching query", () => {
    expect(filterMentionCandidates([inactive], "old")).toEqual([]);
  });
});

describe("findActiveMentionQuery", () => {
  it("detects an @query at the start of input", () => {
    expect(findActiveMentionQuery("@ad", 3)).toEqual({ start: 0, query: "ad" });
  });

  it("detects an @query after whitespace", () => {
    expect(findActiveMentionQuery("hi @gr", 6)).toEqual({
      start: 3,
      query: "gr",
    });
  });

  it("returns null when @ is mid-word (e.g. an email)", () => {
    expect(findActiveMentionQuery("ada@example", 11)).toBeNull();
  });

  it("returns null once whitespace closes the token", () => {
    expect(findActiveMentionQuery("@Ada Lovelace ", 14)).toBeNull();
  });
});

describe("applyMentionSelection", () => {
  it("replaces the @query token with '@Label ' and returns the new caret", () => {
    // "hi @ad" with caret at end (6), token starts at 3
    const result = applyMentionSelection({
      value: "hi @ad",
      caret: 6,
      start: 3,
      label: "Ada Lovelace",
    });
    expect(result.value).toBe("hi @Ada Lovelace ");
    expect(result.caret).toBe(result.value.length);
  });

  it("preserves text after the caret", () => {
    const result = applyMentionSelection({
      value: "@ad done",
      caret: 3,
      start: 0,
      label: "Ada Lovelace",
    });
    expect(result.value).toBe("@Ada Lovelace  done");
  });
});

describe("resolveMentionLabel", () => {
  it("resolves a known id to its display name", () => {
    const map = new Map([[ada.id, ada]]);
    expect(resolveMentionLabel("u-ada", map)).toBe("Ada Lovelace");
  });

  it("resolves an unknown id to a generic label rather than the raw id", () => {
    expect(resolveMentionLabel("missing", new Map())).toBe("Unknown user");
  });
});
