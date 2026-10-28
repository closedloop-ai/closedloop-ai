/**
 * @file feature-flags-shared-ui.test.ts
 * @description The SHARED web+desktop UI feature flags (ISS-4779
 * closed-by-default), split out of `feature-flags.test.ts` when that file
 * crossed the 1,000-line hard ceiling.
 *
 * This family is its own responsibility and it is the one that keeps growing:
 * still-registered Labs flags must stay default OFF and byte-identical to their
 * web/PostHog keys. Retired shared keys, such as GridTable v2 after ISS-9430,
 * are pinned separately so they keep the shared alias without leaving a
 * persisted Desktop Labs shadow behind.
 */
import assert from "node:assert/strict";
import { AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY } from "@repo/api/src/types/agents-card-attribute-labels-flag";
import { AGENTS_DEFAULT_SORT_USAGE_FLAG_KEY } from "@repo/api/src/types/agents-default-sort-usage-flag";
import { AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY } from "@repo/api/src/types/agents-definition-empty-state-flag";
import { AGENTS_DETAIL_HONESTY_FLAG_KEY } from "@repo/api/src/types/agents-detail-honesty-flag";
import { AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY } from "@repo/api/src/types/agents-invocations-dedupe-flag";
import { AGENTS_SOURCE_PROVENANCE_FLAG_KEY } from "@repo/api/src/types/agents-source-provenance-flag";
import { AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY } from "@repo/api/src/types/agents-type-tab-overflow-flag";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY } from "@repo/api/src/types/branch-timeline-cost-fallback-marker-flag";
import { ELIGIBLE_BRANCH_NAVIGATION_FLAG_KEY } from "@repo/api/src/types/eligible-branch-navigation-flag";
import { MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY } from "@repo/api/src/types/member-self-service-install-flag";
import { SESSION_CLAUDE_REPORTED_COST_FLAG_KEY } from "@repo/api/src/types/session-claude-reported-cost-flag";
import { SESSION_LAUNCH_ATTRIBUTION_FLAG_KEY } from "@repo/api/src/types/session-launch-attribution-flag";
import { SESSION_METRIC_POPULATION_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-metric-population-disclosure-flag";
import { afterEach, test } from "vitest";
import { RETIRED_LABS_SETTING_KEYS } from "../src/main/settings/labs-setting-key-ledger.js";
import { DEFAULT_DESKTOP_SETTINGS } from "../src/shared/contracts.js";
import {
  DESKTOP_AGENTS_CARD_ATTRIBUTE_LABELS_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_BRANCH_TIMELINE_COST_FALLBACK_MARKER_FEATURE_FLAG_KEY,
  DESKTOP_MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
  FEATURE_FLAGS,
  type FlagKey,
} from "../src/shared/feature-flags.js";
import {
  DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY,
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
} from "../src/shared/feature-flags-labs-detail.js";
import {
  DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY,
  DESKTOP_ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY,
} from "../src/shared/feature-flags-labs-surfaces.js";
import {
  cleanupFeatureFlagStores,
  makeFeatureFlagStore,
} from "./feature-flags-store-fixture.js";

afterEach(cleanupFeatureFlagStores);

test("ISS-6400: eligible Branch navigation is registered closed for audited rollout", () => {
  assert.equal(
    DESKTOP_ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY,
    ELIGIBLE_BRANCH_NAVIGATION_FLAG_KEY
  );
  const definition = FEATURE_FLAGS.find(
    (flag) => flag.key === DESKTOP_ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY
  );
  assert.ok(definition);
  assert.equal(definition.default, false);
  assert.notEqual(definition.hiddenFromLabs, true);
  assert.equal(
    DEFAULT_DESKTOP_SETTINGS[
      DESKTOP_ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY
    ],
    false
  );
});

/**
 * ISS-10301 retired the `grid-table-v2` KEY, so the constant this case used to
 * read is gone and the literal stands in for it. The SWEEP entry is what still
 * has to hold: an already-installed build can carry a persisted Labs value under
 * this name, and `RETIRED_LABS_SETTING_KEYS` is the only thing that clears it.
 */
const RETIRED_GRID_TABLE_V2_LABS_KEY = "grid-table-v2";

test("ISS-9430/ISS-10301: the retired GridTable v2 Labs key is swept, not registered", () => {
  assert.equal(
    FEATURE_FLAGS.find((flag) => flag.key === RETIRED_GRID_TABLE_V2_LABS_KEY),
    undefined
  );
  assert.equal(
    Object.hasOwn(DEFAULT_DESKTOP_SETTINGS, RETIRED_GRID_TABLE_V2_LABS_KEY),
    false
  );
  assert.equal(
    RETIRED_LABS_SETTING_KEYS.includes(RETIRED_GRID_TABLE_V2_LABS_KEY),
    true
  );
});

// ISS-4890/4906/4901 and ISS-4887: these still-registered shared
// web+desktop UI flags must be default OFF, with literals equal to the PostHog
// keys so a rename cannot split the two surfaces.
for (const { issue, desktopKey, sharedKey } of [
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
    issue: "ISS-5532",
    desktopKey: DESKTOP_AGENTS_CARD_ATTRIBUTE_LABELS_FEATURE_FLAG_KEY,
    sharedKey: AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY,
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
  {
    issue: "ISS-7229",
    desktopKey: DESKTOP_SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY,
    sharedKey: SESSION_CLAUDE_REPORTED_COST_FLAG_KEY,
  },
  {
    issue: "ISS-7259",
    desktopKey: DESKTOP_SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY,
    sharedKey: SESSION_LAUNCH_ATTRIBUTION_FLAG_KEY,
  },
  {
    issue: "ISS-7737",
    desktopKey: DESKTOP_SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
    sharedKey: SESSION_METRIC_POPULATION_DISCLOSURE_FLAG_KEY,
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
      "flag must remain an exposed Labs gate"
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
// a future generic flag surface nest and disable the row; stated only in prose it would be a
// dependency the UI does not enforce.
test("ISS-4803: the type-tab overflow toggle declares its agentsNav dependency", () => {
  const def = FEATURE_FLAGS.find(
    (f) => f.key === DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY
  );
  assert.ok(def, "flag must be registered in FEATURE_FLAGS");
  assert.equal(def.dependsOn, DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY);
});

// ISS-5532/ISS-5310: the Agents card lives inside the Agents workspace too, so
// its Labs toggle is inert on the same terms as the one above.
test("ISS-5532: the card attribute-labels toggle declares its agentsNav dependency", () => {
  const def = FEATURE_FLAGS.find(
    (f) => f.key === DESKTOP_AGENTS_CARD_ATTRIBUTE_LABELS_FEATURE_FLAG_KEY
  );
  assert.ok(def, "flag must be registered in FEATURE_FLAGS");
  assert.equal(def.dependsOn, DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY);
});

// Each desktop-e2e spec below seeds its flag key as a string LITERAL —
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
    // ISS-6758: `diagnostics-coverage-tab.spec.ts` seeds this key as a literal
    // for the same loader reason.
    desktopKey: DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY,
    e2eLiteral: "activity-coverage-diagnostics",
    spec: "diagnostics-coverage-tab.spec.ts",
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
  store.setFlag("agentsNav" as FlagKey, true);

  // Turning the container on and back off must not write to either of them —
  // flipping Labs back on has to restore exactly what was showing before.
  store.setFlag(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY as FlagKey, true);
  store.setFlag(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY as FlagKey, false);

  assert.equal(store.getFlag("docsHelp" as FlagKey), true);
  assert.equal(store.getFlag("agentsNav" as FlagKey), true);
});

// ISS-5009: the Agents catalog Source column, its detail Properties row and its
// Source facet are all SHARED web+desktop surfaces, so this flag must be
// registered as a Labs toggle on desktop, default OFF (ISS-4779
// closed-by-default), with a literal equal to the PostHog key. The renderer
// gate itself is the PostHog assignment (ISS-8753), so what this pins is the
// key parity and the closed default the registry still carries.
test("ISS-5009: agents-source-provenance-honesty is a Labs flag, default OFF, and round-trips through getFlag/setFlag", () => {
  // Parity with the shared cross-surface constant: the desktop Labs key and the
  // web PostHog key BOTH alias `AGENTS_SOURCE_PROVENANCE_FLAG_KEY` from
  // `@repo/api`, so a rename touches one definition and can't split the surfaces
  // (whitlockk, PR #4202). Assert against the shared constant, not a raw string.
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
    "flag must remain an exposed Labs gate"
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
