import { describe, expect, it } from "vitest";
import {
  activeTypeKinds,
  addTypeToken,
  EntityKind,
  matchKeyValueToken,
  removeTypeToken,
  spliceTokenAtCaret,
  splitTokens,
  toggleTypeToken,
  tokenSpanAtCaret,
} from "./search-model";

describe("splitTokens", () => {
  it("splits on whitespace and drops empty spans", () => {
    expect(splitTokens("  type:session   status:DONE ")).toEqual([
      "type:session",
      "status:DONE",
    ]);
  });

  it("returns an empty array for a blank query", () => {
    expect(splitTokens("   ")).toEqual([]);
  });
});

describe("activeTypeKinds", () => {
  it("reads type: tokens in bar order, ignoring non-type tokens", () => {
    expect(
      activeTypeKinds("agent type:session status:DONE type:branch")
    ).toEqual([EntityKind.Session, EntityKind.Branch]);
  });

  it("drops an unknown type value (malformed input)", () => {
    expect(activeTypeKinds("type:session type:not_a_kind")).toEqual([
      EntityKind.Session,
    ]);
  });

  it("dedupes a repeated type token", () => {
    expect(activeTypeKinds("type:session type:session")).toEqual([
      EntityKind.Session,
    ]);
  });
});

describe("type token round trips", () => {
  it("adds a type token after existing tokens", () => {
    expect(addTypeToken("agent", EntityKind.Session)).toBe(
      "agent type:session"
    );
  });

  it("is a no-op when the token already exists", () => {
    expect(addTypeToken("type:session", EntityKind.Session)).toBe(
      "type:session"
    );
  });

  it("removes every matching type token", () => {
    expect(
      removeTypeToken("type:session agent type:session", EntityKind.Session)
    ).toBe("agent");
  });

  it("toggles a kind on and back off to the original query", () => {
    const on = toggleTypeToken("agent", EntityKind.Branch);
    expect(on).toBe("agent type:branch");
    expect(toggleTypeToken(on, EntityKind.Branch)).toBe("agent");
  });
});

describe("tokenSpanAtCaret", () => {
  it("returns the token the caret sits inside, not the tail", () => {
    const query = "type:session status:DONE";
    // caret at index 3, inside "type:session"
    expect(tokenSpanAtCaret(query, 3)).toEqual({
      start: 0,
      end: 12,
      text: "type:session",
    });
  });

  it("returns an empty span at the caret between tokens", () => {
    const query = "a b";
    expect(tokenSpanAtCaret(query, 2)).toEqual({ start: 2, end: 3, text: "b" });
  });

  it("clamps an out-of-range caret", () => {
    expect(tokenSpanAtCaret("abc", 99)).toEqual({
      start: 0,
      end: 3,
      text: "abc",
    });
  });
});

describe("spliceTokenAtCaret", () => {
  it("replaces the caret's token, not the final token", () => {
    // Editing "type:" at the start must not clobber the trailing status token.
    const result = spliceTokenAtCaret(
      "type: status:DONE",
      5,
      "type:session",
      true
    );
    expect(result.query).toBe("type:session status:DONE");
    // The existing space after the old token is reused, so the caret lands right
    // after "type:session" with no doubled gap.
    expect(result.caret).toBe("type:session".length);
  });

  it("adds a trailing space when the value ends the query", () => {
    const result = spliceTokenAtCaret("status:DO", 9, "status:DONE", true);
    expect(result.query).toBe("status:DONE ");
    expect(result.caret).toBe("status:DONE ".length);
  });

  it("omits the trailing space for a bare key prefix", () => {
    const result = spliceTokenAtCaret("typ", 3, "type:", false);
    expect(result.query).toBe("type:");
    expect(result.caret).toBe("type:".length);
  });
});

describe("matchKeyValueToken", () => {
  it("matches a colon/equality key token and returns its value prefix", () => {
    const match = matchKeyValueToken("status:DO");
    expect(match?.meta.key).toBe("status");
    expect(match?.operator).toBe("=");
    expect(match?.valuePrefix).toBe("DO");
  });

  it("matches a suffixed comparison operator (priority>=HI)", () => {
    const match = matchKeyValueToken("priority>=HI");
    expect(match?.meta.key).toBe("priority");
    expect(match?.operator).toBe(">=");
    expect(match?.valuePrefix).toBe("HI");
  });

  it("returns null for a bare word", () => {
    expect(matchKeyValueToken("agent")).toBeNull();
  });

  it("matches an @owner token so it suggests people (the @ plays the colon)", () => {
    const match = matchKeyValueToken("@mi");
    expect(match?.meta.key).toBe("@");
    expect(match?.operator).toBe("=");
    expect(match?.valuePrefix).toBe("mi");
  });

  it("does not match a comparison operator the key does not accept", () => {
    // status is equality-only, so status>=X is not a value token.
    expect(matchKeyValueToken("status>=DONE")).toBeNull();
  });
});
