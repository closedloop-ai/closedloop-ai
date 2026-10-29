/**
 * The main-process half of the ISS-12423 onboarding-analytics regression, as
 * `app.ts` composes it: the observability lane router fed by the session and
 * socket getters, `Observability` relaying to it, the surface-analytics IPC
 * handler relaying to `Observability`, and the sync-consent IPC's apply chain.
 * A socket restart or stop is modelled by its one effect on this lane: the
 * compute target is unknown until the next hello.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { vi } from "vitest";
import { z } from "zod";
import type { DesktopAnalyticsLaneEvent } from "../../../../main/cloud/desktop-analytics-http-lane";
import { createObservabilityLaneRouter } from "../../../../main/cloud/observability-lane-router";
import { registerSurfaceAnalyticsIpcHandlers } from "../../../../main/ipc/surface-analytics-ipc";
import { applySyncConsent } from "../../../../main/ipc/sync-consent-apply";
import { gatewayLog } from "../../../../main/logging/gateway-logger";
import { applyDataSyncLevel } from "../../../../main/settings/apply-data-sync-level";
import { setCloudConnectionEnabled } from "../../../../main/settings/set-cloud-connection-enabled";
import { Observability } from "../../../../main/telemetry/observability";
import type { SignedInUserIdentity } from "../../../../main/util/user-identity";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import type {
  SurfaceAnalyticsIpcPayload,
  SurfaceAnalyticsIpcResult,
} from "../../../../shared/surface-analytics-ipc-contract";
import {
  ORGANIZATION,
  USER_ID,
} from "./desktop-guided-onboarding-takeover-fixtures";

const API_ORIGIN = "https://api.example.test";
const TARGET_ID = "target-1";
const NODE_UUID = "4b3c6a1e-2f0d-4c8b-9e7a-5d1f0b2c3a4e";

const ipcResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type MainProcess = ReturnType<typeof composeMainProcess>;

export function composeMainProcess() {
  const state: {
    status: DesktopAuthStatus;
    identity: SignedInUserIdentity | null;
    ready: boolean;
    cloudConnectionEnabled: boolean;
    level: DataSyncLevel;
  } = {
    status: DesktopAuthStatus.Exchanging,
    identity: null,
    ready: false,
    cloudConnectionEnabled: true,
    level: DataSyncLevel.Metadata,
  };
  const consent: {
    saved: DataSyncLevel[];
    readyAfterSave: boolean[];
    restarts: number;
    stops: number;
    dropAfterSave: boolean;
  } = {
    saved: [],
    readyAfterSave: [],
    restarts: 0,
    stops: 0,
    dropAfterSave: false,
  };
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ success: true, data: { captured: true } }),
        { status: 200 }
      )
  );
  const log = vi.spyOn(gatewayLog, "info");
  const router = createObservabilityLaneRouter({
    fetch: fetcher,
    getAccessToken: async () => "token-1",
    getApiOrigin: () => API_ORIGIN,
    getPluginVersion: () => "plugin-1",
    getAppVersion: () => "0.17.482",
    getIdentity: () => state.identity,
    getAuthStatus: () => state.status,
    isHttpReady: () => state.ready,
    getComputeTargetId: () => (state.ready ? TARGET_ID : null),
    getRetainedComputeTargetId: () => TARGET_ID,
    getNodeUuid: () => NODE_UUID,
    isSinglePlayerInstall: () => false,
    isPreAuthSendEnabled: () => false,
    onUnauthorized() {},
  });
  const accepted: DesktopAnalyticsLaneEvent[] = [];
  Observability.init({
    telemetrySend: () => undefined,
    analytics: {
      send: (event) => {
        accepted.push(structuredClone(event));
        router.sendAnalytics(event);
      },
      flush: router.flushAnalytics,
    },
    deviceId: NODE_UUID,
  });
  let ipc: ((event: unknown, payload?: unknown) => unknown) | undefined;
  registerSurfaceAnalyticsIpcHandlers(
    {
      handle: (_channel, listener) => {
        ipc = listener;
      },
    },
    {
      isTrustedSender: () => true,
      captureAnalytics: (event, properties) =>
        Observability.rendererSurfaceAnalytics(event, properties),
    }
  );
  const side = {
    state,
    consent,
    router,
    fetcher,
    accepted,
    // Cloned, and settled on a later tick, as `ipcRenderer.invoke` delivers
    // it: a main-side throw reaches the renderer as a rejection.
    captureSurfaceAnalytics: (
      payload: SurfaceAnalyticsIpcPayload
    ): Promise<SurfaceAnalyticsIpcResult> =>
      invokeMain(() =>
        ipcResultSchema.parse(ipc?.({ sender: {} }, structuredClone(payload)))
      ),
    getDataSyncLevel: () => invokeMain(() => ({ level: state.level })),
    recordSyncConsent: (payload: {
      level: DataSyncLevel;
      organizationId: string | null;
    }) =>
      invokeMain(() => {
        const result = applySyncConsent(
          consentDeps(state, consent),
          structuredClone(payload)
        );
        consent.saved.push(result.level);
        consent.readyAfterSave.push(state.ready);
        if (consent.dropAfterSave) {
          consent.dropAfterSave = false;
          state.ready = false;
        }
        return result;
      }),
    authenticate() {
      state.status = DesktopAuthStatus.Authenticated;
      state.identity = { userId: USER_ID, organizationId: ORGANIZATION.id };
    },
    connectTarget() {
      state.ready = true;
    },
    dropTargetAfterNextConsentSave() {
      consent.dropAfterSave = true;
    },
    drops: () =>
      log.mock.calls
        .filter(([tag]) => tag === "onboarding_analytics")
        .map(([, message]) => JSON.parse(String(message)))
        .filter((record) => record.action === "event_dropped")
        .map((record) => [record.reason, record.step]),
  };
  return side;
}

function consentDeps(
  state: MainProcess["state"],
  consent: MainProcess["consent"]
): Parameters<typeof applySyncConsent>[0] {
  const markTargetUnknown = () => {
    state.ready = false;
  };
  return {
    getSyncObservabilityTier: () => null,
    getSyncConsentOrganizationId: () => ORGANIZATION.id,
    hasSyncConsentOrganizationBinding: () => true,
    clearSyncObservabilityTier: () => undefined,
    getSessionOrganizationId: () => state.identity?.organizationId ?? null,
    setSyncConsentOrganizationId: () => undefined,
    applyDataSyncLevel: (level) =>
      applyDataSyncLevel(level, {
        isGoldenMode: () => false,
        isShuttingDown: () => false,
        hasTranscriptSyncLane: () => true,
        startTranscriptSyncLane: () => undefined,
        onLevelRecorded: () => undefined,
        setDataSyncLevel: (next) => {
          state.level = next;
        },
        setPersistedCloudConnectionEnabled: () => undefined,
        setCloudCommandsPaused: () => undefined,
        setCloudConnectionEnabled: (enabled) =>
          setCloudConnectionEnabled(enabled, {
            isGoldenMode: () => false,
            isEnabled: () => state.cloudConnectionEnabled,
            invalidateStartup: () => undefined,
            recordEnabled: (next) => {
              state.cloudConnectionEnabled = next;
            },
            stop: () => {
              consent.stops += 1;
              markTargetUnknown();
            },
            forgetIdentity: () => undefined,
            applyDisabledState: () => undefined,
            applyIdleState: () => undefined,
            restart: () => {
              consent.restarts += 1;
              markTargetUnknown();
            },
          }),
      }),
  };
}

function invokeMain<T>(handle: () => T): Promise<T> {
  return Promise.resolve().then(handle);
}
