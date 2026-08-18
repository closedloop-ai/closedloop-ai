/**
 * ISS-4905: `verifyKeyWithMetadata` refuses a key whose stored scope array is
 * empty, absent, or entirely unrecognized. Any projection that reports such a
 * key as present would then contradict the verifier — a "Protected" badge over
 * a credential that cannot authenticate. This pins the shared predicate those
 * projections filter with.
 */

import { API_KEY_SCOPES, ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  ApiKeyScopeResolutionStatus,
  resolveApiKeyScopes,
} from "@repo/api/src/utils/api-key-scope-resolution";
import { describe, expect, it, vi } from "vitest";
import { usableApiKeyWhere } from "../usable-api-key-where";

const NOW = new Date("2026-08-02T00:00:00.000Z");

describe("usableApiKeyWhere", () => {
  it("excludes revoked keys", () => {
    expect(usableApiKeyWhere(NOW).revokedAt).toBeNull();
  });

  it("admits a never-expiring key and one expiring after the given instant", () => {
    expect(usableApiKeyWhere(NOW).OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: NOW } },
    ]);
  });

  // The scope predicate must be the query-side mirror of `resolveApiKeyScopes`:
  // "at least one recognized scope survives sanitization". `hasSome` over the
  // shared vocabulary is exactly that, and is false for `[]` — fail closed.
  it("requires at least one scope from the shared vocabulary", () => {
    expect(usableApiKeyWhere(NOW).scopes).toEqual({
      hasSome: [...API_KEY_SCOPES],
    });
  });

  it("matches what the verifier's resolver treats as resolvable", () => {
    const { hasSome } = usableApiKeyWhere(NOW).scopes;

    for (const scope of API_KEY_SCOPES) {
      expect(hasSome).toContain(scope);
      expect(resolveApiKeyScopes([scope]).status).toBe(
        ApiKeyScopeResolutionStatus.Resolved
      );
    }
    // An all-unrecognized row intersects nothing in `hasSome`, and the resolver
    // agrees it is unresolvable.
    expect(hasSome).not.toContain("superuser");
    expect(resolveApiKeyScopes(["superuser"]).status).toBe(
      ApiKeyScopeResolutionStatus.Unresolvable
    );
    expect(resolveApiKeyScopes([]).status).toBe(
      ApiKeyScopeResolutionStatus.Unresolvable
    );
    expect(resolveApiKeyScopes([ApiKeyScope.Read]).status).toBe(
      ApiKeyScopeResolutionStatus.Resolved
    );
  });

  it("defaults the expiry instant to now when none is supplied", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const [, expiring] = usableApiKeyWhere().OR;
      expect(expiring.expiresAt.gt).toEqual(NOW);
    } finally {
      vi.useRealTimers();
    }
  });
});
