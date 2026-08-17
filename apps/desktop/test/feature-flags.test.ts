import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  DEFAULT_DESKTOP_SETTINGS,
  syncTierAllowsSessionMetadata,
  syncTierAllowsTranscripts,
} from "../src/shared/contracts.js";
import { DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY } from "../src/shared/desktop-compute-progress-count-flag.js";
import {
  DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY,
  DESKTOP_LOCAL_SESSION_AUTHORED_PR_GATE_FEATURE_FLAG_KEY,
  DESKTOP_SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY,
  DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY,
  DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY,
  DESKTOP_VALUE_NUMERATOR_V2_FEATURE_FLAG_KEY,
  FEATURE_FLAGS,
  type FlagKey,
  getFlagDefinition,
} from "../src/shared/feature-flags.js";
import {
  cleanupFeatureFlagStores,
  makeFeatureFlagStore,
  makeFeatureFlagStoreDir,
  openFeatureFlagStore,
} from "./feature-flags-store-fixture.js";

afterEach(cleanupFeatureFlagStores);

// --- getFlag ---

// --- FEA-3152 / FEA-4019 / FEA-3995: agents-show-tools-mcps-hooks graduated out of Labs ---

test("registry no longer defines the graduated agents-show-tools-mcps-hooks flag", () => {
  // FEA-3995 graduated Tools, MCPs & Hooks in Agents out of Labs: those kinds
  // render as first-class type tabs for everyone (the shared AgentsGroupedList
  // no longer gates on the flag — FEA-4019), so the Labs toggle and its registry
  // entry were removed. Guard that the key stays gone.
  const def = FEATURE_FLAGS.find(
    (f) => f.key === "agents-show-tools-mcps-hooks"
  );
  assert.equal(
    def,
    undefined,
    "agents-show-tools-mcps-hooks was graduated out of Labs and must not be registered"
  );
});

test("constructor deletes a legacy persisted agents-show-tools-mcps-hooks value", () => {
  // FEA-3995: dropping the registry entry alone leaves an install that had the
  // Labs toggle persisted still carrying the key, and electron-store spreads
  // raw persisted data through getAll() into the IPC response. The retired-key
  // migration must delete it so the graduated flag leaves no residue.
  const store = makeFeatureFlagStore({ "agents-show-tools-mcps-hooks": true });
  assert.equal(
    "agents-show-tools-mcps-hooks" in
      (store.getAll() as unknown as Record<string, unknown>),
    false,
    "the graduated Labs key must be removed from the persisted store"
  );
});

// --- ISS-5280: compute-target-sync-semantics graduated out of Labs ---
//
// `agent-collaboration-network` was retired in the same batch but has since been
// DELIBERATELY RE-INTRODUCED at the operator's request; its guards live in the
// ISS-5061 re-gate block below. The other ISS-5280 retirements stand.

for (const { key, feature } of [
  {
    // `ContextCards` reads the accepted-batch watermark and renders the
    // "Last New Data" column unconditionally now.
    key: "compute-target-sync-semantics",
    feature: "the corrected Compute Target Freshness semantics",
  },
]) {
  test(`registry no longer defines the graduated ${key} flag`, () => {
    // ISS-5280 graduated these to always-on: every read site now keeps the
    // enabled path unconditionally, so the Labs toggle and its registry entry
    // were removed. Guard that the key stays gone — re-registering it would
    // re-introduce an off state the render path no longer honours.
    const def = FEATURE_FLAGS.find((f) => f.key === key);
    assert.equal(
      def,
      undefined,
      `${feature} was graduated out of Labs and ${key} must not be registered`
    );
  });

  test(`constructor deletes a legacy persisted ${key} value`, () => {
    // The toggle defaulted false, so an install that opted in (or explicitly
    // off) still carries the key. electron-store spreads raw persisted data
    // through getAll(), so the retired-key migration must delete it — otherwise
    // a stale `false` bleeds into IPC responses and reads as an opt-OUT of a
    // feature that no longer has an off state.
    const store = makeFeatureFlagStore({ [key]: false });
    assert.equal(
      key in (store.getAll() as unknown as Record<string, unknown>),
      false,
      `the graduated Labs key ${key} must be removed from the persisted store`
    );
  });
}

