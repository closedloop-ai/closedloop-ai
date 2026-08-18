import {
  PRIORITY_VALUES,
  SearchFilterKey,
  SearchFilterOperator,
  STATUS_VALUES,
} from "@repo/api/src/types/search-query";
import { describe, expect, it } from "vitest";
import {
  activeTokenAt,
  commitFilterKey,
  commitFilterValue,
  commitMemberMention,
  filterKeySuggestions,
  filterStaticValues,
  IntellisenseMode,
  intellisenseStateAt,
} from "../search-intellisense";

describe("activeTokenAt", () => {
  it("returns the token the caret sits inside", () => {
    const raw = "hello status:TODO world";
    // Caret in the middle of `status:TODO` (offset 9).
    const token = activeTokenAt(raw, 9);
    expect(token.text).toBe("status:TODO");
    expect(raw.slice(token.start, token.end)).toBe("status:TODO");
  });

  it("returns an empty token on trailing whitespace", () => {
    const token = activeTokenAt("done ", 5);
    expect(token.text).toBe("");
    expect(token.start).toBe(5);
    expect(token.end).toBe(5);
  });

  it("clamps a caret past the end", () => {
    const token = activeTokenAt("abc", 99);
    expect(token.text).toBe("abc");
  });
});

describe("intellisenseStateAt, surface classification by caret", () => {
  it("classifies a bare partial word as the filter-keys surface", () => {
    const raw = "stat";
    const state = intellisenseStateAt(raw, raw.length);
    expect(state.mode).toBe(IntellisenseMode.FilterKeys);
    expect(state.filter).toBe("stat");
  });

  it("classifies `@partial` as the members surface with the handle filter", () => {
    const raw = "@ali";
    const state = intellisenseStateAt(raw, raw.length);
    expect(state.mode).toBe(IntellisenseMode.Members);
    expect(state.filter).toBe("ali");
  });

  it("classifies a static key + operator as the static-values surface", () => {
    const raw = "priority=med";
    const state = intellisenseStateAt(raw, raw.length);
    expect(state.mode).toBe(IntellisenseMode.StaticValues);
    expect(state.keyMeta?.key).toBe(SearchFilterKey.Priority);
    expect(state.operator).toBe(SearchFilterOperator.Eq);
    expect(state.filter).toBe("med");
    expect(state.staticValues).toEqual(PRIORITY_VALUES);
  });

  it("maps the `:` sugar to the equality operator", () => {
    const state = intellisenseStateAt("status:", 7);
    expect(state.mode).toBe(IntellisenseMode.StaticValues);
    expect(state.operator).toBe(SearchFilterOperator.Eq);
    expect(state.staticValues).toEqual(STATUS_VALUES);
  });

  it("preserves an explicit comparison operator on priority", () => {
    const state = intellisenseStateAt("priority>=high", 14);
    expect(state.mode).toBe(IntellisenseMode.StaticValues);
    expect(state.operator).toBe(SearchFilterOperator.Gte);
    expect(state.filter).toBe("high");
  });

  it("classifies `:project=` as the dynamic-values surface", () => {
    const raw = "project=ac";
    const state = intellisenseStateAt(raw, raw.length);
    expect(state.mode).toBe(IntellisenseMode.DynamicValues);
    expect(state.keyMeta?.key).toBe(SearchFilterKey.Project);
    expect(state.filter).toBe("ac");
  });

  it("treats an unknown `key:` as free text (mirrors the parser)", () => {
    const state = intellisenseStateAt("http://example.com", 18);
    expect(state.mode).toBe(IntellisenseMode.FreeText);
  });

  it("scopes the active token to the caret when other tokens precede it", () => {
    const raw = "alpha @bo";
    const state = intellisenseStateAt(raw, raw.length);
    expect(state.mode).toBe(IntellisenseMode.Members);
    expect(state.filter).toBe("bo");
    // The `alpha` free-text token is untouched by the token span.
    expect(raw.slice(state.token.start, state.token.end)).toBe("@bo");
  });
});

describe("filterKeySuggestions", () => {
  it("returns every `:key` for an empty filter, excluding owner", () => {
    const suggestions = filterKeySuggestions("");
    const keys = suggestions.map((s) => s.meta.key);
    expect(keys).toEqual([
      SearchFilterKey.Type,
      SearchFilterKey.Status,
      SearchFilterKey.Priority,
      SearchFilterKey.Project,
      SearchFilterKey.Updated,
    ]);
  });

  it("prefix-filters the keys by the partial", () => {
    const suggestions = filterKeySuggestions("pr");
    expect(suggestions.map((s) => s.meta.key)).toEqual([
      SearchFilterKey.Priority,
      SearchFilterKey.Project,
    ]);
  });
});

describe("filterStaticValues", () => {
  it("substring-filters the enum values", () => {
    expect(filterStaticValues(PRIORITY_VALUES, "gh")).toEqual(["HIGH"]);
  });

  it("returns the whole set for an empty filter", () => {
    expect(filterStaticValues(PRIORITY_VALUES, "")).toEqual([
      ...PRIORITY_VALUES,
    ]);
  });
});

describe("commit helpers, token rewrite + caret placement", () => {
  const priorityMeta = {
    prefix: "priority:",
    key: SearchFilterKey.Priority,
    label: "Priority",
    operators: [SearchFilterOperator.Eq],
    valueSource: "static" as const,
  };

  it("commitFilterKey rewrites the active token to the `key:` prefix", () => {
    const token = { text: "pri", start: 0, end: 3 };
    const result = commitFilterKey("pri", token, priorityMeta);
    expect(result.text).toBe("priority:");
    expect(result.caret).toBe("priority:".length);
  });

  it("commitFilterValue rebuilds `key:value` with the equality sugar", () => {
    const token = { text: "priority:med", start: 0, end: 12 };
    const result = commitFilterValue(
      "priority:med",
      token,
      priorityMeta,
      SearchFilterOperator.Eq,
      "MEDIUM"
    );
    // A fully-committed filter at the end of the query gets a trailing space so
    // the next token starts fresh; the caret lands after it.
    expect(result.text).toBe("priority:MEDIUM ");
    expect(result.caret).toBe("priority:MEDIUM ".length);
  });

  it("commitFilterValue keeps an explicit comparison operator", () => {
    const token = { text: "priority>=h", start: 0, end: 11 };
    const result = commitFilterValue(
      "priority>=h",
      token,
      priorityMeta,
      SearchFilterOperator.Gte,
      "HIGH"
    );
    expect(result.text).toBe("priority>=HIGH ");
  });

  it("commitMemberMention quotes a whitespace handle", () => {
    const token = { text: "@al", start: 0, end: 3 };
    const result = commitMemberMention("@al", token, "Al Ice");
    expect(result.text).toBe('@"Al Ice" ');
  });

  it("splices the token in place mid-query without doubling the space", () => {
    const raw = "loop @al done";
    const token = { text: "@al", start: 5, end: 8 };
    const result = commitMemberMention(raw, token, "alice");
    // The token is already followed by a space, so no extra space is inserted.
    expect(result.text).toBe("loop @alice done");
    expect(result.caret).toBe("loop @alice".length);
  });

  it("appends a trailing space when the committed mention ends the query", () => {
    const raw = "loop @al";
    const token = { text: "@al", start: 5, end: 8 };
    const result = commitMemberMention(raw, token, "alice");
    expect(result.text).toBe("loop @alice ");
    expect(result.caret).toBe("loop @alice ".length);
  });
});
