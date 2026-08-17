/**
 * ISS-4905: direct unit coverage for the extracted MCP scope resolver.
 *
 * The HTTP-entrypoint suite (`api-key-scope-fail-closed.test.ts`) proves the
 * wiring at `resolveMcpAuth` and the client-credentials grant; this file pins
 * the resolver contract itself for every unresolvable reason, so the OAuth
 * grants that share it (authorize, authorization_code, refresh, concurrent
 * grant) cannot regress silently through a code path with no HTTP test.
 */

import { API_KEY_SCOPES as SHARED_API_KEY_SCOPES } from "@repo/api/src/types/api-key.js";
import { API_KEY_SCOPES_UNRESOLVABLE_EVENT } from "@repo/api/src/utils/api-key-scope-resolution.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedApiKeyContext } from "../api-key-contract.js";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError },
}));

import {
  API_KEY_SCOPE_SET,
  DEFAULT_TOOL_REQUIRED_SCOPES,
  DELETE_SCOPE,
  effectiveKeyScopes,
  hasWriteScope,
  NO_OVERLAP_REFRESH_GRANT_DESCRIPTION,
  narrowTokenGrantToKeyScopes,
  parseScopeParam,
  READ_SCOPE,
  RefreshScopeResolutionKind,
  refreshScopeRefusalDescription,
  resolveGrantedScopes,
  resolveRefreshGrantScopes,
  revalidateCachedGrant,
  toolRequiredScopes,
  WRITE_SCOPE,
} from "../oauth-scopes.js";

function contextFor(scopes: unknown): VerifiedApiKeyContext {
  return {
    userId: "user_1",
    organizationId: "org_1",
    scopes: scopes as VerifiedApiKeyContext["scopes"],
  };
}

beforeEach(() => {
  logError.mockReset();
});

describe("MCP scope contract parity", () => {
  // ISS-4637 collapsed the MCP-local scope list into the shared one, so
  // `API_KEY_SCOPE_SET` — what this server accepts on a token claim — must be
  // exactly the vocabulary `@repo/api` recognizes. A scope advertised in
  // `scopes_supported` but missing here would be sanitized away by the shared
  // resolver, turning a legitimate key into an unresolvable one.
  it("accepts exactly the shared contract's scope vocabulary", () => {
    expect([...API_KEY_SCOPE_SET].sort()).toEqual(
      [...SHARED_API_KEY_SCOPES].sort()
    );
  });
});

