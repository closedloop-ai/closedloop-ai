/**
 * ISS-12423 (PRD-793 AC 1): the integrated regression for the onboarding events
 * flow 90069504 lost on desktop 0.17.482 — create_organization completed,
 * sync_policy viewed, sync_policy completed, invite_team viewed — across both
 * readiness gaps and the Full-transcripts consent save.
 *
 * Drives the REAL Desktop takeover (host, guest run, guest→server handoff,
 * transition hook, flow session) through the REAL renderer analytics adapter,
 * surface-analytics IPC handler, `Observability` occurrence stamp, observability
 * lane router with its ISS-12420 readiness queue, and analytics HTTP lane, down
 * to `fetch`. The consent save runs the REAL `applySyncConsent` →
 * `applyDataSyncLevel` → `setCloudConnectionEnabled` chain (ISS-12422).
 * Stubbed: the IPC transport, the guided-onboarding API, `fetch`, and the leaf
 * reads the steps do not route on.
 *
 * Identity-boundary unit coverage stays with its owner,
 * `apps/desktop/test/onboarding-analytics-queue.test.ts` (sign-out, refresh
 * failure, user/org/origin change, TTL, overflow); one organization switch is
 * composed here so the boundary holds on this path too.
 */

import { OnboardingAnalyticsDropReason } from "@closedloop-ai/telemetry-contract/app";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  OnboardingAnalyticsEvent as Event,
  OnboardingSyncPolicyChoice,
  OnboardingAnalyticsProperty as Property,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase as Phase } from "@repo/api/src/types/onboarding-phase";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ANALYSIS_PROGRESS,
  UNKNOWN_ORGANIZATION_MEMBERS,
  UNKNOWN_SESSION_DISCOVERY,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import {
  resetOnboardingFlowSessionForTests,
  startOnboardingFlowSession,
} from "@repo/app/onboarding/lib/onboarding-flow-session";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopAnalyticsLaneEvent } from "../../../../main/cloud/desktop-analytics-http-lane";
import { gatewayLog } from "../../../../main/logging/gateway-logger";
import { Observability } from "../../../../main/telemetry/observability";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { DesktopSurfaceAnalyticsProvider } from "../../../shared/desktop-surface-analytics-adapter";
import {
  CONTINUE,
  CREATE_HEADING,
  createGuidedOnboardingServer,
  INVITE_HEADING,
  NAME_LABEL,
  ORGANIZATION,
  renderDesktopTakeover,
  SYNC_HEADING,
  seedLocalRunOnCreateOrganization,
  stubDesktopTakeoverBridge,
  USER_ID,
} from "./desktop-guided-onboarding-takeover-fixtures";
import {
  composeMainProcess,
  type MainProcess,
} from "./desktop-onboarding-analytics-main-process";
import { firstRunServerSnapshot } from "./guest-guided-onboarding-handoff-fixtures";

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet, post: mocks.apiPost }),
}));
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@repo/navigation/use-path", () => ({ usePath: () => "/" }));
vi.mock("../../../startup-readiness/use-startup-readiness", () => ({
  useStartupReadiness: () => ({ active: false }),
}));
vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({
    identity: {
      email: "ada@example.test",
      organizationId: ORGANIZATION.id,
      organizationName: ORGANIZATION.name,
      organizationSlug: "acme",
      userId: USER_ID,
    },
  }),
}));
vi.mock("../../../shared-branches/desktop-github-integration-status", () => ({
  useDesktopGitHubIntegrationStatus: () => null,
}));
vi.mock("../../branches/use-desktop-github-connect", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../branches/use-desktop-github-connect")
    >();
  return {
    ...actual,
    useDesktopGitHubConnect: () => ({
      connectGitHub: vi.fn(() => Promise.resolve()),
      connectState: actual.DesktopGitHubConnectState.Idle,
    }),
  };
});
vi.mock("../../../hooks/use-onboarding-session-discovery", () => ({
  useOnboardingSessionDiscovery: () => ({
    discovery: UNKNOWN_SESSION_DISCOVERY,
    progress: UNKNOWN_ANALYSIS_PROGRESS,
    settled: true,
    started: true,
  }),
}));
vi.mock("../use-sync-consent-record", () => ({
  useDeviceSyncConsentRecord: () => ({
    record: { bound: true, organizationId: ORGANIZATION.id, tier: null },
  }),
}));
vi.mock("@repo/app/onboarding/hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: () => ({
    invite: vi.fn(),
    invitedEmails: [],
    outcome: IDLE_INVITE_OUTCOME,
  }),
}));
vi.mock(
  "@repo/app/onboarding/hooks/use-onboarding-organization-members",
  () => ({
    useOnboardingOrganizationMembers: () => UNKNOWN_ORGANIZATION_MEMBERS,
  })
);