// ISS-6121 finishes the already-behavioral retirement from ISS-5131 by removing
// the unused settings field and shared key module. Profiles may still carry the
// old Labs setting, so startup must sweep that residue.
test("constructor deletes a legacy persisted session-duration-unmeasurable-span value", () => {
  const key = "session-duration-unmeasurable-span";
  const store = makeFeatureFlagStore({ [key]: true });
  assert.equal(
    key in (store.getAll() as unknown as Record<string, unknown>),
    false,
    `${key} must be removed from the persisted store`
  );
});

// --- ISS-5061 re-gate: agent-collaboration-network is REGISTERED AGAIN ---
//
// Reverses ISS-5280 (#4482) for this one key at the operator's request. These
// tests are the mirror image of the retirement guards above: the flag must be
// registered, default OFF, and — because ISS-5280's migration deleted the key on
// EVERY boot — a user's opt-in must now survive a relaunch.

test("registry defines the re-introduced agent-collaboration-network flag, default off", () => {
  const def = FEATURE_FLAGS.find(
    (f) => f.key === DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY
  );
  assert.ok(
    def,
    "the Agent Collaboration Network Labs toggle must be registered again"
  );
  assert.equal(
    def?.default,
    false,
    "ISS-4779 closed-by-default: the re-introduced toggle must default OFF"
  );
  assert.equal(def?.category, "Labs");
});

test("a fresh install resolves the re-introduced flag OFF", () => {
  const store = makeFeatureFlagStore();
  assert.equal(
    store.getFlag(DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY),
    false
  );
});

test("a stale pre-re-gate value cannot resurrect the row", () => {
  // ISS-5280's migration destroyed the stored preference on installs that ran
  // it; an install upgrading straight past that build still carries the raw key.
  // Either way the one-shot residue clear must land it on the new OFF default,
  // so a stale `true` can never draw the row behind the operator's back.
  const store = makeFeatureFlagStore({ "agent-collaboration-network": true });
  assert.equal(
    store.getFlag(DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY),
    false,
    "a stale persisted opt-in must be cleared to the new default"
  );
});

test("an opt-in made after the re-gate survives a relaunch", () => {
  // REGRESSION GUARD for the trap this change had to defuse: ISS-5280's cleanup
  // deleted this key on every boot. Leaving that unconditional while
  // re-registering the toggle would wipe the user's opt-in on each restart and
  // make the Labs toggle silently unusable. Fails without the one-shot marker.
  const dir = makeFeatureFlagStoreDir({ "agent-collaboration-network": true });
  const first = openFeatureFlagStore(dir);
  assert.equal(
    first.getFlag(DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY),
    false,
    "the stale value is cleared on the first launch after the re-gate"
  );

  first.setFlag(DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY, true);

  const relaunched = openFeatureFlagStore(dir);
  assert.equal(
    relaunched.getFlag(DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY),
    true,
    "the deliberate opt-in must persist across a restart"
  );
});

// --- FEA-4132: pack-extended-content-kinds graduated out of Labs ---

test("registry no longer defines the graduated pack-extended-content-kinds flag", () => {
  // FEA-4132 graduated Extended Pack Contents to always-on: the extended kinds
  // (`plugin`, `tool`) render for everyone on the Packs Contents tab and card
  // summaries (the packs surfaces no longer gate on the flag), so the Labs
  // toggle and its registry entry were removed. Guard that the key stays gone.
  const def = FEATURE_FLAGS.find(
    (f) => f.key === "pack-extended-content-kinds"
  );
  assert.equal(
    def,
    undefined,
    "pack-extended-content-kinds was graduated out of Labs and must not be registered"
  );
});

// --- FEA-3993: sessions-codex-runtime-metadata graduated out of Labs ---

