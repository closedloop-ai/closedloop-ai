/**
 * ISS-11090: the Desktop path the report came from. A guest who signs up is
 * handed to the server run by `account_established`, and by then Clerk's
 * session task has already made their organization. The handoff used to land
 * that first user on CreateOrganization, which Desktop cannot submit.
 *
 * The REAL transition hook runs the machine, so the phase asserted here is the
 * one the production resolver chose; only the transport and the auth snapshot
 * are stubbed.
 */

import {
  OnboardingAccountMode,
  OnboardingAnalyticsEvent,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import { guidedOnboardingTransitionRequestSchema } from "@repo/api/src/types/onboarding-guided";
import { restoreOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { resetOnboardingFlowSessionForTests } from "@repo/app/onboarding/lib/onboarding-flow-session";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { desktopGuestGuidedOnboardingStorageKey } from "../../dashboard/dashboard-storage-keys";
import { useGuestGuidedOnboardingHandoff } from "../use-guest-guided-onboarding-handoff";
import {
  firstRunServerSnapshot,
  ORG_ID,
  seedGuestRecord,
  seedResumedAccountRecord,
  USER_ID,
} from "./guest-guided-onboarding-handoff-fixtures";

const mocks = vi.hoisted(() => ({
  capture: vi.fn<SurfaceAnalyticsCapture>(),
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.get, post: mocks.post }),
}));

// What `DesktopAuthProvider` reports for an authenticated session: the
// organization is part of the desktop identity, never absent beside a user.
vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => authSnapshot(),
  useOptionalAuthSnapshot: () => authSnapshot(),
}));

beforeEach(() => {
  stubLocalStorage();
  vi.clearAllMocks();
  resetOnboardingFlowSessionForTests();
  mocks.get.mockResolvedValue(firstRunServerSnapshot());
  mocks.post.mockResolvedValue(null);
});

describe("the guest handoff for a first user already in an organization", () => {
  it("hands off a verified bootstrap organization completion without replaying account creation", async () => {
    seedRecordOnCreateOrganization();
    const { rerender } = renderHook(
      ({ active }) =>
        useGuestGuidedOnboardingHandoff({
          accountMode: [OnboardingAccountMode.SignedIn],
          active,
          analysisStarted: true,
          onDashboardAvailable: () => undefined,
          organizationId: active ? ORG_ID : null,
          syncConsentRecorded: KnownFlag.No,
          userId: active ? USER_ID : null,
        }),
      {
        initialProps: { active: false },
        wrapper: withQueryClient,
      }
    );
    rerender({ active: true });
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const command = guidedOnboardingTransitionRequestSchema.parse(
      mocks.post.mock.calls[0][1]
    );
    expect(command.event.type).toBe(OnboardingEvent.OrganizationReady);
    expect(command.state.phase).toBe(OnboardingPhase.SyncPolicy);
  });
  it("lands on the choose step, not the create step Desktop cannot submit", async () => {
    seedGuestRecord();

    renderHandoff();

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [, body] = mocks.post.mock.calls[0] ?? [];
    const command = guidedOnboardingTransitionRequestSchema.parse(body);
    // The fixture's server context is a first user; this is the resolver's
    // answer for one whose session is in an organization.
    expect(firstRunServerSnapshot().context.membership).toBe(
      OrganizationMembership.FirstUser
    );
    expect(
      restoreOnboardingState(command.state, OnboardingHost.Desktop).state.phase
    ).toBe(OnboardingPhase.ChooseOrganization);
  });
});

/**
 * ISS-12423 (PRD-793 AC-001.4): main pushes the new organization's session
 * before the create-organization bridge call returns, so the handoff reads the
 * record still on CreateOrganization, and the guest run then accepts and
 * captures that same OrganizationReady. One click is one capture.
 */
