/**
 * ISS-11090 on the surface it was reported on. A Desktop user whose signup
 * finished in the browser is already in the organization Clerk's session task
 * made, and a run parked on CreateOrganization stuck there: Desktop wires no
 * create handler, so submitting only showed an error.
 *
 * Drives the REAL Desktop host, shared host and transition hook, and the REAL
 * `DesktopAuthProvider`, so the organization the shared host remaps on
 * (`useAuthSnapshot().orgId`) and the one the Desktop host marks chosen
 * (`useDesktopAuth().state.organizationId`) come from the one store production
 * mounts. Stubbed: the IPC bridge, the transport, and the leaf reads the
 * organization step does not route on.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import { guidedOnboardingTransitionRequestSchema } from "@repo/api/src/types/onboarding-guided";
import { restoreOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import type { DesktopAuthState } from "../../../types/desktop-api";
import { readGuestGuidedOnboardingRecord } from "../guest-guided-onboarding-record";
import {
  CONTINUE,
  CREATE_HEADING,
  createGuidedOnboardingServer,
  INVITE_HEADING,
  NAME_LABEL,
  ORGANIZATION,
  parkedOnCreateOrganization,
  renderDesktopTakeover,
  SYNC_HEADING,
  seedLocalRunOnCreateOrganization,
  stubDesktopTakeoverBridge,
  TRANSITION_PATH,
  USER_ID,
} from "./desktop-guided-onboarding-takeover-fixtures";
import { firstRunServerSnapshot } from "./guest-guided-onboarding-handoff-fixtures";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  capture: vi.fn<SurfaceAnalyticsCapture>(),
  createBootstrapOrganization: vi.fn(),
  recordSyncConsent: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet, post: mocks.apiPost }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/",
}));

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
    discovery: { status: "unknown" },
    progress: { status: "unknown" },
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

const CHOOSE_HEADING = /choose an organization/i;
/** The confirmation-only row's own button, disabled because the org is chosen. */
const SELECTED = /^selected$/i;
/** The URL the step states for a slug of `acme-co`, scheme included. */
const ORGANIZATION_URL = "https://app.closedloop.ai/acme-co";

function stubDesktopAuthBridge(state: DesktopAuthState): void {
  bridge = stubDesktopTakeoverBridge(state, {
    createBootstrapOrganization: mocks.createBootstrapOrganization,
    recordSyncConsent: mocks.recordSyncConsent,
  });
}

function renderTakeover() {
  renderDesktopTakeover(CapturingAnalyticsProvider);
}

function CapturingAnalyticsProvider({ children }: { children: ReactNode }) {
  return (
    <SurfaceAnalyticsProvider
      capture={mocks.capture}
      setPersonProperties={vi.fn()}
      surface={Surface.Desktop}
    >
      {children}
    </SurfaceAnalyticsProvider>
  );
}

function postedStates() {
  return mocks.apiPost.mock.calls
    .filter(([path]) => path === TRANSITION_PATH)
    .map(
      ([, body]) =>
        restoreOnboardingState(
          guidedOnboardingTransitionRequestSchema.parse(body).state,
          OnboardingHost.Desktop
        ).state
    );
}