test("registry no longer defines the graduated sessions-codex-runtime-metadata flag", () => {
  // FEA-3993 graduated the Codex Runtime Metadata feature out of Labs: the rows
  // now render for everyone (self-gating on presence), so the Labs toggle and
  // its registry entry were removed. Guard that the key stays gone.
  const def = FEATURE_FLAGS.find(
    (f) => f.key === "sessions-codex-runtime-metadata"
  );
  assert.equal(
    def,
    undefined,
    "sessions-codex-runtime-metadata was graduated out of Labs and must not be registered"
  );
});

test("constructor deletes a legacy persisted sessions-codex-runtime-metadata value", () => {
  // FEA-3993: dropping the registry entry alone leaves an install that had the
  // Labs toggle persisted still carrying the key, and electron-store spreads
  // raw persisted data through getAll() into the IPC response. The retired-key
  // migration must delete it so the graduated flag leaves no residue.
  const store = makeFeatureFlagStore({
    "sessions-codex-runtime-metadata": true,
  });
  assert.equal(
    "sessions-codex-runtime-metadata" in
      (store.getAll() as unknown as Record<string, unknown>),
    false,
    "the graduated Labs key must be removed from the persisted store"
  );
});

// --- FEA-3994: agents (Agents Workspace) graduated out of Labs ---

test("registry no longer defines the graduated agents flag", () => {
  // FEA-3994 graduated the Agents Workspace out of Labs: it renders for everyone
  // (always-on) on every surface, so the Labs toggle and its registry entry were
  // removed. Guard that the key stays gone.
  const def = FEATURE_FLAGS.find((f) => f.key === "agents");
  assert.equal(
    def,
    undefined,
    "agents was graduated out of Labs and must not be registered"
  );
});

test("constructor deletes a legacy persisted agents value", () => {
  // FEA-3994: dropping the registry entry alone leaves an install that had the
  // Labs toggle persisted still carrying the key, and electron-store spreads
  // raw persisted data through getAll() into the IPC response. The retired-key
  // migration must delete it so the graduated flag leaves no residue.
  const store = makeFeatureFlagStore({ agents: true });
  assert.equal(
    "agents" in (store.getAll() as unknown as Record<string, unknown>),
    false,
    "the graduated Labs key must be removed from the persisted store"
  );
});

// --- FEA-3999 (PRD-532): unified-auth-onboarding graduated to always-on ---

test("registry no longer defines the graduated unified-auth-onboarding flag", () => {
  const def = FEATURE_FLAGS.find((f) => f.key === "unified-auth-onboarding");
  assert.equal(
    def,
    undefined,
    "unified-auth-onboarding must be removed from the registry once graduated"
  );
});

test("constructor deletes a legacy persisted unified-auth-onboarding value", () => {
  // FEA-3999: dropping the registry entry alone leaves an install that had the
  // Labs toggle persisted still carrying the key, and electron-store spreads
  // raw persisted data through getAll() into the IPC response. The retired-key
  // migration must delete it so the graduated flag leaves no residue.
  const store = makeFeatureFlagStore({ "unified-auth-onboarding": true });
  assert.equal(
    "unified-auth-onboarding" in
      (store.getAll() as unknown as Record<string, unknown>),
    false,
    "the graduated unified-auth-onboarding key must be removed from the persisted store"
  );
});

// --- FEA-3843 / PRD-555: docsHelp Labs flag ---

test("registry defines docsHelp as an off-by-default, visible Labs toggle", () => {
  const def = FEATURE_FLAGS.find((f) => f.key === "docsHelp");
  assert.ok(def, "docsHelp must be registered");
  assert.equal(def.default, false, "must default to OFF (dark launch)");
  assert.equal(def.category, "Labs", "must be a Labs-category toggle");
  // Not hidden from Labs → the SettingsPanel LabsTab renders it as a user-facing
  // opt-in toggle so the in-app Docs & Help experience can be dogfooded before
  // graduating. M1 ships only the bundle + index + IPC; the flag gates the
  // renderer surfaces that land in M2–M4.
  assert.notEqual(
    def.hiddenFromLabs,
    true,
    "must be visible in the Labs settings panel"
  );
});

test("docsHelp getFlag defaults OFF and can be toggled on", () => {
  const store = makeFeatureFlagStore();
  assert.equal(store.getFlag("docsHelp" as FlagKey), false);
  store.setFlag("docsHelp" as FlagKey, true);
  assert.equal(store.getFlag("docsHelp" as FlagKey), true);
});