const FLUSH = { timeoutMs: 1000 };
const FULL_OPTION = /full transcripts/i;
const T_FLOW_START = Date.parse("2026-10-12T21:00:00.000Z");
const T_ORG_CREATED = T_FLOW_START + 60_000;
const T_GAP_ONE_CLOSED = T_ORG_CREATED + 45_000;
const T_SYNC_SAVED = T_GAP_ONE_CLOSED + 30_000;
const T_GAP_TWO_CLOSED = T_SYNC_SAVED + 45_000;

/** The four events the incident flow never delivered, in emission order. */
const FORMERLY_MISSING = [
  `${Event.StepCompleted}:${Phase.CreateOrganization}`,
  `${Event.StepViewed}:${Phase.SyncPolicy}`,
  `${Event.StepCompleted}:${Phase.SyncPolicy}`,
  `${Event.StepViewed}:${Phase.InviteTeam}`,
];

const AUTHENTICATED = {
  organizationId: ORGANIZATION.id,
  status: DesktopAuthStatus.Authenticated,
  userId: USER_ID,
};

let main: MainProcess | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  // Date only: the takeover's own scheduling stays on the real clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T_FLOW_START);
  stubLocalStorage();
  resetOnboardingFlowSessionForTests();
  const server = createGuidedOnboardingServer(firstRunServerSnapshot());
  mocks.apiGet.mockImplementation(server.get);
  mocks.apiPost.mockImplementation(server.post);
});

afterEach(() => {
  cleanup();
  main?.router.dispose();
  main = null;
  Observability.reset();
  gatewayLog.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "desktopApi");
});

