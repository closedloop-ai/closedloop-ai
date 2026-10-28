/**
 * ISS-7778 — grant vs restriction, and what a blanket suppression may touch.
 *
 * THE ORACLE BELOW IS WRITTEN INDEPENDENTLY OF THE IMPLEMENTATION, ON PURPOSE.
 * Its PostHog keys are literal strings rather than imports of the very constants
 * under test, because a fixture derived from the registry cannot fail: rename a
 * key, drop a flag, or flip a kind and a derived fixture renames, drops, and
 * flips with it and stays green. Duplication is wrong in production code and is
 * the entire mechanism of a contract test. The KIND values still come from
 * `ServerFeatureFlagKind`, which is a name for a value and not a claim about any
 * flag, so pinning it by reference costs nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isFeatureFlagEnabledForAnyIdentity } from "@/lib/feature-flag-identity";
import {
  defineGrantFlag,
  ServerFeatureFlagKind,
  type ServerFeatureFlagKind as ServerFeatureFlagKindType,
} from "@/lib/feature-flags/server-feature-flag";
import { evaluateServerFeatureFlagForDistinctId } from "@/lib/feature-flags/server-feature-flag-evaluation";
import {
  isFlagSuppressed,
  suppressGrants,
} from "@/lib/feature-flags/server-feature-flag-suppression";
import {
  COMPUTE_TARGET_SIGNING_SERVER_FLAG,
  DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG,
  listServerFeatureFlags,
  PUBLIC_GITHUB_REPOS_SERVER_FLAG,
  suppressAllGrants,
  WEB_GUIDED_ONBOARDING_REQUIRED_PHASES_SERVER_FLAG,
} from "@/lib/feature-flags/server-feature-flags";

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: vi.fn(),
  getAllFeatureFlagsForDistinctId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn() },
}));

const { Grant, Restriction } = ServerFeatureFlagKind;

/**
 * Every server-evaluated PostHog key `apps/api` reads, and what enabling it
 * does. Hand-written; the registry is compared TO this, never derived from it.
 */
const EXPECTED_CLASSIFICATION: Readonly<
  Record<string, ServerFeatureFlagKindType>
> = {
  // ISS-9437: the canonical root-first status ORDER. Enabling it reorders the
  // Branches page and its Status facet; it never changes which rows or which
  // options are there, so withholding it can only ever narrow behaviour -- Grant.
  "artifact-status-root-order": Grant,
  "branch-pr": Grant,
  "branch-push-evidence-exclusion": Grant,
  "compute-target-signing": Restriction,
  "desktop-managed-pop-enforcement": Restriction,
  "desktop-managed-pop-provisioning": Grant,
  // ISS-11945: enabling it starts desktop session replay; withholding it only
  // leaves an install unrecorded -- Grant.
  "desktop-session-replay": Grant,
  // ISS-12048: ON lets an internal viewer's Dev Tools overrides apply; withheld,
  // the request reads live flags -- Grant.
  "dev-mode": Grant,
  // PLN-2187: ON moves an org's document comments to Postgres. Withheld from
  // one viewer of a switched org, it would split that org's writes across two
  // stores -- Restriction.
  "document-unified-comments": Restriction,
  "electron-remote-update": Grant,
  "mcp-upload-attachment": Grant,
  // PRD-725: enabling it adds hierarchy placement and manual ordering while
  // withholding it preserves the pre-existing tree and write behavior.
  "manual-artifact-ordering": Grant,
  "pensero-integration": Grant,
  "pensero-points-per-dollar": Grant,
  "public-github-repos": Grant,
  // Grants Mesh cloud participation; missing/off preserves ordinary harness use.
  "session-mesh-v1": Grant,
  // ISS-8554: the TypedSQL shadow COMPARISON, not the cutover -- both the
  // usage-summary shadow and (ISS-8554 Phase 3) the list-sort shadow. Enabling
  // it adds a read-only diagnostic beside the response and changes nothing a
  // reader sees, so withholding it can only ever narrow behaviour -- Grant.
  "sessions-usage-typed-sql-shadow": Grant,
  "unmeasured-delivery-population": Grant,
  // ISS-12552: evidence-based session classification on read surfaces. Off,
  // every surface keeps today's link classification -- Grant.
  "attribution-evidence-policy": Grant,
  // ISS-10422 (PRD-714), read server-side by ISS-10472: the grouped artifact
  // board sections on RETAINED status evidence instead of the coerced lifecycle
  // value, and orders those sections by the raw display rank rather than the
  // coerced one. It only moves a row the caller already sees into a different
  // section, so withholding it can only ever narrow behaviour -- Grant.
  "universal-artifact-status": Grant,
  // ISS-11073: the reconciled guided-onboarding required phases. The phases are
  // BLOCKING -- enabling it keeps the first user OUT of Ready until invitations
  // and the Desktop download are answered -- so withholding it WIDENS what is
  // reachable -- Restriction.
  "web-guided-onboarding-required-phases": Restriction,
};

const IDENTITY = { userId: "user-1", clerkUserId: "clerk-1" };
const LOG_KEY = "iss7778_classification_test_flag_unavailable";