// --- FEA-4174 / PRD-545: valueNumeratorV2 Labs flag ---

test("registry defines valueNumeratorV2 as an off-by-default, hidden Labs flag", () => {
  const def = FEATURE_FLAGS.find(
    (f) => f.key === DESKTOP_VALUE_NUMERATOR_V2_FEATURE_FLAG_KEY
  );
  assert.ok(def, "valueNumeratorV2 must be registered");
  assert.equal(def.default, false, "must default to OFF (dark launch)");
  assert.equal(def.category, "Labs", "must be a Labs-category toggle");
  assert.equal(def.label, "Value Numerator 2.0");
  // Hidden from Labs until a renderer consumer wires the flag: this slice lands
  // only the server-side Pensero client, so the LabsTab must NOT render a switch
  // that only persists a boolean nothing reads. The toggle is un-hidden by the
  // slice that wires the first gated consumer.
  assert.equal(
    def.hiddenFromLabs,
    true,
    "must stay hidden from the Labs settings panel until a consumer lands"
  );
});

test("valueNumeratorV2 getFlag defaults OFF and can be toggled on", () => {
  const store = makeFeatureFlagStore();
  assert.equal(
    store.getFlag(DESKTOP_VALUE_NUMERATOR_V2_FEATURE_FLAG_KEY as FlagKey),
    false
  );
  store.setFlag(DESKTOP_VALUE_NUMERATOR_V2_FEATURE_FLAG_KEY as FlagKey, true);
  assert.equal(
    store.getFlag(DESKTOP_VALUE_NUMERATOR_V2_FEATURE_FLAG_KEY as FlagKey),
    true
  );
});

// --- ISS-4792 (ISS-4779 closed-by-default): db-ahead-banner + timeline-axis ---

test("registry defines db-ahead-banner as an off-by-default, visible Labs toggle (ISS-4792)", () => {
  const def = FEATURE_FLAGS.find((f) => f.key === "db-ahead-banner");
  assert.ok(def, "db-ahead-banner must be registered");
  assert.equal(def.default, false, "must default to OFF (dark launch)");
  assert.equal(def.category, "Labs", "must be a Labs-category toggle");
  // Desktop-only surface, so the generic Labs toggle is the sole opt-in — it
  // must NOT be hidden from the Labs panel.
  assert.notEqual(
    def.hiddenFromLabs,
    true,
    "must be visible in the Labs settings panel"
  );
});

test("db-ahead-banner getFlag defaults OFF and can be toggled on", () => {
  const store = makeFeatureFlagStore();
  assert.equal(store.getFlag("db-ahead-banner" as FlagKey), false);
  store.setFlag("db-ahead-banner" as FlagKey, true);
  assert.equal(store.getFlag("db-ahead-banner" as FlagKey), true);
});

// --- ISS-4715: ordered startup-readiness experience ---

test("registry defines startup readiness as an off-by-default, restart-scoped Labs toggle", () => {
  const def = FEATURE_FLAGS.find(
    (flag) => flag.key === DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY
  );
  assert.ok(def, "startup readiness must be registered");
  assert.equal(def.default, false, "must default to OFF (dark launch)");
  assert.equal(def.category, "Labs");
  assert.equal(def.requiresRestart, true);
  assert.equal(def.envOverride, "SYMPHONY_STARTUP_READINESS_EXPERIENCE");
  assert.notEqual(def.hiddenFromLabs, true);
});