describe("ISS-12423: onboarding analytics across both readiness gaps", () => {
  it("delivers create_organization → sync_policy → invite_team as captured, without a consent reconnect", async () => {
    const side = startMainProcess();
    const { flowId } = await startTakeoverAtCreateOrganization(side);

    // Gap 1: the organization exists and the session is authenticated, but
    // the socket has not resolved the new organization's compute target.
    await createOrganization();
    await waitForAccepted(side, `${Event.StepViewed}:${Phase.SyncPolicy}`);
    side.router.refreshAnalyticsReadiness();
    await side.router.flushAnalytics(FLUSH);
    expect(delivered(side, flowId)).toEqual([]);

    vi.setSystemTime(T_GAP_ONE_CLOSED);
    side.connectTarget();
    const gapOne = await signalReadinessTwice(side);
    expect(gapOne.afterRepeat).toBe(gapOne.afterFirst);
    expect(delivered(side, flowId)).toEqual(funnel(side.accepted, flowId));
    expect(keys(delivered(side, flowId))).toEqual(
      expect.arrayContaining(FORMERLY_MISSING.slice(0, 2))
    );

    // Full transcripts while connected: the policy applies and the socket
    // stays up. Gap 2 opens only AFTER the save, so the save is not its cause.
    vi.setSystemTime(T_SYNC_SAVED);
    side.dropTargetAfterNextConsentSave();
    const beforeGapTwo = delivered(side, flowId).length;
    await continueFromSyncPolicy();
    expect(side.consent).toMatchObject({
      saved: [DataSyncLevel.Full],
      readyAfterSave: [true],
      restarts: 0,
      stops: 0,
    });
    expect(side.state.level).toBe(DataSyncLevel.Full);
    await waitForAccepted(side, `${Event.StepViewed}:${Phase.InviteTeam}`);
    await side.router.flushAnalytics(FLUSH);
    expect(delivered(side, flowId)).toHaveLength(beforeGapTwo);

    vi.setSystemTime(T_GAP_TWO_CLOSED);
    side.connectTarget();
    const gapTwo = await signalReadinessTwice(side);
    expect(gapTwo.afterRepeat).toBe(gapTwo.afterFirst);
    const settled = delivered(side, flowId);
    expect(settled).toEqual(funnel(side.accepted, flowId));

    // A remount on the persisted invite_team run and another readiness signal
    // must neither emit nor send anything more.
    const acceptedBeforeRemount = side.accepted.length;
    cleanup();
    stubDesktopTakeoverBridge(AUTHENTICATED, {
      captureSurfaceAnalytics: side.captureSurfaceAnalytics,
      getDataSyncLevel: side.getDataSyncLevel,
      recordSyncConsent: side.recordSyncConsent,
      createBootstrapOrganization: vi.fn(),
    });
    renderDesktopTakeover(DesktopSurfaceAnalyticsProvider);
    await screen.findByRole("dialog", { name: INVITE_HEADING });
    side.router.refreshAnalyticsReadiness();
    await side.router.flushAnalytics(FLUSH);
    expect(side.accepted).toHaveLength(acceptedBeforeRemount);
    expect(delivered(side, flowId)).toEqual(settled);

    // Each formerly missing event arrives exactly once, with the flow_id and
    // occurrence time of its capture, not of its delivery, in a reconstructable
    // order. Filtering rather than `find` keeps a duplicate send visible.
    const firsts = settled.filter((event) =>
      FORMERLY_MISSING.includes(keyOf(event))
    );
    expect(keys(firsts)).toEqual(FORMERLY_MISSING);
    expect(firsts.map((event) => event.properties?.[Property.FlowId])).toEqual(
      FORMERLY_MISSING.map(() => flowId)
    );
    expect(firsts.map((event) => event.occurredAt)).toEqual(
      [T_ORG_CREATED, T_ORG_CREATED, T_SYNC_SAVED, T_SYNC_SAVED].map((ms) =>
        new Date(ms).toISOString()
      )
    );
    expect(
      firsts.map((event) => event.properties?.[Property.StepIndex])
    ).toEqual([3, 4, 4, 5]);
    expect(firsts[2]?.properties?.[Property.SyncPolicyChoice]).toBe(
      OnboardingSyncPolicyChoice.FullTranscripts
    );
    expect(side.drops()).toEqual([]);
  });

  it("never delivers a gap's events to a different organization", async () => {
    const side = startMainProcess();
    const { flowId } = await startTakeoverAtCreateOrganization(side);
    await createOrganization();
    await waitForAccepted(side, `${Event.StepViewed}:${Phase.SyncPolicy}`);

    side.state.identity = { userId: USER_ID, organizationId: "org-other" };
    side.connectTarget();
    side.router.refreshAnalyticsReadiness();
    await side.router.flushAnalytics(FLUSH);

    const gap = funnel(side.accepted, flowId);
    expect(keys(gap)).toEqual(
      expect.arrayContaining(FORMERLY_MISSING.slice(0, 2))
    );
    expect(
      side.fetcher.mock.calls.filter(([, init]) =>
        String(init?.body).includes(flowId)
      )
    ).toEqual([]);
    expect(side.drops()).toEqual(
      gap.map((event) => [
        OnboardingAnalyticsDropReason.OrganizationMismatch,
        event.properties?.[Property.Step],
      ])
    );
  });
});

