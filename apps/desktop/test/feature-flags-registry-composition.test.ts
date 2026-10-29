import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../src/shared/feature-flags.js";
import { REGISTRY_MEMBERSHIP_WITNESS } from "./feature-flags-registry-membership-witness.js";

/**
 * The registry's membership, pinned against a hand-transcribed witness.
 *
 * The witness itself moved to `feature-flags-registry-membership-witness.ts`
 * (ISS-8071) so `labs-setting-key-ledger.test.ts` — the file a lane adding a
 * Labs setting key actually reads — can reconcile MEMBERSHIP against the same
 * literal instead of keeping a second copy of it. That suite carries the
 * six-site manifest. ISS-8753 deleted Settings -> Labs, so this suite no longer
 * enforces position as UI behavior.
 */
describe("feature flag registry composition (ISS-7431)", () => {
  it("registers every witnessed flag exactly once", () => {
    expect(new Set(FEATURE_FLAGS.map((flag) => flag.key))).toEqual(
      new Set(REGISTRY_MEMBERSHIP_WITNESS)
    );
  });

  it("keeps the registry free of duplicate keys after composing four modules", () => {
    const keys = FEATURE_FLAGS.map((flag) => flag.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