test("startup readiness getFlag defaults OFF and can be toggled on", () => {
  const store = makeFeatureFlagStore();
  assert.equal(
    store.getFlag(
      DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY as FlagKey
    ),
    false
  );
  store.setFlag(
    DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY as FlagKey,
    true
  );
  assert.equal(
    store.getFlag(
      DESKTOP_STARTUP_READINESS_EXPERIENCE_FEATURE_FLAG_KEY as FlagKey
    ),
    true
  );
});
test("registry defines localSessionAuthoredPrGate as an off-by-default, visible Labs toggle (ISS-4922)", () => {
  const def = FEATURE_FLAGS.find(
    (f) => f.key === DESKTOP_LOCAL_SESSION_AUTHORED_PR_GATE_FEATURE_FLAG_KEY
  );
  assert.ok(def, "localSessionAuthoredPrGate must be registered");
  assert.equal(
    def.default,
    false,
    "must default to OFF — suppressing an already-rendered Local PR pill is user-perceivable"
  );
  assert.equal(def.category, "Labs", "must be a Labs-category toggle");
  // Desktop-only surface (the cloud lane enforces the rule unconditionally), so
  // the generic Labs toggle is the sole opt-in and must stay visible.
  assert.notEqual(
    def.hiddenFromLabs,
    true,
    "must be visible in the Labs settings panel"
  );
});

test("localSessionAuthoredPrGate getFlag defaults OFF and can be toggled on", () => {
  const store = makeFeatureFlagStore();
  assert.equal(
    store.getFlag(
      DESKTOP_LOCAL_SESSION_AUTHORED_PR_GATE_FEATURE_FLAG_KEY as FlagKey
    ),
    false
  );
  store.setFlag(
    DESKTOP_LOCAL_SESSION_AUTHORED_PR_GATE_FEATURE_FLAG_KEY as FlagKey,
    true
  );
  assert.equal(
    store.getFlag(
      DESKTOP_LOCAL_SESSION_AUTHORED_PR_GATE_FEATURE_FLAG_KEY as FlagKey
    ),
    true
  );
});

// --- FEA-4004: branches-hide-cruft removed entirely ---

test("registry no longer defines the removed branches-hide-cruft flag", () => {
  // FEA-4004 removed the "Hide Merged & Agent Branches" default-hide entirely
  // (merged/agent/bot branches always show now), so its Labs toggle and registry
  // entry were dropped. Guard that the key stays gone.
  const def = FEATURE_FLAGS.find((f) => f.key === "branches-hide-cruft");
  assert.equal(
    def,
    undefined,
    "branches-hide-cruft was removed and must not be registered"
  );
});

// --- FEA-3266 / FEA-4000: aiImpactCardEnabled graduated out of Labs ---

test("registry no longer defines the graduated aiImpactCardEnabled flag", () => {
  // FEA-4000 graduated the AI Impact card out of Labs: it renders for everyone
  // on both surfaces (the hosts no longer gate on the flag), so the Labs toggle
  // and its registry entry were removed. Guard that the key stays gone.
  const def = FEATURE_FLAGS.find((f) => f.key === "aiImpactCardEnabled");
  assert.equal(
    def,
    undefined,
    "aiImpactCardEnabled was graduated out of Labs and must not be registered"
  );
});

test("constructor deletes a legacy persisted aiImpactCardEnabled value", () => {
  // FEA-4000: dropping the registry entry alone leaves an install that had the
  // Labs toggle persisted still carrying the key, and electron-store spreads
  // raw persisted data through getAll() into the IPC response. The retired-key
  // migration must delete it so the graduated flag leaves no residue.
  const store = makeFeatureFlagStore({ aiImpactCardEnabled: true });
  assert.equal(
    "aiImpactCardEnabled" in
      (store.getAll() as unknown as Record<string, unknown>),
    false,
    "the graduated Labs key must be removed from the persisted store"
  );
});

test("getFlag returns registry default when key is absent from store", () => {
  const store = makeFeatureFlagStore();
  assert.equal(
    store.getFlag("cloudConnectionEnabled"),
    true,
    "cloudConnectionEnabled defaults to true"
  );
  assert.equal(
    store.getFlag("planExtractionEnabled"),
    false,
    "planExtractionEnabled defaults to false"
  );
});

test("getFlag returns stored value when present", () => {
  const store = makeFeatureFlagStore({ cloudConnectionEnabled: false });
  assert.equal(store.getFlag("cloudConnectionEnabled"), false);
});

test("getFlag respects env override when envOverride is set", () => {
  const store = makeFeatureFlagStore();
  // Direct test via a flag that has envOverride — we'll use cloudConnectionEnabled
  // and temporarily set an env var. Since no flags have envOverride in v1,
  // we test the env path by monkey-patching.
  assert.equal(store.getFlag("cloudConnectionEnabled"), true);
});

