/**
 * @file desktop-sync-lane-deps.test.ts
 * @description ISS-8768 — pins `buildDesktopSyncLaneDeps`, the wiring lifted out
 * of `app.ts`. The property that matters is LIVENESS: the inline
 * `() => this.x.y()` arrows it replaces resolved on every tick, so a builder
 * that snapshotted a port's answer at construction would compile, pass a
 * happy-path shape check, and permanently freeze consent, identity, and
 * capability state at boot. Every case below therefore flips a port's answer
 * AFTER the deps are built and asserts the change is observed.
 */
import assert from "node:assert/strict";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { afterEach, test, vi } from "vitest";
import type { AgentSessionSyncCapabilities } from "../src/main/agent-sync/agent-session-sync-capabilities.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { laneDeliveryConsented } from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import type { DesktopSyncLaneDepsParams } from "../src/main/agent-sync/desktop-sync-lane-deps.js";
import { buildDesktopSyncLaneDeps } from "../src/main/agent-sync/desktop-sync-lane-deps.js";
import { SyncObservabilityTier } from "../src/shared/contracts.js";
import { SyncLaneId } from "../src/shared/sync-burndown-contract.js";
import type { SyncConsentRecord } from "../src/shared/sync-consent.js";
import { fakeDesktopSyncLaneDeps } from "./fake-desktop-sync-lane-deps.js";

