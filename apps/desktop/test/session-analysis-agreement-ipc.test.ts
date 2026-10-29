/**
 * ISS-10890 — Welcome's Start releases the ISS-10950 boot gate on a fresh
 * install.
 *
 * The operator ruled (2026-09-24) that pressing "Start Analyzing My Sessions"
 * is this device's agreement to local analysis. Once the sync-policy step moved
 * behind the organization step, a fresh install reached Session discovery with
 * the boot import still held for a sync answer it had not been asked for, so
 * discovery never started and its Continue stayed disabled.
 *
 * Driven through the whole main-side chain in one pass: the preload method →
 * the REAL registered onboarding handler → a REAL `SettingsStore` that ran its
 * own first-launch seed (ISS-10554's explicit `null` tier) → the REAL composed
 * gate the boot path parks on. The doubles are the IPC transport and the
 * collector runtime. `onboarding-ipc.ts` imports `shell` from `electron` at
 * module scope, hence the electron-module mock.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import type { DesktopOnboardingState } from "../src/main/onboarding/onboarding-state.js";
import { createSessionAnalysisConsentGate } from "../src/main/onboarding/session-analysis-consent-gate.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import type { ApiKeyStore } from "../src/main/settings/api-key-store.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import { OnboardingIpcChannel } from "../src/shared/onboarding-ipc-channel.js";
import { hasRecordedSyncConsent } from "../src/shared/sync-consent.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";

const TRUSTED_SENDER = { id: "trusted-renderer" };
const UNTRUSTED_SENDER = { id: "secondary-renderer" };
const ORG = "org_acme";
const OTHER_ORG = "org_globex";

type OnboardingIpcModule = typeof import("../src/main/ipc/onboarding-ipc.js");
type IpcInvokeListener = (event: unknown, ...args: unknown[]) => unknown;

describe("the Welcome Start analysis agreement", () => {
  let electronMock: ElectronModuleMock;
  let onboardingIpc: OnboardingIpcModule;
  const storeDirs: string[] = [];

  beforeAll(async () => {
    electronMock = registerElectronModuleMock();
    onboardingIpc = await import("../src/main/ipc/onboarding-ipc.js");
  });

  afterAll(() => {
    electronMock.deregister();
  });

  afterEach(() => {
    for (const dir of storeDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function freshStoreDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "iss-10890-analysis-agreement-"));
    storeDirs.push(dir);
    return dir;
  }

  /** One app launch over `storeDir`: its store, its parked boot import, its IPC. */
  function launch(storeDir: string) {
    const settingsStore = new SettingsStore({ cwd: storeDir });
    let starts = 0;
    let sessionOrganizationId: string | null = ORG;
    const gate = createSessionAnalysisConsentGate({
      isGoldenMode: () => false,
      isShuttingDown: () => false,
      logWarning: () => undefined,
      settings: () => settingsStore,
    });
    gate.startCollectorsWhenAgreed({
      startCollectors: () => {
        starts += 1;
      },
    });
    const handlers = new Map<string, IpcInvokeListener>();
    onboardingIpc.registerOnboardingIpcHandlers(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      {
        apiKeyStore: {} as ApiKeyStore,
        applyBinaryPathPatch: () => undefined,
        applyDataSyncLevel: (level) => settingsStore.setDataSyncLevel(level),
        cancelManagedOnboardingForUserChange: () => undefined,
        getOnboardingState: () => ({}) as DesktopOnboardingState,
        getSessionOrganizationId: () => sessionOrganizationId,
        isTrustedSender: (sender) => sender === TRUSTED_SENDER,
        // The composition root's wiring: app.ts hands this gate's reconcile.
        onSessionAnalysisAgreed: () => gate.reconcile(),
        persistActiveProfileKey: () => undefined,
        restartCloudSocket: () => undefined,
        settingsStore,
        startDeviceOnboarding: () =>
          Promise.resolve({ status: "approved" as const }),
        warmTelemetryOrgIdentity: () => undefined,
      }
    );
    const invoke = (sender: unknown, channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`no handler registered for ${channel}`);
      }
      return handler({ sender }, ...args);
    };
    const desktopApi = createDesktopApi({
      invoke: (channel: string, ...args: unknown[]) =>
        Promise.resolve(invoke(TRUSTED_SENDER, channel, ...args)),
      on: () => undefined,
      removeListener: () => undefined,
      send: () => undefined,
    });
    return {
      desktopApi,
      invoke,
      settingsStore,
      signInto: (organizationId: string) => {
        sessionOrganizationId = organizationId;
      },
      startsAfterFlush: async () => {
        // The gate's promise, then the continuation chained onto it.
        await Promise.resolve();
        await Promise.resolve();
        return starts;
      },
    };
  }

  it("starts a fresh install's parked boot import once Start is recorded", async () => {
    const app = launch(freshStoreDir());
    // ISS-10554's first-launch seed: the tier KEY written, the answer withheld.
    assert.equal(app.settingsStore.hasSyncObservabilityTierBeenSet(), true);
    assert.equal(app.settingsStore.getSyncObservabilityTier(), null);
    assert.equal(await app.startsAfterFlush(), 0);

    assert.deepEqual(await app.desktopApi.recordSessionAnalysisAgreement(), {
      ok: true,
    });

    assert.equal(await app.startsAfterFlush(), 1);
    assert.equal(app.settingsStore.getSessionAnalysisAgreed(), true);
    // Egress is untouched: the sync answer is still outstanding, so the
    // predicate every upload lane reads (desktop-sync-lane-deps) stays false.
    // Operator ruling (Marisol Ashgrove, 2026-10-20): the sync choice gates only
    // cloud synchronization, never local parsing.
    assert.equal(app.settingsStore.getSyncObservabilityTier(), null);
    assert.equal(
      hasRecordedSyncConsent(app.settingsStore.getSyncConsentRecord(), null),
      false
    );
  });

  it("releases the next launch's boot import without asking again", async () => {
    const storeDir = freshStoreDir();
    await launch(storeDir).desktopApi.recordSessionAnalysisAgreement();

    assert.equal(await launch(storeDir).startsAfterFlush(), 1);
  });

  it("refuses an untrusted sender and records nothing", async () => {
    const app = launch(freshStoreDir());

    assert.throws(() =>
      app.invoke(
        UNTRUSTED_SENDER,
        OnboardingIpcChannel.RecordSessionAnalysisAgreement
      )
    );

    assert.equal(app.settingsStore.getSessionAnalysisAgreed(), false);
    assert.equal(await app.startsAfterFlush(), 0);
  });

  // The sync answer is org-scoped and a sign-in into another org clears it
  // before rewriting; the local-reading agreement is the device's and survives.
  it("keeps the agreement through an organization rebind of the sync answer", async () => {
    const app = launch(freshStoreDir());
    await app.desktopApi.recordSessionAnalysisAgreement();
    await app.desktopApi.recordSyncConsent({
      level: DataSyncLevel.Full,
      organizationId: ORG,
    });

    app.signInto(OTHER_ORG);
    await app.desktopApi.recordSyncConsent({
      level: DataSyncLevel.Off,
      organizationId: OTHER_ORG,
    });

    assert.equal(app.settingsStore.getSyncConsentOrganizationId(), OTHER_ORG);
    assert.equal(app.settingsStore.getSessionAnalysisAgreed(), true);
  });
});