async function loadAnalyticsMock() {
  const analytics = await import("@repo/analytics/feature-flags");
  return vi.mocked(analytics.isFeatureFlagEnabledForDistinctId);
}

describe("server feature flag classification (ISS-7778)", () => {
  beforeEach(async () => {
    (await loadAnalyticsMock()).mockReset();
  });

  it("classifies every registered flag exactly as the pinned contract says", () => {
    const actual: Record<string, ServerFeatureFlagKindType> = {};
    for (const flag of listServerFeatureFlags()) {
      actual[flag.key] = flag.kind;
    }
    expect(actual).toEqual(EXPECTED_CLASSIFICATION);
  });

  // Separate from the map comparison above so the failure MESSAGE names the
  // arithmetic when a flag is added or removed without touching the oracle.
  it("registers exactly the flags the pinned contract enumerates", () => {
    expect(listServerFeatureFlags()).toHaveLength(
      Object.keys(EXPECTED_CLASSIFICATION).length
    );
  });

  it("classifies the two enforcement flags as restrictions", () => {
    expect(DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG.kind).toBe(Restriction);
    expect(COMPUTE_TARGET_SIGNING_SERVER_FLAG.kind).toBe(Restriction);
  });
});

/**
 * ISS-11073: the required-phases gate decides a BLOCKING sequence, so a blanket
 * suppression must not be able to switch it off.
 *
 * ITS OWN CASE, named for the flag, deliberately separate from the two
 * whole-registry sweeps above. Those iterate on `flag.kind`, so flipping this
 * key back to `defineGrantFlag` moves it from one sweep to the other and BOTH
 * stay green; only the hand-written oracle would catch it, and an oracle in this
 * same file is one edit away from being flipped with the flag. This asserts the
 * CONSEQUENCE against the named descriptor instead: reachability under
 * `suppressAllGrants`. Re-shape the flag as a grant and this goes red on the
 * behaviour, not on a bookkeeping map.
 *
 * Why it matters rather than being bookkeeping: a suppressed grant resolves an
 * ANSWERED `false` (`evaluateServerFeatureFlagForDistinctId`), and `false` on
 * this key is the pre-flag fold — the first user is settled straight to `Ready`
 * on the legacy wizard marker, with invitations and the required Desktop
 * download never shown. Suppression would therefore WIDEN what the reader can
 * reach, which is the definition of a restriction and the one thing
 * `suppressAllGrants` promises it cannot do (whitlockk on #7854).
 */
describe("the required-phases gate is not suppressible (ISS-11073)", () => {
  it("classifies the required-phases gate as a restriction", () => {
    expect(WEB_GUIDED_ONBOARDING_REQUIRED_PHASES_SERVER_FLAG.kind).toBe(
      Restriction
    );
  });

  it("leaves the required-phases gate reachable under a blanket suppression", () => {
    expect(
      isFlagSuppressed(
        suppressAllGrants(),
        WEB_GUIDED_ONBOARDING_REQUIRED_PHASES_SERVER_FLAG
      )
    ).toBe(false);
  });

  // The suppression it survives is not an empty one: a real grant in the same
  // blanket is still withheld, so the case above cannot pass by inertness.
  it("still withholds a real grant in the same blanket suppression", () => {
    expect(
      isFlagSuppressed(suppressAllGrants(), PUBLIC_GITHUB_REPOS_SERVER_FLAG)
    ).toBe(true);
  });
});

