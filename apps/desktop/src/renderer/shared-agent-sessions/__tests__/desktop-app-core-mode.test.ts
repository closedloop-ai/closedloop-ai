import { describe, expect, it } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import {
  DesktopAppCoreMode,
  type DesktopAppCoreModeInput,
  DesktopLocalReadReason,
  resolveDesktopAppCoreMode,
  resolveDesktopLocalReadReason,
} from "../desktop-app-core-mode";

/** Authenticated and online — the one state that reads cloud. */
function cloudInput(
  overrides: Partial<DesktopAppCoreModeInput> = {}
): DesktopAppCoreModeInput {
  return {
    status: DesktopAuthStatus.Authenticated,
    isOnline: true,
    ...overrides,
  };
}

describe("resolveDesktopAppCoreMode", () => {
  // PRD-522 R1.3 mutation-sanity guard: an authenticated, online desktop must
  // resolve to the cloud (http) read. Forcing scope:"local" here (regressing the
  // PLN-1138 cutover) would flip this to Local and fail.
  it("reads cloud when authenticated and online", () => {
    expect(resolveDesktopAppCoreMode(cloudInput())).toBe(
      DesktopAppCoreMode.Cloud
    );
  });

  it("degrades an authenticated session to local while offline (D3 / AC-3.3)", () => {
    expect(resolveDesktopAppCoreMode(cloudInput({ isOnline: false }))).toBe(
      DesktopAppCoreMode.Local
    );
  });

  it("stays local for every non-authenticated status, online or not", () => {
    const nonAuthenticated = Object.values(DesktopAuthStatus).filter(
      (status) => status !== DesktopAuthStatus.Authenticated
    );
    // Guards the enum itself: if a status is added, it must be considered here
    // rather than silently defaulting one way.
    expect(nonAuthenticated).toEqual([
      DesktopAuthStatus.Loading,
      DesktopAuthStatus.SignedOut,
      DesktopAuthStatus.OpeningBrowser,
      DesktopAuthStatus.AwaitingRedirect,
      DesktopAuthStatus.Exchanging,
      DesktopAuthStatus.RefreshFailed,
    ]);

    for (const status of nonAuthenticated) {
      for (const isOnline of [true, false]) {
        expect(
          resolveDesktopAppCoreMode(cloudInput({ status, isOnline })),
          `${status} (online=${isOnline}) must stay local`
        ).toBe(DesktopAppCoreMode.Local);
      }
    }
  });
});

/**
 * The consent carve-out this block used to pin is GONE, deliberately (operator
 * ruling, 2026-09-25). Those cases asserted that a device whose user chose a
 * tier sending nothing — or had not chosen one yet — was held on local reads.
 * That answered "may you read your workspace" with "may we upload your
 * sessions", and during onboarding, when nobody has elected a level, it held
 * every reader out of the org data the delivery cards are computed from.
 *
 * What replaces them is the split itself: consent decides EGRESS, in main
 * (`agent-sync/sync-egress-gate.ts`), and nothing about the read source.
 */
describe("resolveDesktopAppCoreMode — ingress is not gated on egress", () => {
  it("takes no consent term at all", () => {
    // Keyed off `keyof` rather than the keys of a literal typed here: a literal
    // only reproduces what the author wrote, and `tsc` on a total literal only
    // catches a new REQUIRED field — an optional `syncConsent?:` would slip past
    // both. `Record<keyof T, true>` cannot be written without naming every key,
    // optional ones included, so re-adding the term in any form fails to compile
    // until someone edits this line.
    const modeInputKeys: Record<keyof DesktopAppCoreModeInput, true> = {
      isOnline: true,
      status: true,
    };
    expect(Object.keys(modeInputKeys).sort()).toEqual(["isOnline", "status"]);
  });
});

/**
 * "A reader who elected nothing still reads the workspace" is NOT pinned here.
 * The input type can no longer express an elected tier, so a resolver-level case
 * would be the cloud case above retyped, green under the exact regression it
 * claims to prevent. It is pinned where the consent record still physically
 * reaches the decision — at the provider, in
 * `shared-branches/__tests__/read-source-cross-surface-parity.test.tsx`, which
 * mounts with a withholding record and with no elected tier and asserts Cloud on
 * both surfaces.
 */

describe("resolveDesktopLocalReadReason", () => {
  it("says nothing when the reader is on the cloud", () => {
    expect(resolveDesktopLocalReadReason(cloudInput())).toBeUndefined();
  });

  it("names the condition that is holding the reader local", () => {
    expect(
      resolveDesktopLocalReadReason(
        cloudInput({ status: DesktopAuthStatus.SignedOut })
      )
    ).toBe(DesktopLocalReadReason.SignedOut);
    expect(resolveDesktopLocalReadReason(cloudInput({ isOnline: false }))).toBe(
      DesktopLocalReadReason.Offline
    );
  });

  it("always names one, because the mode has only these two ways to be local", () => {
    // Totality, not a third case: `sync_off` was a reason and is gone with the
    // term it reported on, so a Local reader can no longer be handed a badge
    // with no sentence beside it.
    expect(Object.values(DesktopLocalReadReason).sort()).toEqual([
      DesktopLocalReadReason.Offline,
      DesktopLocalReadReason.SignedOut,
    ]);
    for (const status of Object.values(DesktopAuthStatus)) {
      for (const isOnline of [true, false]) {
        const input = cloudInput({ isOnline, status });
        const reason = resolveDesktopLocalReadReason(input);
        const isLocal =
          resolveDesktopAppCoreMode(input) === DesktopAppCoreMode.Local;
        expect(
          reason !== undefined,
          `${status} (online=${isOnline}) must name a reason iff local`
        ).toBe(isLocal);
      }
    }
  });
});