// --- setFlag ---

test("setFlag persists and getFlag returns the new value", () => {
  const store = makeFeatureFlagStore();
  store.setFlag("planExtractionEnabled", true);
  assert.equal(store.getFlag("planExtractionEnabled"), true);
});

test("setFlag rejects unknown flag keys", () => {
  const store = makeFeatureFlagStore();
  assert.throws(() => store.setFlag("nonExistent" as FlagKey, true), {
    message: /Unknown feature flag/,
  });
});

// --- getFlagSource ---

test("getFlagSource reports 'default' when key is absent", () => {
  const store = makeFeatureFlagStore();
  assert.equal(store.getFlagSource("cloudConnectionEnabled"), "default");
});

test("getFlagSource reports 'user' when key is persisted", () => {
  const store = makeFeatureFlagStore({ cloudConnectionEnabled: true });
  assert.equal(store.getFlagSource("cloudConnectionEnabled"), "user");
});

// --- getAllFlags ---

test("getAllFlags returns entries for every registered flag", () => {
  const store = makeFeatureFlagStore();
  const flags = store.getAllFlags();
  assert.equal(flags.length, FEATURE_FLAGS.length);
  for (const def of FEATURE_FLAGS) {
    const entry = flags.find((f) => f.key === def.key);
    assert.ok(entry, `missing flag: ${def.key}`);
    assert.equal(entry.value, def.default, `default mismatch for ${def.key}`);
    assert.equal(
      entry.source,
      "default",
      `source should be default for ${def.key}`
    );
  }
});

// --- update() ---

test("update(partial) accepts any registered flag key", () => {
  const store = makeFeatureFlagStore();
  const updated = store.update({ planExtractionEnabled: true });
  assert.equal(updated.planExtractionEnabled, true);
  assert.equal(store.getFlag("planExtractionEnabled"), true);
});

// --- Legacy wrapper compatibility ---

test("legacy getters return same values as getFlag", () => {
  const store = makeFeatureFlagStore({
    cloudCommandsPaused: true,
  });
  assert.equal(
    store.getCloudCommandsPaused(),
    store.getFlag("cloudCommandsPaused")
  );
  assert.equal(
    store.getCommandSigningEnforcementEnabled(),
    store.getFlag("commandSigningEnforcementEnabled")
  );
});

test("constructor removes stale design-system dashboard opt-in flag", () => {
  const store = makeFeatureFlagStore({
    agentDashboardDesignSystemEnabled: true,
  });
  assert.equal(
    "agentDashboardDesignSystemEnabled" in
      (store.getAll() as unknown as Record<string, unknown>),
    false
  );
  assert.equal(
    FEATURE_FLAGS.some(
      (def) => def.key === "agentDashboardDesignSystemEnabled"
    ),
    false
  );
});

// FEA-2503: the Agent Dashboard toggle has been removed and the dashboard is
// always on. The flag must no longer be registered, and any legacy stored
// `false` (a user who had turned it off) must be neutralized so it can never
// hide the dashboard.
test("agentMonitorEnabled is no longer a registered feature flag", () => {
  assert.equal(
    FEATURE_FLAGS.some((def) => def.key === "agentMonitorEnabled"),
    false
  );
});

test("constructor deletes a legacy persisted agentMonitorEnabled=false", () => {
  const store = makeFeatureFlagStore({ agentMonitorEnabled: false });
  assert.equal(
    "agentMonitorEnabled" in
      (store.getAll() as unknown as Record<string, unknown>),
    false,
    "legacy off value must be removed so it cannot hide the dashboard"
  );
});

test("legacy setters persist through getFlag", () => {
  const store = makeFeatureFlagStore();
  store.setPlanExtractionEnabled(true);
  assert.equal(store.getFlag("planExtractionEnabled"), true);
});