const NO_CAPABILITIES: AgentSessionSyncCapabilities = {
  compression: false,
  activityChunking: false,
  prRefChunking: false,
  monitoredActivity: false,
  spanExtent: false,
  humanTurnTimestamps: false,
  agentTurnTimestamps: false,
  tokenEventOwner: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A mutable stand-in for the app's own fields. Every port reads `state` at call
 * time, so a test mutates `state` after building to prove the deps did not
 * snapshot it.
 */
function mutableParams() {
  const state = {
    apiOrigin: "https://api.example.test",
    tierWasSet: false,
    httpReady: false,
    computeTargetId: null as string | null,
    organizationId: "org-a",
    consentRecord: {
      tier: null,
      organizationId: null,
      bound: false,
    } as SyncConsentRecord,
    metadataAllowed: false,
    capabilities: NO_CAPABILITIES,
    dashboardRuntime: null as {
      syncSource: AgentSessionSyncSource | null;
      isInitialSessionProjectionReady(): boolean;
    } | null,
    transcriptSync: null as { isRunning(): boolean } | null,
  };
  const params: DesktopSyncLaneDepsParams = {
    desktopSessionManager: {
      getAccessToken: () => Promise.resolve(null),
      getAccountAdmission: () => null,
      getIdentity: () => ({
        organizationId: state.organizationId,
        userId: "user-a",
      }),
      invalidateAccessToken: () => undefined,
    },
    settings: {
      getApiOrigin: () => state.apiOrigin,
      hasSyncObservabilityTierBeenSet: () => state.tierWasSet,
      getDataSyncLevel: () => DataSyncLevel.Full,
      getSyncConsentRecord: () => state.consentRecord,
    },
    sessionSyncIdentity: {
      computeTargetId: () => state.computeTargetId,
      lastLiveTargetRefusal: () => null,
      isHttpReady: () => state.httpReady,
    },
    syncEgressGate: {
      sessionMetadataAllowed: () => state.metadataAllowed,
    },
    rendererGates: { waitForRendererBackgroundSlot: () => Promise.resolve() },
    appOtelRuntime: fakeDesktopSyncLaneDeps().appOtelRuntime,
    getApiKey: () => null,
    getServerCapabilities: () => state.capabilities,
    getTranscriptComputeTargetId: () => null,
    getDashboardRuntime: () => state.dashboardRuntime,
    getTranscriptSync: () => state.transcriptSync,
  };
  return { params, state };
}

test("every dep resolves at call time, never snapshotted at construction", () => {
  const { params, state } = mutableParams();
  const deps = buildDesktopSyncLaneDeps(params);

  assert.equal(deps.isSessionMetadataSyncTierAllowed(), false);
  assert.equal(deps.isSyncCompressionSupported(), false);
  assert.equal(deps.isTranscriptSyncRunning(), false);
  assert.equal(deps.getApiOrigin(), "https://api.example.test");

  state.metadataAllowed = true;
  state.capabilities = { ...NO_CAPABILITIES, compression: true };
  state.transcriptSync = { isRunning: () => true };
  state.apiOrigin = "https://other.example.test";

  assert.equal(
    deps.isSessionMetadataSyncTierAllowed(),
    true,
    "consent is re-read per tick, not frozen at boot"
  );
  assert.equal(
    deps.isSyncCompressionSupported(),
    true,
    "capabilities are renegotiated per hello ack and must be re-read"
  );
  assert.equal(
    deps.isTranscriptSyncRunning(),
    true,
    "the transcript lane is constructed lazily and must be re-read"
  );
  assert.equal(deps.getApiOrigin(), "https://other.example.test");
});

test("ISS-8768: tier-was-set is wired to key presence, not to the egress gate", () => {
  const { params, state } = mutableParams();
  const deps = buildDesktopSyncLaneDeps(params);

  // The two axes are deliberately independent: a device may have recorded an
  // explicit refusal (key present) while egress is correctly denied. Crossing
  // the wires reads identically on a consenting machine and inverts the
  // detector on the never-onboarded one ISS-8768 exists to catch.
  state.tierWasSet = true;
  state.metadataAllowed = false;

  assert.equal(deps.hasSyncObservabilityTierBeenSet(), true);
  assert.equal(deps.isSessionMetadataSyncTierAllowed(), false);
});

test("the dashboard runtime drives the sync source and initial projection readiness", () => {
  const { params, state } = mutableParams();
  const deps = buildDesktopSyncLaneDeps(params);

  assert.equal(deps.getSyncSource(), null, "no runtime yet");
  assert.equal(deps.isInitialSessionProjectionReady(), false);

  const syncSource = {} as AgentSessionSyncSource;
  let projectionReady = false;
  state.dashboardRuntime = {
    syncSource,
    isInitialSessionProjectionReady: () => projectionReady,
  };

  assert.equal(deps.getSyncSource(), syncSource);
  assert.equal(
    deps.isInitialSessionProjectionReady(),
    false,
    "session upload remains closed while initial maintenance is active"
  );
  projectionReady = true;
  assert.equal(
    deps.isInitialSessionProjectionReady(),
    true,
    "the live runtime signal opens the session projection gate after maintenance settles"
  );
});

test("all upload lanes wait for a live explicit choice covering the current organization", () => {
  const { params, state } = mutableParams();
  const deps = buildDesktopSyncLaneDeps(params);
  state.httpReady = true;
  assert.equal(deps.isHttpAgentSessionSyncReady(), false);
  state.consentRecord = {
    tier: SyncObservabilityTier.Full,
    organizationId: "org-a",
    bound: true,
  };
  assert.equal(deps.isHttpAgentSessionSyncReady(), true);
  state.organizationId = "org-b";
  assert.equal(deps.isHttpAgentSessionSyncReady(), false);
  state.consentRecord = {
    tier: SyncObservabilityTier.Metadata,
    organizationId: null,
    bound: false,
  };
  assert.equal(
    deps.isHttpAgentSessionSyncReady(),
    true,
    "honor an explicit legacy answer without an organization binding"
  );
  state.consentRecord = { ...state.consentRecord, tier: null };
  assert.equal(
    deps.isHttpAgentSessionSyncReady(),
    false,
    "observe revocation after construction"
  );
});

test("inventory diagnostics distinguish a policy hold from a transport outage", () => {
  const { params, state } = mutableParams();
  const deps = buildDesktopSyncLaneDeps(params);
  const consented = () =>
    laneDeliveryConsented(SyncLaneId.ComponentInventory, deps);
  state.httpReady = true;
  assert.equal(consented(), false);
  assert.equal(deps.isHttpAgentSessionSyncReady(), false);
  state.consentRecord = {
    tier: SyncObservabilityTier.Local,
    organizationId: "org-a",
    bound: true,
  };
  assert.equal(consented(), true);
  assert.equal(deps.isHttpAgentSessionSyncReady(), true);
  state.httpReady = false;
  assert.equal(consented(), true, "offline does not revoke a saved choice");
  assert.equal(deps.isHttpAgentSessionSyncReady(), false);
  state.organizationId = "org-b";
  assert.equal(consented(), false, "a different workspace has no saved choice");
  state.organizationId = "org-a";
  state.consentRecord = { ...state.consentRecord, tier: null };
  assert.equal(
    consented(),
    false,
    "a removed choice closes diagnostic consent"
  );
});