describe("blanket suppression can only withhold grants (ISS-7778)", () => {
  beforeEach(async () => {
    (await loadAnalyticsMock()).mockReset();
  });

  // THE NEGATIVE. On its own this is vacuous — a suppression that withheld
  // nothing at all would pass it — which is why the positive sibling below
  // drives the SAME mechanism through the SAME call path.
  it("leaves every restriction reachable under a blanket suppression", () => {
    const suppression = suppressAllGrants();
    for (const flag of listServerFeatureFlags()) {
      if (flag.kind === Restriction) {
        expect(isFlagSuppressed(suppression, flag)).toBe(false);
      }
    }
  });

  // THE ANCHOR. Proves the suppression is not inert.
  it("withholds every grant under the same blanket suppression", () => {
    const suppression = suppressAllGrants();
    for (const flag of listServerFeatureFlags()) {
      if (flag.kind === Grant) {
        expect(isFlagSuppressed(suppression, flag)).toBe(true);
      }
    }
  });

  it("still evaluates a restriction against PostHog when everything is suppressed", async () => {
    const isEnabled = await loadAnalyticsMock();
    isEnabled.mockResolvedValue(true);

    await expect(
      isFeatureFlagEnabledForAnyIdentity(
        DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG,
        IDENTITY,
        LOG_KEY,
        suppressAllGrants()
      )
    ).resolves.toBe(true);
    expect(isEnabled).toHaveBeenCalledWith(
      "desktop-managed-pop-enforcement",
      "clerk-1"
    );
  });

  it("withholds a grant through the same call path, without asking PostHog", async () => {
    const isEnabled = await loadAnalyticsMock();
    isEnabled.mockResolvedValue(true);

    await expect(
      isFeatureFlagEnabledForAnyIdentity(
        PUBLIC_GITHUB_REPOS_SERVER_FLAG,
        IDENTITY,
        LOG_KEY,
        suppressAllGrants()
      )
    ).resolves.toBe(false);
    expect(isEnabled).not.toHaveBeenCalled();
  });

  // A suppressed grant must read as an ANSWERED `false`, never as UNAVAILABLE:
  // `null` tells a memoizing gate to HOLD its last decision, which would serve
  // a previously-evaluated `true` straight through the suppression.
  it("reports a suppressed grant as an answered false, not as unavailable", async () => {
    await expect(
      evaluateServerFeatureFlagForDistinctId(
        PUBLIC_GITHUB_REPOS_SERVER_FLAG,
        "clerk-1",
        suppressAllGrants()
      )
    ).resolves.toBe(false);
  });

  it("passes a flag straight through when no suppression is supplied", async () => {
    const isEnabled = await loadAnalyticsMock();
    isEnabled.mockResolvedValue(true);

    await expect(
      evaluateServerFeatureFlagForDistinctId(
        PUBLIC_GITHUB_REPOS_SERVER_FLAG,
        "clerk-1"
      )
    ).resolves.toBe(true);
  });

  it("suppresses only the grants it was given", () => {
    const suppression = suppressGrants([PUBLIC_GITHUB_REPOS_SERVER_FLAG]);

    expect(isFlagSuppressed(suppression, PUBLIC_GITHUB_REPOS_SERVER_FLAG)).toBe(
      true
    );
    expect(
      isFlagSuppressed(suppression, DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG)
    ).toBe(false);
  });

  /**
   * The unrepresentability claim, checked by the compiler rather than at
   * runtime: `tsc` must reject a restriction here. If `suppressGrants` ever
   * widens to accept `ServerFeatureFlag`, this `@ts-expect-error` becomes
   * unused and typecheck FAILS — so the guard cannot rot silently.
   */
  it("cannot express a suppression containing a restriction", () => {
    const suppression = suppressGrants([
      // @ts-expect-error — a RestrictionFeatureFlag is not a GrantFeatureFlag.
      DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG,
    ]);
    // The runtime value is irrelevant; the assertion above is the compiler's.
    expect(suppression.suppressedKeys.size).toBe(1);
  });

  /**
   * THE COUNTEREXAMPLE THE TEST ABOVE DOES NOT COVER (PR #6494 review).
   *
   * Passing the restriction DESCRIPTOR fails, but `defineGrantFlag` is public
   * and generic over `Key extends string`, so re-declaring the kind for a
   * restriction's KEY produced a `GrantFeatureFlag<"desktop-managed-pop-
   * enforcement">` that satisfied the old open parameter. Because
   * `isFlagSuppressed` is deliberately membership-only, the resulting
   * suppression withheld proof-of-possession enforcement — and
   * `verifyDesktopManagedPop` reports `accepted: mode !== "enforce"`, so a
   * FAILED proof would have been accepted.
   *
   * `suppressGrants` now takes the registry-derived grant union, in which that
   * key exists only as a restriction. If the parameter ever widens back to
   * `GrantFeatureFlag<string>`, this `@ts-expect-error` goes unused and
   * typecheck FAILS, so the narrowing cannot rot silently.
   */
  it("cannot express a suppression built by re-declaring a restriction key as a grant", () => {
    const forgedGrant = defineGrantFlag(
      DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG.key
    );
    const suppression = suppressGrants([
      // @ts-expect-error — a re-declared restriction key is not a REGISTERED grant.
      forgedGrant,
    ]);

    // Runtime proof of what the compiler is buying: membership alone WOULD have
    // honored it, so the type is the only thing standing between this value and
    // suppressed PoP enforcement.
    expect(
      isFlagSuppressed(suppression, DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG)
    ).toBe(true);
  });

  /**
   * The narrowing must not have been bought by making `suppressGrants`
   * unusable: a genuine registered grant descriptor still type-checks. Without
   * this, narrowing the parameter to `never` would pass every test above.
   */
  it("still accepts a registered grant descriptor", () => {
    expect(
      isFlagSuppressed(
        suppressGrants([PUBLIC_GITHUB_REPOS_SERVER_FLAG]),
        PUBLIC_GITHUB_REPOS_SERVER_FLAG
      )
    ).toBe(true);
  });

  /**
   * The signature of `suppressGrants` alone would constrain only `suppressGrants`
   * — a caller could still hand-roll the STRUCTURE and put a restriction key in
   * it, because `isFlagSuppressed` is (deliberately) pure set membership and
   * would honor it. The brand inside the suppression module is what closes that,
   * and this pins it: a forged literal must not be assignable.
   */
  it("cannot express a suppression built by hand around the constructor", () => {
    const forged = {
      suppressedKeys: new Set([
        DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG.key,
      ]),
    };

    expect(
      isFlagSuppressed(
        // @ts-expect-error — an unbranded object literal is not a GrantSuppression.
        forged,
        DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG
      )
    ).toBe(true);
  });
});