test("registry defines commandSigningEnforcementEnabled as an off-by-default Security opt-in hidden from Labs (FEA-4130)", () => {
  const def = FEATURE_FLAGS.find(
    (f) => f.key === "commandSigningEnforcementEnabled"
  );
  assert.ok(def, "commandSigningEnforcementEnabled must be registered");
  assert.equal(
    def.default,
    false,
    "must default OFF — Trusted Browser Enforcement is opt-in"
  );
  // FEA-4130: rendered on the Security tab beside the other security controls
  // by its "Security" category.
  assert.equal(def.category, "Security");
  assert.equal(def.label, "Trusted Browser Enforcement");
  // FEA-4130: no longer rendered by the generic Labs list — the Security tab
  // owns a dedicated card for it, so it is hidden from Labs to avoid a
  // double-render whose two switches would desync.
  assert.ok(
    def.hiddenFromLabs,
    "must be hidden from the Labs panel — the Security tab owns its toggle"
  );
});

// --- PRD-532 §7: syncObservabilityTier setting ---

test("getSyncObservabilityTier defaults to null (nothing syncs until consent)", () => {
  const store = makeFeatureFlagStore();
  assert.equal(store.getSyncObservabilityTier(), null);
});

test("setSyncObservabilityTier persists the chosen tier", () => {
  const store = makeFeatureFlagStore();
  store.setSyncObservabilityTier("metadata");
  assert.equal(store.getSyncObservabilityTier(), "metadata");
  store.setSyncObservabilityTier("local");
  assert.equal(store.getSyncObservabilityTier(), "local");
});

test("getSyncObservabilityTier reads a persisted value from the store", () => {
  const store = makeFeatureFlagStore({ syncObservabilityTier: "full" });
  assert.equal(store.getSyncObservabilityTier(), "full");
});

// PRD-532 §7 consent predicates — the tier→lane mapping the sync services honor.
// Fix-forward for the #2985 P1: the setting must actually gate cloud sync.

test("syncTierAllowsSessionMetadata: only full/metadata may sync aggregates", () => {
  assert.equal(syncTierAllowsSessionMetadata("full"), true);
  assert.equal(syncTierAllowsSessionMetadata("metadata"), true);
  assert.equal(syncTierAllowsSessionMetadata("local"), false);
  assert.equal(
    syncTierAllowsSessionMetadata(null),
    false,
    "not-yet-consented (null) must not sync"
  );
});

test("syncTierAllowsTranscripts: only full may sync session contents", () => {
  assert.equal(syncTierAllowsTranscripts("full"), true);
  assert.equal(
    syncTierAllowsTranscripts("metadata"),
    false,
    "metadata keeps prompts/turns/contents local"
  );
  assert.equal(syncTierAllowsTranscripts("local"), false);
  assert.equal(syncTierAllowsTranscripts(null), false);
});

// --- FEA-3741 (slice 1): per-tool collector enable toggles ---

const COLLECTOR_FLAG_KEYS = [
  "collectClaudeEnabled",
  "collectCursorEnabled",
  "collectCopilotEnabled",
] as const;

test("FEA-3741: each per-tool collector flag is a Data-Collection, ON-by-default, hidden-from-Labs toggle", () => {
  for (const key of COLLECTOR_FLAG_KEYS) {
    const def = FEATURE_FLAGS.find((f) => f.key === key);
    assert.ok(def, `${key} must be registered`);
    assert.equal(def.default, true, `${key} must default to ON`);
    assert.equal(
      def.category,
      "Data Collection",
      `${key} must be a Data Collection toggle`
    );
    // Rendered by the dedicated CLI Tools "Data Collection" card, not the
    // generic Labs list — so it must be hidden from Labs to avoid a duplicate,
    // desyncing control.
    assert.equal(
      def.hiddenFromLabs,
      true,
      `${key} must be hidden from the Labs panel`
    );
    assert.equal(
      def.requiresRestart,
      true,
      `${key} takes effect at collector (re)start`
    );
  }
});

test("FEA-3741: collector flags round-trip through getFlag/setFlag and default ON", () => {
  const store = makeFeatureFlagStore();
  for (const key of COLLECTOR_FLAG_KEYS) {
    assert.equal(
      store.getFlag(key),
      true,
      `${key} defaults to ON (unchanged always-on posture)`
    );
    store.setFlag(key, false);
    assert.equal(store.getFlag(key), false, `${key} persists an OFF value`);
  }
});