describe("Desktop guided organization step for a first user (ISS-11090)", () => {
  let server: ReturnType<typeof createGuidedOnboardingServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    stubLocalStorage();
    stubDesktopAuthBridge({
      organizationId: ORGANIZATION.id,
      status: DesktopAuthStatus.Authenticated,
      userId: USER_ID,
    });
    server = createGuidedOnboardingServer(parkedOnCreateOrganization());
    mocks.apiGet.mockImplementation(server.get);
    mocks.recordSyncConsent.mockImplementation(
      (payload: { level: DataSyncLevel; organizationId: string | null }) =>
        Promise.resolve(payload)
    );
    mocks.createBootstrapOrganization.mockResolvedValue({ ok: true });
    mocks.apiPost.mockImplementation(server.post);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktopApi");
  });

  it("shows a run parked on create the choose step, selected and continuable", async () => {
    renderTakeover();

    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    // Plain assertions: the renderer vitest config loads no jest-dom setup.
    expect(within(chooseStep).getByText(ORGANIZATION.name)).not.toBeNull();
    expect(screen.queryByText(CREATE_HEADING)).toBeNull();

    fireEvent.click(within(chooseStep).getByRole("button", { name: CONTINUE }));

    await waitFor(() =>
      expect(postedStates().map((state) => state.phase)).toEqual([
        OnboardingPhase.SyncPolicy,
      ])
    );
    // The step that was shown, not the one persisted before the fix, is the
    // step left: in the posted history and in the funnel event.
    expect(postedStates()[0]?.history.at(-1)).toBe(
      OnboardingPhase.ChooseOrganization
    );
    const [, completed] =
      mocks.capture.mock.calls.find(
        ([event]) => event === OnboardingAnalyticsEvent.StepCompleted
      ) ?? [];
    expect(completed?.[OnboardingAnalyticsProperty.Step]).toBe(
      OnboardingPhase.ChooseOrganization
    );
  });

  // ISS-10890: the sync step now follows the organization step, so the answer
  // the wizard records must bind to the organization the reader just chose.
  it("records the sync answer against the active organization, then invites", async () => {
    renderTakeover();
    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    fireEvent.click(within(chooseStep).getByRole("button", { name: CONTINUE }));

    const syncStep = await screen.findByRole("dialog", { name: SYNC_HEADING });
    fireEvent.click(
      within(syncStep).getByRole("radio", { name: "Full transcripts" })
    );
    fireEvent.click(within(syncStep).getByRole("button", { name: CONTINUE }));

    await waitFor(() =>
      expect(mocks.recordSyncConsent).toHaveBeenCalledWith({
        level: DataSyncLevel.Full,
        organizationId: ORGANIZATION.id,
      })
    );
    await waitFor(() =>
      expect(postedStates().map((state) => state.phase)).toEqual([
        OnboardingPhase.SyncPolicy,
        OnboardingPhase.InviteTeam,
      ])
    );
  });

  /**
   * ISS-11253 AC3. Desktop keeps `Choose` as a confirmation: it wires no rename
   * handler at all, so the naming affordance is off there — the CAPABILITY is
   * the gate, and it is the host that withholds it, not a flag.
   *
   * Paired with a positive on the same row, because an absent field is also what
   * a step that failed to render at all would show.
   */
  it("keeps the choose step a confirmation with no rename handler", async () => {
    renderTakeover();

    const chooseStep = await screen.findByRole("dialog", {
      name: CHOOSE_HEADING,
    });
    expect(within(chooseStep).getByText(ORGANIZATION.name)).not.toBeNull();
    // Plain assertions: the renderer vitest config loads no jest-dom setup.
    expect(
      within(chooseStep)
        .getByRole("button", { name: SELECTED })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(within(chooseStep).queryByLabelText(NAME_LABEL)).toBeNull();
    expect(within(chooseStep).queryByLabelText("Slug")).toBeNull();
  });

  /**
   * ISS-11154, on the Desktop shell rather than the prototype adapter. The one
   * state `chooseActiveOrganization` leaves on the create step is a loaded,
   * signed-in session with no organization, so the bridge is re-stubbed for it
   * here. The scheme is the subject, so the expected URL is written out rather
   * than read from the component's own template: a literal the step produced
   * would agree with a revert to `http` and stay green.
   */
  it("states the organization URL as https", async () => {
    seedLocalRunOnCreateOrganization();
    stubDesktopAuthBridge({
      awaitingOrganization: true,
      pendingUserId: USER_ID,
      organizationId: null,
      status: DesktopAuthStatus.Exchanging,
      userId: null,
    });
    renderTakeover();

    const createStep = await screen.findByRole("dialog", {
      name: CREATE_HEADING,
    });
    expect(
      within(createStep)
        .getByLabelText("Organization logo file")
        .hasAttribute("disabled")
    ).toBe(false);
    expect(
      within(createStep).queryByText("Logo upload is not available yet.")
    ).toBeNull();
    fireEvent.change(within(createStep).getByLabelText(NAME_LABEL), {
      target: { value: "Acme Co" },
    });

    // The href and the text the reader copies are the same string, so both are
    // held: `getByRole` matches the accessible name, the read-back the link.
    const organizationUrl = within(createStep).getByRole("link", {
      name: ORGANIZATION_URL,
    });
    expect(organizationUrl.getAttribute("href")).toBe(ORGANIZATION_URL);
  });

  it.each([false, true])(
    "creates the first organization through the Desktop bootstrap bridge (logo: %s)",
    async (withLogo) => {
      seedLocalRunOnCreateOrganization();
      stubDesktopAuthBridge({
        awaitingOrganization: true,
        pendingUserId: USER_ID,
        organizationId: null,
        status: DesktopAuthStatus.Exchanging,
        userId: USER_ID,
      });
      renderTakeover();

      const createStep = await screen.findByRole("dialog", {
        name: CREATE_HEADING,
      });
      fireEvent.change(within(createStep).getByLabelText(NAME_LABEL), {
        target: { value: "Acme Co" },
      });
      if (withLogo) {
        fireEvent.change(
          within(createStep).getByLabelText("Organization logo file"),
          {
            target: {
              files: [new File(["logo"], "logo.png", { type: "image/png" })],
            },
          }
        );
      }
      fireEvent.click(
        within(createStep).getByRole("button", { name: "Create organization" })
      );

      await waitFor(() =>
        expect(mocks.createBootstrapOrganization).toHaveBeenCalledWith({
          name: "Acme Co",
          slug: "acme-co",
          ...(withLogo
            ? {
                logo: {
                  name: "logo.png",
                  type: "image/png",
                  base64: "bG9nbw==",
                },
              }
            : {}),
        })
      );
      expect(
        await screen.findByRole("dialog", { name: SYNC_HEADING })
      ).not.toBeNull();
      expect(mocks.apiPost).not.toHaveBeenCalled();
      const localRecord = readGuestGuidedOnboardingRecord();
      expect(
        localRecord
          ? restoreOnboardingState(localRecord.state, OnboardingHost.Desktop)
              .state.phase
          : null
      ).toBe(OnboardingPhase.SyncPolicy);
    }
  );

  /**
   * ISS-11121: the fresh-organization first user, past the step above. Main
   * sends the organization-bound push before the bridge call returns
   * (`DesktopBootstrapSession.createOrganization` → `applyTokens`), and this
   * case keeps that order. The guest run is then handed to a server that has
   * no attempt for the new account.
   */
  it("hands a fresh organization's run to the server, then invites", async () => {
    server.replace(firstRunServerSnapshot());
    seedLocalRunOnCreateOrganization();
    stubDesktopAuthBridge({
      awaitingOrganization: true,
      pendingUserId: USER_ID,
      organizationId: null,
      status: DesktopAuthStatus.Exchanging,
      userId: null,
    });
    mocks.createBootstrapOrganization.mockImplementation(() => {
      bridge.pushAuthState({
        organizationId: ORGANIZATION.id,
        status: DesktopAuthStatus.Authenticated,
        userId: USER_ID,
      });
      return Promise.resolve({ ok: true });
    });
    renderTakeover();

    const createStep = await screen.findByRole("dialog", {
      name: CREATE_HEADING,
    });
    fireEvent.change(within(createStep).getByLabelText(NAME_LABEL), {
      target: { value: "Acme Co" },
    });
    fireEvent.click(
      within(createStep).getByRole("button", { name: "Create organization" })
    );

    await waitFor(() =>
      expect(postedEvents()).toEqual([OnboardingEvent.OrganizationReady])
    );
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: SYNC_HEADING })
      ).getByRole("radio", { name: "Full transcripts" })
    );
    fireEvent.click(
      within(screen.getByRole("dialog", { name: SYNC_HEADING })).getByRole(
        "button",
        { name: CONTINUE }
      )
    );

    expect(
      await screen.findByRole("dialog", { name: INVITE_HEADING })
    ).not.toBeNull();
    expect(postedStates().map((state) => state.phase)).toEqual([
      OnboardingPhase.SyncPolicy,
      OnboardingPhase.InviteTeam,
    ]);
  });

  it("keeps organization setup open when the Desktop bootstrap bridge refuses", async () => {
    seedLocalRunOnCreateOrganization();
    mocks.createBootstrapOrganization.mockResolvedValue({
      ok: false,
      error: "bootstrap expired",
    });
    stubDesktopAuthBridge({
      awaitingOrganization: true,
      pendingUserId: USER_ID,
      organizationId: null,
      status: DesktopAuthStatus.Exchanging,
      userId: USER_ID,
    });
    renderTakeover();

    const createStep = await screen.findByRole("dialog", {
      name: CREATE_HEADING,
    });
    fireEvent.change(within(createStep).getByLabelText(NAME_LABEL), {
      target: { value: "Acme Co" },
    });
    fireEvent.click(
      within(createStep).getByRole("button", { name: "Create organization" })
    );

    expect(
      await within(createStep).findByText(
        "We couldn't create your organization. Please try again."
      )
    ).not.toBeNull();
    expect(postedStates()).toEqual([]);
  });
});

/** The bridge stubbed for the running case; each stub starts a fresh subscriber. */
let bridge: ReturnType<typeof stubDesktopTakeoverBridge>;

function postedEvents() {
  return mocks.apiPost.mock.calls
    .filter(([path]) => path === TRANSITION_PATH)
    .map(
      ([, body]) =>
        guidedOnboardingTransitionRequestSchema.parse(body).event.type
    );
}
