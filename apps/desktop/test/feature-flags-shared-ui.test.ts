/**
 * @file feature-flags-shared-ui.test.ts
 * @description The SHARED web+desktop UI feature flags (ISS-4779
 * closed-by-default), split out of `feature-flags.test.ts` when that file
 * crossed the 1,000-line hard ceiling.
 *
 * This family is its own responsibility and it is the one that keeps growing:
 * every closed-by-default UI change adds a flag that must be (a) registered as a
 * desktop Labs toggle, default OFF — the packaged renderer has no PostHog wiring,
 * so an unregistered shared key falls through to the build-type default (ON in
 * dev), which is the leak — and (b) byte-identical to the web PostHog key, so a
 * rename cannot split the two surfaces. Its sibling keeps the SettingsStore's own
 * behavior: getFlag/setFlag, sources, env overrides, and the legacy wrappers.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AGENTS_DEFAULT_SORT_USAGE_FLAG_KEY } from "@repo/api/src/types/agents-default-sort-usage-flag";
import { AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY } from "@repo/api/src/types/agents-definition-empty-state-flag";
import { AGENTS_DETAIL_HONESTY_FLAG_KEY } from "@repo/api/src/types/agents-detail-honesty-flag";
import { AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY } from "@repo/api/src/types/agents-invocations-dedupe-flag";
import { AGENTS_SOURCE_PROVENANCE_FLAG_KEY } from "@repo/api/src/types/agents-source-provenance-flag";
import { AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY } from "@repo/api/src/types/agents-type-tab-overflow-flag";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY } from "@repo/api/src/types/branch-timeline-cost-fallback-marker-flag";
import { GRID_TABLE_V2_FLAG_KEY } from "@repo/api/src/types/grid-table-v2-flag";
import { MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY } from "@repo/api/src/types/member-self-service-install-flag";
import { SESSIONS_GRID_FOLD_LEGIBILITY_FLAG_KEY } from "@repo/api/src/types/sessions-grid-fold-legibility-flag";
import { DEFAULT_DESKTOP_SETTINGS } from "../src/shared/contracts.js";
import {
  DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY,
  DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY,
  DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY,
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY,
  DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY,
  FEATURE_FLAGS,
  type FlagKey,
} from "../src/shared/feature-flags.js";
import {
  cleanupFeatureFlagStores,
  makeFeatureFlagStore,
} from "./feature-flags-store-fixture.js";

afterEach(cleanupFeatureFlagStores);

// ISS-4890/4906/4901 and ISS-4887: both shared web+desktop UI flags must be
// registered as Labs toggles on desktop, default OFF (ISS-4779
// closed-by-default), with literals equal to the PostHog keys so the features
// cannot leak on one surface while hidden on the other. The packaged desktop
// renderer has no PostHog wiring, so without a registry entry a desktop user
// could never opt in — and the shared key would fall through to the build-type
// default (ON in dev), which is the leak these guard.
for (const { issue, desktopKey, sharedKey } of [
  {
    issue: "GridTable v2",
    desktopKey: DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY,
    sharedKey: GRID_TABLE_V2_FLAG_KEY,
  },
  {
    issue: "ISS-4890/4906/4901",
    desktopKey: DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY,
    sharedKey: SESSIONS_GRID_FOLD_LEGIBILITY_FLAG_KEY,
  },
  {
    issue: "ISS-5005",
    desktopKey: DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY,
    sharedKey: AGENTS_DEFAULT_SORT_USAGE_FLAG_KEY,
  },
  {
    issue: "ISS-5500",
    desktopKey: DESKTOP_AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY,
    sharedKey: AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY,
  },
  {
    issue: "ISS-4803",
    desktopKey: DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY,
    sharedKey: AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY,
  },
  {
    issue: "ISS-5125",
    desktopKey: DESKTOP_MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY,
    sharedKey: MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY,
  },
  {
    issue: "ISS-5534",
    desktopKey: DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY,
    sharedKey: AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY,
  },
  {
    issue: "ISS-5518/5519/5521",
    desktopKey: DESKTOP_AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY,
    sharedKey: AGENTS_DETAIL_HONESTY_FLAG_KEY,
  },
  {
    issue: "ISS-5951",
    desktopKey: DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY,
    sharedKey: BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY,
  },
]) {
  test(`${issue}: ${desktopKey} is a Labs flag, default OFF, and round-trips through getFlag/setFlag`, () => {
    // Parity with the shared cross-surface constant: the desktop Labs key and
    // the web PostHog key BOTH alias one `@repo/api` literal, so a rename
    // touches a single definition. Assert against that constant, not a string.
    assert.equal(desktopKey, sharedKey);

    const def = FEATURE_FLAGS.find((f) => f.key === desktopKey);
    assert.ok(def, "flag must be registered in FEATURE_FLAGS");
    assert.equal(def.default, false, "flag must default OFF");
    assert.equal(def.category, "Labs");
    assert.notEqual(
      def.hiddenFromLabs,
      true,
      "flag must render in the Labs panel"
    );

    // The PERSISTED contract, not just the registry. `getFlag` below reaches the
    // registry default through a `FlagKey` cast, so it stays green for a key
    // that never landed on `DesktopSettings` — while `getAll()` (which spreads
    // `DEFAULT_DESKTOP_SETTINGS` over the raw store) would omit the key
    // entirely on a fresh profile. Indexed as a record because a missing field
    // is exactly what this asserts against: `undefined !== false` fails, where a
    // typed property access would instead fail to COMPILE and never run.
    assert.equal(
      (DEFAULT_DESKTOP_SETTINGS as Record<string, unknown>)[desktopKey],
      false,
      "the shared key must have a DesktopSettings field defaulting to false"
    );

    const store = makeFeatureFlagStore();
    // Default resolves OFF, and a user opting in through setFlag flips it on.
    assert.equal(store.getFlag(desktopKey as FlagKey), false);
    store.setFlag(desktopKey as FlagKey, true);
    assert.equal(store.getFlag(desktopKey as FlagKey), true);
  });
}

// ISS-4803/ISS-5310: the type-tab strip lives inside the Agents workspace, so
// its Labs toggle is inert while `agentsNav` is off. `dependsOn` is what makes
// the Labs panel nest and disable the row; stated only in prose it would be a
// dependency the UI does not enforce.
test("ISS-4803: the type-tab overflow toggle declares its agentsNav dependency", () => {
  const def = FEATURE_FLAGS.find(
    (f) => f.key === DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY
  );
  assert.ok(def, "flag must be registered in FEATURE_FLAGS");
  assert.equal(def.dependsOn, DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY);
});

// Each desktop-e2e spec below seeds its Labs toggle as a string LITERAL —
// importing `src/shared/feature-flags` into a Playwright spec aborts the whole
// desktop-e2e suite at load time (extension-less `@repo/api/src/types/...`
// specifiers do not resolve under its ESM loader). That is a deliberate copy, so
// each one needs a pin: a rename of any of these flags has to fail here rather
// than silently leave the e2e seeding a key nothing reads.
//
// `spec` names the seeding file so a failure points at the file to fix. It used
// to be hardcoded into the test title, which was already wrong for the second
// entry and would have been wrong for every entry added after it.
for (const { desktopKey, e2eLiteral, spec } of [
  {
    desktopKey: DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY,
    e2eLiteral: "sessions-grid-fold-legibility",
    spec: "sessions-column-fold.spec.ts",
  },
  {
    // ISS-4803: `agents-type-tab-overflow.spec.ts` seeds this key as a literal
    // for the same loader reason. Pinned so a rename fails here rather than
    // leaving that spec seeding a key nothing reads — which would silently
    // degrade it into asserting the flag-OFF render on both sides of the gate.
    desktopKey: DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY,
    e2eLiteral: "agents-type-tab-overflow",
    spec: "agents-type-tab-overflow.spec.ts",
  },
]) {
  test(`${desktopKey} matches the literal ${spec} seeds`, () => {
    assert.equal(desktopKey, e2eLiteral);
  });
}

// --- ISS-5037 (ISS-4779 closed-by-default): the Labs nav container gate ------

test("ISS-5037: labsNav is an off-by-default, Labs-panel-HIDDEN container gate that round-trips", () => {
  const def = FEATURE_FLAGS.find(
    (f) => f.key === DESKTOP_LABS_NAV_FEATURE_FLAG_KEY
  );
  assert.ok(def, "labsNav must be registered in FEATURE_FLAGS");
  assert.equal(def.default, false, "the Labs section must default OFF");
  assert.equal(def.category, "Labs");
  // Deliberately hidden: the ONLY control is the "Enable Labs" checkbox in the
  // native application menu. A generic Labs-panel row would defeat the easter
  // egg and be self-referential (a Labs toggle that hides Labs).
  assert.equal(
    def.hiddenFromLabs,
    true,
    "labsNav must NOT render as a generic Labs-panel toggle"
  );
  assert.equal(
    DEFAULT_DESKTOP_SETTINGS.labsNav,
    false,
    "the persisted DesktopSettings default must also be OFF"
  );

  const store = makeFeatureFlagStore();
  assert.equal(
    store.getFlag(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY as FlagKey),
    false
  );
  store.setFlag(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY as FlagKey, true);
  assert.equal(
    store.getFlag(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY as FlagKey),
    true
  );
});

test("ISS-5037: toggling the Labs container leaves the per-item Labs flags untouched", () => {
  const store = makeFeatureFlagStore();
  // A user has opted into two individual Labs surfaces.
  store.setFlag("docsHelp" as FlagKey, true);
  store.setFlag("auditBot" as FlagKey, true);

  // Turning the container on and back off must not write to either of them —
  // flipping Labs back on has to restore exactly what was showing before.
  store.setFlag(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY as FlagKey, true);
  store.setFlag(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY as FlagKey, false);

  assert.equal(store.getFlag("docsHelp" as FlagKey), true);
  assert.equal(store.getFlag("auditBot" as FlagKey), true);
});

// ISS-5009: the Agents catalog Source column, its detail Properties row and its
// Source facet are all SHARED web+desktop surfaces, so this flag must be
// registered as a Labs toggle on desktop, default OFF (ISS-4779
// closed-by-default), with a literal equal to the PostHog key. Without the
// registry entry the packaged desktop renderer — which has no PostHog wiring —
// falls through to the build-type default, which is the leak this family exists
// to prevent.
test("ISS-5009: agents-source-provenance-honesty is a Labs flag, default OFF, and round-trips through getFlag/setFlag", () => {
  // Parity with the shared cross-surface constant: the desktop Labs key and the
  // web PostHog key BOTH alias `AGENTS_SOURCE_PROVENANCE_FLAG_KEY` from
  // `@repo/api`, so a rename touches one definition and can't split the surfaces
  // (wongk, PR #4202). Assert against the shared constant, not a raw string.
  assert.equal(
    DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
    AGENTS_SOURCE_PROVENANCE_FLAG_KEY
  );

  // Pin the literal STRING too, for the same reason ISS-4848 pins the sync-fold
  // key: an e2e spec that cannot import the constant seeds the Labs setting by
  // literal, and the parity assertion above would survive a value rename.
  assert.equal(
    AGENTS_SOURCE_PROVENANCE_FLAG_KEY,
    "agents-source-provenance-honesty"
  );

  const def = FEATURE_FLAGS.find(
    (f) => f.key === DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY
  );
  assert.ok(def, "flag must be registered in FEATURE_FLAGS");
  assert.equal(def.default, false, "flag must default OFF");
  assert.equal(def.category, "Labs");
  assert.notEqual(
    def.hiddenFromLabs,
    true,
    "flag must render in the Labs panel"
  );
  assert.equal(
    DEFAULT_DESKTOP_SETTINGS[
      DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY as FlagKey
    ],
    false,
    "the shipped default settings must carry the flag OFF"
  );

  const store = makeFeatureFlagStore();
  assert.equal(
    store.getFlag(DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY),
    false
  );
  store.setFlag(DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY, true);
  assert.equal(
    store.getFlag(DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY),
    true
  );
});