describe("the bootstrap organization handoff's funnel capture", () => {
  it("does not capture the step again once the guest run has accepted it", async () => {
    const record = seedRecordOnCreateOrganization();
    const server = deferServerSnapshot();
    renderBootstrapHandoff();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());

    // The guest run's own acceptance of the same click, written while the
    // handoff's snapshot read is in flight.
    localStorage.setItem(
      desktopGuestGuidedOnboardingStorageKey,
      JSON.stringify({
        revision: record.revision + 1,
        state: {
          ...record.state,
          history: [
            ...record.state.history,
            OnboardingPhase.CreateOrganization,
          ],
          phase: OnboardingPhase.SyncPolicy,
        },
      })
    );
    server.resolve();

    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    const command = guidedOnboardingTransitionRequestSchema.parse(
      mocks.post.mock.calls[0][1]
    );
    expect(command.event.type).toBe(OnboardingEvent.OrganizationReady);
    expect(command.state.phase).toBe(OnboardingPhase.SyncPolicy);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("still captures a handoff no guest run accepted first", async () => {
    seedRecordOnCreateOrganization();
    const server = deferServerSnapshot();
    renderBootstrapHandoff();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    server.resolve();

    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(mocks.capture.mock.calls.map(([event]) => event)).toEqual([
      OnboardingAnalyticsEvent.StepCompleted,
      OnboardingAnalyticsEvent.StepViewed,
    ]);
  });
});

/**
 * ISS-11480: a guest who reopened the Account step from the dashboard and signs
 * up there still owes the organization tail their first run never reached.
 */
describe("the guest handoff from a resumed Account step", () => {
  it("continues into the organization step rather than the dashboard", async () => {
    seedResumedAccountRecord();

    renderHandoff();

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const [, body] = mocks.post.mock.calls[0] ?? [];
    const command = guidedOnboardingTransitionRequestSchema.parse(body);
    expect(
      restoreOnboardingState(command.state, OnboardingHost.Desktop).state.phase
    ).toBe(OnboardingPhase.ChooseOrganization);
  });
});

function renderHandoff() {
  return renderHook(
    () =>
      useGuestGuidedOnboardingHandoff({
        accountMode: [OnboardingAccountMode.SignedIn],
        active: true,
        analysisStarted: true,
        onDashboardAvailable: () => undefined,
        organizationId: ORG_ID,
        syncConsentRecorded: KnownFlag.Yes,
        userId: USER_ID,
      }),
    { wrapper: withQueryClient }
  );
}

function authSnapshot() {
  return {
    getToken: () => Promise.resolve(null),
    isLoaded: true,
    orgId: ORG_ID,
    userId: USER_ID,
  };
}

function withQueryClient({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  return (
    <QueryClientProvider client={client}>
      <SurfaceAnalyticsProvider
        capture={mocks.capture}
        setPersonProperties={vi.fn()}
        surface={Surface.Desktop}
      >
        {children}
      </SurfaceAnalyticsProvider>
    </QueryClientProvider>
  );
}

/** A guest record parked on CreateOrganization, as the bootstrap flow leaves it. */
function seedRecordOnCreateOrganization() {
  seedGuestRecord();
  const record = JSON.parse(
    localStorage.getItem(desktopGuestGuidedOnboardingStorageKey) ?? "null"
  );
  record.state.history.push(OnboardingPhase.Account);
  record.state.phase = OnboardingPhase.CreateOrganization;
  localStorage.setItem(
    desktopGuestGuidedOnboardingStorageKey,
    JSON.stringify(record)
  );
  return record;
}

/** Holds the handoff's snapshot read open until the case releases it. */
function deferServerSnapshot() {
  let release: () => void = () => undefined;
  mocks.get.mockReturnValue(
    new Promise((resolve) => {
      release = () => resolve(firstRunServerSnapshot());
    })
  );
  return { resolve: () => release() };
}

/** The handoff the moment the bootstrap organization's session settles. */
function renderBootstrapHandoff() {
  const { rerender } = renderHook(
    ({ active }) =>
      useGuestGuidedOnboardingHandoff({
        accountMode: [OnboardingAccountMode.SignedIn],
        active,
        analysisStarted: true,
        onDashboardAvailable: () => undefined,
        organizationId: active ? ORG_ID : null,
        syncConsentRecorded: KnownFlag.No,
        userId: active ? USER_ID : null,
      }),
    { initialProps: { active: false }, wrapper: withQueryClient }
  );
  rerender({ active: true });
}