/**
 * A first user whose flow began at Welcome, parked on organization creation
 * while main exchanges the new session. Main authenticates the new
 * organization's session and pushes it before the bridge call returns
 * (`DesktopBootstrapSession.createOrganization` → `applyTokens`).
 */
async function startTakeoverAtCreateOrganization(side: MainProcess) {
  const session = startOnboardingFlowSession(T_FLOW_START);
  seedLocalRunOnCreateOrganization();
  const bridge = stubDesktopTakeoverBridge(
    {
      awaitingOrganization: true,
      pendingUserId: USER_ID,
      organizationId: null,
      status: DesktopAuthStatus.Exchanging,
      userId: null,
    },
    {
      captureSurfaceAnalytics: side.captureSurfaceAnalytics,
      getDataSyncLevel: side.getDataSyncLevel,
      recordSyncConsent: side.recordSyncConsent,
      createBootstrapOrganization: () => {
        vi.setSystemTime(T_ORG_CREATED);
        side.authenticate();
        bridge.pushAuthState(AUTHENTICATED);
        return Promise.resolve({ ok: true });
      },
    }
  );
  renderDesktopTakeover(DesktopSurfaceAnalyticsProvider);
  await screen.findByRole("dialog", { name: CREATE_HEADING });
  return session;
}

async function createOrganization() {
  fireEvent.change(screen.getByLabelText(NAME_LABEL), {
    target: { value: "Acme Co" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
  await screen.findByRole("dialog", { name: SYNC_HEADING });
  // The guest run's server handoff captures at its own acceptance, before it
  // posts; waiting for the post keeps every gap-1 capture ahead of readiness.
  await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledOnce());
}

/** Choose Full transcripts over the Metadata level main reports, then continue. */
async function continueFromSyncPolicy() {
  fireEvent.click(await screen.findByRole("radio", { name: FULL_OPTION }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: CONTINUE }).hasAttribute("disabled")
    ).toBe(false)
  );
  fireEvent.click(screen.getByRole("button", { name: CONTINUE }));
  await screen.findByRole("dialog", { name: INVITE_HEADING });
}

async function waitForAccepted(side: MainProcess, key: string) {
  await waitFor(() => expect(keys(side.accepted)).toContain(key));
}

/** The flow's events that reached the authenticated lane, as sent. */
function delivered(
  side: MainProcess,
  flowId: string
): DesktopAnalyticsLaneEvent[] {
  return funnel(
    side.fetcher.mock.calls
      .filter(([url]) =>
        new URL(String(url)).searchParams.has("computeTargetId")
      )
      .map(([, init]) => JSON.parse(String(init?.body))),
    flowId
  );
}

/** The flow's own events, in the order `Observability` accepted them. */
function funnel(
  events: DesktopAnalyticsLaneEvent[],
  flowId: string
): DesktopAnalyticsLaneEvent[] {
  return events.filter(
    (event) => event.properties?.[Property.FlowId] === flowId
  );
}

function keys(events: DesktopAnalyticsLaneEvent[]): string[] {
  return events.map(keyOf);
}

function keyOf(event: DesktopAnalyticsLaneEvent): string {
  return `${event.event}:${String(event.properties?.[Property.Step])}`;
}

/** The main process for one case, registered for `afterEach` disposal. */
function startMainProcess(): MainProcess {
  main = composeMainProcess();
  return main;
}

/**
 * A readiness signal, then a repeat of it. Returns the request count after
 * each, so a case can hold the repeat to sending nothing more.
 */
async function signalReadinessTwice(side: MainProcess) {
  side.router.refreshAnalyticsReadiness();
  await side.router.flushAnalytics(FLUSH);
  const afterFirst = side.fetcher.mock.calls.length;
  side.router.refreshAnalyticsReadiness();
  await side.router.flushAnalytics(FLUSH);
  return { afterFirst, afterRepeat: side.fetcher.mock.calls.length };
}
