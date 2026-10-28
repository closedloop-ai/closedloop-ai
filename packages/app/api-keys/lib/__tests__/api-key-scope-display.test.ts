import { API_KEY_SCOPES, ApiKeyScope } from "@repo/api/src/types/api-key";
import { describe, expect, it } from "vitest";
import {
  getApiKeyScopeDisplay,
  getRecognizedApiKeyScopes,
} from "../api-key-scope-display";

describe("getRecognizedApiKeyScopes", () => {
  it("returns a single recognized scope", () => {
    expect(getRecognizedApiKeyScopes([ApiKeyScope.Read])).toEqual([
      ApiKeyScope.Read,
    ]);
  });

  it("returns multiple recognized scopes", () => {
    expect(
      getRecognizedApiKeyScopes([ApiKeyScope.Read, ApiKeyScope.Write])
    ).toEqual([ApiKeyScope.Read, ApiKeyScope.Write]);
  });

  it("orders the result by the canonical least-to-most-privileged order regardless of input order", () => {
    expect(
      getRecognizedApiKeyScopes([
        ApiKeyScope.Admin,
        ApiKeyScope.Delete,
        ApiKeyScope.Read,
      ])
    ).toEqual([ApiKeyScope.Read, ApiKeyScope.Delete, ApiKeyScope.Admin]);
  });

  it("returns every scope in canonical order when all are present", () => {
    expect(
      getRecognizedApiKeyScopes([
        ApiKeyScope.Admin,
        ApiKeyScope.Delete,
        ApiKeyScope.Write,
        ApiKeyScope.Read,
      ])
    ).toEqual([...API_KEY_SCOPES]);
  });

  it("dedupes a scope repeated in the input", () => {
    expect(
      getRecognizedApiKeyScopes([
        ApiKeyScope.Read,
        ApiKeyScope.Read,
        ApiKeyScope.Write,
      ])
    ).toEqual([ApiKeyScope.Read, ApiKeyScope.Write]);
  });

  it("returns null for an empty array", () => {
    expect(getRecognizedApiKeyScopes([])).toBeNull();
  });

  it("returns null when the array carries an unrecognized scope", () => {
    expect(getRecognizedApiKeyScopes(["supervise"])).toBeNull();
  });

  it("returns null when a known scope is mixed with an unrecognized one — the whole set is unreadable, not partially trusted", () => {
    expect(
      getRecognizedApiKeyScopes([ApiKeyScope.Read, "supervise"])
    ).toBeNull();
  });

  it("returns null when the array carries a non-string member", () => {
    expect(getRecognizedApiKeyScopes([ApiKeyScope.Read, 7])).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a bare string", ApiKeyScope.Read as unknown],
    ["a number", 42],
    ["an object", { read: true }],
  ])("returns null for non-array input: %s", (_label, input) => {
    expect(getRecognizedApiKeyScopes(input)).toBeNull();
  });
});

describe("getApiKeyScopeDisplay", () => {
  it("renders Unknown with the warning variant and an explanatory tooltip for invalid scopes", () => {
    expect(getApiKeyScopeDisplay(null)).toEqual({
      label: "Unknown",
      variant: "warning",
      tooltip:
        "We can't confirm this key's access. It may have more than shown.",
    });
  });

  it("renders Unknown for an empty scope array rather than Read only", () => {
    const display = getApiKeyScopeDisplay([]);
    expect(display.label).toBe("Unknown");
    expect(display.variant).toBe("warning");
  });

  it("renders Unknown for an unrecognized scope", () => {
    const display = getApiKeyScopeDisplay(["supervise"]);
    expect(display.label).toBe("Unknown");
    expect(display.variant).toBe("warning");
  });

  it("renders 'Read only' with no badge variant for a read-only key", () => {
    expect(getApiKeyScopeDisplay([ApiKeyScope.Read])).toEqual({
      label: "Read only",
      variant: null,
    });
  });

  it("renders a capitalized comma-joined label with no variant for read+write", () => {
    expect(
      getApiKeyScopeDisplay([ApiKeyScope.Read, ApiKeyScope.Write])
    ).toEqual({
      label: "Read, write",
      variant: null,
    });
  });

  it("names delete explicitly instead of collapsing read+write+delete into a two-privilege label", () => {
    const display = getApiKeyScopeDisplay([
      ApiKeyScope.Read,
      ApiKeyScope.Write,
      ApiKeyScope.Delete,
    ]);
    expect(display.label).toBe("Read, write, delete");
    expect(display.variant).toBeNull();
  });

  it("uses the accent variant for a key carrying admin, and never labels it read only", () => {
    const display = getApiKeyScopeDisplay([
      ApiKeyScope.Read,
      ApiKeyScope.Admin,
    ]);
    expect(display.label).toBe("Read, admin");
    expect(display.variant).toBe("accent");
  });

  it("renders an admin-only key as Admin with the accent variant", () => {
    expect(getApiKeyScopeDisplay([ApiKeyScope.Admin])).toEqual({
      label: "Admin",
      variant: "accent",
    });
  });

  it("comma-joins every scope, capitalized, for a full-privilege key", () => {
    const display = getApiKeyScopeDisplay([...API_KEY_SCOPES]);
    expect(display.label).toBe("Read, write, delete, admin");
    expect(display.variant).toBe("accent");
  });

  it("names only the scopes a partial, non-read key carries", () => {
    expect(getApiKeyScopeDisplay([ApiKeyScope.Delete])).toEqual({
      label: "Delete",
      variant: null,
    });
  });
});