test("FEA-3741: getCollectorEnabledState reflects the persisted per-tool flags", () => {
  const store = makeFeatureFlagStore();
  // Default: every tool enabled.
  assert.deepEqual(store.getCollectorEnabledState(), {
    claude: true,
    cursor: true,
    copilot: true,
  });
  // A single toggle off is reflected; the others stay on.
  store.setFlag("collectCursorEnabled", false);
  assert.deepEqual(store.getCollectorEnabledState(), {
    claude: true,
    cursor: false,
    copilot: true,
  });
});

// --- ISS-6241 (ISS-4779 closed-by-default): Import splash compute count ---

test("registry defines compute-progress-count as an off-by-default, visible Labs toggle (ISS-6241)", () => {
  const def = FEATURE_FLAGS.find(
    (flag) => flag.key === DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY
  );
  assert.ok(def, "compute-progress-count must be registered");
  assert.equal(def.default, false, "must default to OFF (dark launch)");
  assert.equal(def.category, "Labs", "must be a Labs-category toggle");
  // Desktop-only surface, so this toggle is the only way to reach the count —
  // hidden would make the gate unopenable rather than merely closed.
  assert.notEqual(
    def.hiddenFromLabs,
    true,
    "must be visible in the Labs settings panel"
  );
  // The defaults record is the OTHER half of the gate: a key registered but
  // missing there would read as `undefined` through getFlag, not `false`.
  assert.equal(
    DEFAULT_DESKTOP_SETTINGS[DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY],
    false
  );
});

test("ISS-6241: compute-progress-count round-trips through the settings store", () => {
  const store = makeFeatureFlagStore();
  assert.equal(
    store.getFlag(DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY),
    false
  );
  store.setFlag(DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY, true);
  assert.equal(
    store.getFlag(DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY),
    true
  );
});

// --- ISS-5841 (ISS-4779 closed-by-default): Session detail activity phases ---

test("registry defines session-activity-phases as an off-by-default, visible Labs toggle (ISS-5841)", () => {
  const def = FEATURE_FLAGS.find(
    (flag) => flag.key === DESKTOP_SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY
  );
  assert.ok(def, "session-activity-phases must be registered");
  assert.equal(def.default, false, "must default to OFF (dark launch)");
  assert.equal(def.category, "Labs", "must be a Labs-category toggle");
  // The packaged renderer has no PostHog wiring, so this Labs toggle is the
  // only way to reach the phases surfaces on desktop — it must not be hidden
  // from the panel, or the gate would be unopenable rather than merely closed.
  assert.notEqual(
    def.hiddenFromLabs,
    true,
    "must be visible in the Labs settings panel"
  );
});

test("ISS-5841: session-activity-phases getFlag defaults OFF and can be toggled on", () => {
  const store = makeFeatureFlagStore();
  assert.equal(
    store.getFlag(DESKTOP_SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY),
    false
  );
  store.setFlag(DESKTOP_SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY, true);
  assert.equal(
    store.getFlag(DESKTOP_SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY),
    true
  );
});

test("ISS-4779: show-Redacted-sync-level is a registered Labs flag that dark-launches OFF", () => {
  // `data-sync-redacted-labs-gate.spec.ts` seeds this key as a literal
  // (importing the registry from a Playwright spec aborts the Electron run), so
  // this pins the exact string and default the spec depends on against a rename.
  // It also guards the merge hazard that dropped this entry once: the key stayed
  // declared while its FEATURE_FLAGS registration was lost, leaving the gate
  // resolving to the build-type default instead of the persisted Labs value.
  const definition = getFlagDefinition(
    DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY
  );
  assert.equal(
    DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY,
    "showRedactedSyncLevel"
  );
  assert.equal(definition.default, false);
  assert.equal(definition.category, "Labs");
  // Reachable in the registry-driven Labs panel so a user can opt in.
  assert.notEqual(definition.hiddenFromLabs, true);
  assert.equal(
    DEFAULT_DESKTOP_SETTINGS[DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY],
    false
  );
});