describe("effectiveKeyScopes", () => {
  it("returns the recognized scopes a well-formed key carries", () => {
    expect(effectiveKeyScopes(contextFor(["read", "write"]))).toEqual([
      "read",
      "write",
    ]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("drops unrecognized entries but still resolves the recognized remainder", () => {
    expect(effectiveKeyScopes(contextFor(["read", "superuser"]))).toEqual([
      "read",
    ]);
    expect(logError).not.toHaveBeenCalled();
  });

  it.each<[string, unknown, string]>([
    ["an empty array", [], "empty"],
    ["a null column", null, "absent"],
    ["an undefined column", undefined, "absent"],
    [
      "only unrecognized scopes",
      ["superuser", "org:admin"],
      "all_unrecognized",
    ],
  ])("fails closed and reports %s on the shared monitor", (_label, scopes, expectedReason) => {
    expect(effectiveKeyScopes(contextFor(scopes))).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      API_KEY_SCOPES_UNRESOLVABLE_EVENT,
      expect.objectContaining({
        surface: "mcp_oauth",
        reason: expectedReason,
        userId: "user_1",
        organizationId: "org_1",
      })
    );
  });
});

describe("resolveRefreshGrantScopes", () => {
  it("grants the refresh record's scopes when no narrower scope is requested", () => {
    expect(
      resolveRefreshGrantScopes(
        contextFor(["read", "write"]),
        ["read", "write"],
        undefined
      )
    ).toEqual({
      kind: RefreshScopeResolutionKind.Ok,
      scopes: ["read", "write"],
    });
  });

  it("narrows to the requested subset of the refresh grant", () => {
    expect(
      resolveRefreshGrantScopes(
        contextFor(["read", "write"]),
        ["read", "write"],
        "read"
      )
    ).toEqual({ kind: RefreshScopeResolutionKind.Ok, scopes: ["read"] });
  });

  it("refuses a request that exceeds the refresh grant", () => {
    expect(
      resolveRefreshGrantScopes(
        contextFor(["read", "write"]),
        ["read"],
        "write"
      ).kind
    ).toBe(RefreshScopeResolutionKind.OverScope);
  });

  it("refuses a request that exceeds what the key itself still carries", () => {
    expect(
      resolveRefreshGrantScopes(
        contextFor(["read"]),
        ["read", "write"],
        "write"
      ).kind
    ).toBe(RefreshScopeResolutionKind.OverScope);
  });

  // ISS-4905 (wongk review): a key narrowed after the family was issued left
  // grantScopes empty; with no request of its own `.some()` was vacuously
  // false, so this returned Ok with `[]` and the handler answered 200 with an
  // access token `isValidTokenScopeClaim` rejects on first use.
  it("refuses a refresh grant that no longer overlaps the key at all", () => {
    expect(
      resolveRefreshGrantScopes(
        contextFor([READ_SCOPE]),
        [WRITE_SCOPE],
        undefined
      ).kind
    ).toBe(RefreshScopeResolutionKind.NoOverlap);
  });

  it("refuses a no-overlap grant even when a scope is explicitly requested", () => {
    expect(
      resolveRefreshGrantScopes(
        contextFor([READ_SCOPE]),
        [WRITE_SCOPE],
        WRITE_SCOPE
      ).kind
    ).toBe(RefreshScopeResolutionKind.NoOverlap);
  });

  it("answers the no-overlap refusal with a reauthorize remedy, not narrow-your-scope", () => {
    expect(
      refreshScopeRefusalDescription(RefreshScopeResolutionKind.NoOverlap)
    ).toBe(NO_OVERLAP_REFRESH_GRANT_DESCRIPTION);
    expect(
      refreshScopeRefusalDescription(RefreshScopeResolutionKind.UnresolvableKey)
    ).not.toBe(NO_OVERLAP_REFRESH_GRANT_DESCRIPTION);
  });

  it("describes an OverScope refusal with a scope-narrowing remedy", () => {
    expect(
      refreshScopeRefusalDescription(RefreshScopeResolutionKind.OverScope)
    ).toBe("Requested scope exceeds the refresh token grant");
  });

  it.each<[string, unknown]>([
    ["an empty array", []],
    ["a null column", null],
    ["only unrecognized scopes", ["superuser"]],
  ])("refuses the rotation when the key scopes are %s", (_label, scopes) => {
    expect(
      resolveRefreshGrantScopes(
        contextFor(scopes),
        ["read", "write"],
        undefined
      ).kind
    ).toBe(RefreshScopeResolutionKind.UnresolvableKey);
    expect(logError).toHaveBeenCalledWith(
      API_KEY_SCOPES_UNRESOLVABLE_EVENT,
      expect.objectContaining({ surface: "mcp_oauth" })
    );
  });
});

describe("resolveGrantedScopes", () => {
  it("defaults to the full key scope set when nothing is requested", () => {
    expect(resolveGrantedScopes([], ["read", "write"])).toEqual([
      "read",
      "write",
    ]);
  });

  it("intersects the request with the key scopes", () => {
    expect(resolveGrantedScopes(["read", "delete"], ["read", "write"])).toEqual(
      ["read"]
    );
  });

  it("returns null when nothing overlaps", () => {
    expect(resolveGrantedScopes(["delete"], ["read"])).toBeNull();
  });
});

describe("parseScopeParam and hasWriteScope", () => {
  it("splits a space-delimited scope param and tolerates absence", () => {
    expect(parseScopeParam("read write")).toEqual(["read", "write"]);
    expect(parseScopeParam("  ")).toEqual([]);
    expect(parseScopeParam(undefined)).toEqual([]);
  });

  it("reports write capability only when the write scope is present", () => {
    expect(hasWriteScope(["read", "write"])).toBe(true);
    expect(hasWriteScope(["read"])).toBe(false);
    expect(hasWriteScope([])).toBe(false);
  });
});

describe("narrowTokenGrantToKeyScopes", () => {
  it("keeps only the token scopes the key still carries", () => {
    expect(
      narrowTokenGrantToKeyScopes(
        [READ_SCOPE, WRITE_SCOPE],
        [READ_SCOPE, DELETE_SCOPE]
      )
    ).toEqual([READ_SCOPE]);
  });

  it("refuses a stale token whose grant no longer overlaps the key", () => {
    expect(narrowTokenGrantToKeyScopes([WRITE_SCOPE], [READ_SCOPE])).toBeNull();
  });

  it("refuses a token that presents no scopes at all", () => {
    expect(narrowTokenGrantToKeyScopes([], [READ_SCOPE])).toBeNull();
  });
});

describe("toolRequiredScopes", () => {
  it("defaults an unannotated tool to the read requirement", () => {
    expect(toolRequiredScopes({})).toEqual(DEFAULT_TOOL_REQUIRED_SCOPES);
    expect(DEFAULT_TOOL_REQUIRED_SCOPES).toEqual([READ_SCOPE]);
  });

  it("honors an explicit requirement over the default", () => {
    expect(toolRequiredScopes({ requiredScopes: [DELETE_SCOPE] })).toEqual([
      DELETE_SCOPE,
    ]);
  });

  it("honors an explicit empty requirement as a deliberate opt-out", () => {
    expect(toolRequiredScopes({ requiredScopes: [] })).toEqual([]);
  });

  it("gates a write tool on write rather than also demanding read", () => {
    expect(toolRequiredScopes({ requiresWrite: true })).toEqual([WRITE_SCOPE]);
  });
});

describe("revalidateCachedGrant", () => {
  it("returns null when the cached context has no resolvable key scopes", () => {
    expect(
      revalidateCachedGrant(contextFor(null), [READ_SCOPE, WRITE_SCOPE])
    ).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      API_KEY_SCOPES_UNRESOLVABLE_EVENT,
      expect.objectContaining({ surface: "mcp_oauth" })
    );
  });

  it("narrows the cached grant down to the scopes the key still carries", () => {
    expect(
      revalidateCachedGrant(contextFor([READ_SCOPE]), [READ_SCOPE, WRITE_SCOPE])
    ).toEqual([READ_SCOPE]);
  });

  it("returns null when the cached grant no longer overlaps the key at all", () => {
    expect(
      revalidateCachedGrant(contextFor([READ_SCOPE]), [WRITE_SCOPE])
    ).toBeNull();
  });
});
