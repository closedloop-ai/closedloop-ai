import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_DESKTOP_SETTINGS } from "../src/shared/contracts.js";
import {
  DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY,
  getFlagDefinition,
} from "../src/shared/feature-flags.js";
import {
  cleanupFeatureFlagStores,
  makeFeatureFlagStore,
} from "./feature-flags-store-fixture.js";

// ISS-5112 (ISS-4779 closed-by-default): the Labs gate for guest-mode first
// run. Lives in its own suite because `feature-flags.test.ts` is in the
// biome.jsonc grandfather list and is shrink-only (see test/AGENTS.md).

afterEach(cleanupFeatureFlagStores);

test("ISS-5112: guest-onboarding is a registered Labs flag that dark-launches OFF", () => {
  const definition = getFlagDefinition(
    DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY
  );
  // The key is pinned as a literal here because the Electron e2e specs cannot
  // import the registry (a main-process import aborts the whole Playwright
  // suite at load — see test/AGENTS.md), so they pin the string. This is what
  // catches a rename before those specs go silently red.
  assert.equal(DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY, "guest-onboarding");
  assert.equal(definition.default, false);
  assert.equal(definition.category, "Labs");
  // Not hidden: the Labs panel is registry-driven, so this is what makes the
  // toggle reachable for a user to opt in.
  assert.notEqual(definition.hiddenFromLabs, true);
  assert.equal(
    DEFAULT_DESKTOP_SETTINGS[DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY],
    false
  );
});

test("ISS-5112: the guest-onboarding flag round-trips through the settings store", () => {
  const store = makeFeatureFlagStore();
  assert.equal(store.getFlag(DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY), false);
  store.setFlag(DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY, true);
  assert.equal(store.getFlag(DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY), true);
});
