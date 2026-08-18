import { describe, expect, it } from "vitest";
import {
  ApiKeyScopeResolutionStatus,
  ApiKeyScopeUnresolvableReason,
  apiKeyScopesInclude,
  resolveApiKeyScopes,
  sanitizeApiKeyScopes,
} from "./api-key-scope-resolution";

describe("sanitizeApiKeyScopes", () => {
  it("keeps recognized scopes and drops duplicates", () => {
    expect(sanitizeApiKeyScopes(["read", "write", "read"])).toEqual([
      "read",
      "write",
    ]);
  });

  it("drops unrecognized and non-string entries without throwing", () => {
    expect(sanitizeApiKeyScopes(["read", "superuser", 7, null])).toEqual([
      "read",
    ]);
  });

  it("returns an empty list for non-array input", () => {
    expect(sanitizeApiKeyScopes(null)).toEqual([]);
    expect(sanitizeApiKeyScopes(undefined)).toEqual([]);
    expect(sanitizeApiKeyScopes("read")).toEqual([]);
  });
});

describe("resolveApiKeyScopes", () => {
  it("resolves a well-formed scope array to exactly those scopes", () => {
    expect(resolveApiKeyScopes(["read", "write"])).toEqual({
      status: ApiKeyScopeResolutionStatus.Resolved,
      scopes: ["read", "write"],
    });
  });

  it("resolves a partially recognized array to the recognized subset", () => {
    expect(resolveApiKeyScopes(["read", "superuser"])).toEqual({
      status: ApiKeyScopeResolutionStatus.Resolved,
      scopes: ["read"],
    });
  });

  it("reports an empty array as unresolvable rather than full access", () => {
    expect(resolveApiKeyScopes([])).toEqual({
      status: ApiKeyScopeResolutionStatus.Unresolvable,
      reason: ApiKeyScopeUnresolvableReason.Empty,
      rawScopeCount: 0,
    });
  });

  it("reports an absent column as unresolvable", () => {
    expect(resolveApiKeyScopes(null)).toEqual({
      status: ApiKeyScopeResolutionStatus.Unresolvable,
      reason: ApiKeyScopeUnresolvableReason.Absent,
      rawScopeCount: 0,
    });
  });

  it("reports an all-unrecognized array as unresolvable, keeping the raw count", () => {
    expect(resolveApiKeyScopes(["superuser", "org:admin"])).toEqual({
      status: ApiKeyScopeResolutionStatus.Unresolvable,
      reason: ApiKeyScopeUnresolvableReason.AllUnrecognized,
      rawScopeCount: 2,
    });
  });
});

describe("apiKeyScopesInclude", () => {
  it("requires every requested scope to be granted", () => {
    expect(apiKeyScopesInclude(["read", "write"], ["read"])).toBe(true);
    expect(apiKeyScopesInclude(["read"], ["read", "write"])).toBe(false);
  });

  it("grants nothing when the granted set is empty", () => {
    expect(apiKeyScopesInclude([], ["read"])).toBe(false);
  });
});
