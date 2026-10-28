// @vitest-environment jsdom

/**
 * ISS-11670, through the production host both shells mount: the invite step's
 * sent state is earned only by a send made in THIS run, and it lists the
 * addresses that send invited. The persisted per-user `teamInvited` marker is
 * stamped by any send (settings, an earlier run), so it must not earn it.
 *
 * Operator ruling 2026-10-05: the web-master prototype is the spec for this
 * step's copy and its continue/advance behavior.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { settingsLocalSyncPolicyReady } from "@repo/api/src/types/settings-host-capabilities";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { INVITE_CONFIRMATION_DURATION_MS } from "../../hooks/use-onboarding-invite-step-outcome";
import {
  IDLE_INVITE_OUTCOME,
  type OnboardingInviteOutcome,
  OnboardingInviteStatus,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";
import { INVITE_SENT_WORD } from "../guided-onboarding-invite-step";

const mockHostDeps = vi.hoisted(() => ({
  invite: {
    identities: [] as (string | null)[],
    invitedEmails: [] as readonly string[],
    outcome: { status: "idle" } as OnboardingInviteOutcome,
  },
  mutate: vi.fn(),
  useGuidedOnboardingSnapshot: vi.fn(),
}));

vi.mock("../../../compute/hooks/use-compute-targets", () => ({
  useComputeTargets: () => ({ data: undefined }),
}));

vi.mock("../../hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: mockHostDeps.useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition: () => ({
    isPending: false,
    mutate: mockHostDeps.mutate,
  }),
}));

vi.mock("../../hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: (identity: string | null) => {
    mockHostDeps.invite.identities.push(identity);
    return {
      invite: vi.fn(),
      invitedEmails: mockHostDeps.invite.invitedEmails,
      outcome: mockHostDeps.invite.outcome,
    };
  },
}));

vi.mock("../../hooks/use-onboarding-organization-members", () => ({
  useOnboardingOrganizationMembers: () => UNKNOWN_ORGANIZATION_MEMBERS,
}));

vi.mock("../../../shared/settings-host/use-local-sync-policy", () => ({
  useLocalSyncPolicy: () => ({
    isWriting: false,
    state: {
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      status: "settled",
    },
    supported: true,
    write: vi.fn(),
    writeOutcome: null,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockHostDeps.invite.identities = [];
  mockHostDeps.invite.invitedEmails = [];
  mockHostDeps.invite.outcome = IDLE_INVITE_OUTCOME;
  showPhase(OnboardingPhase.InviteTeam);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GuidedOnboardingDialogHost invite step (ISS-11670)", () => {
  it("offers the composer, not a sent claim, when only the persisted marker is set", () => {
    renderHost();

    expect(screen.queryByRole("heading", { name: SENT_TITLE })).toBeNull();
    expect(screen.queryByText(SENT_PITCH)).toBeNull();
    expect(screen.getByRole("heading", { name: ASK_TITLE })).not.toBeNull();
    expect(screen.getByRole("button", { name: SKIP_LABEL })).not.toBeNull();
    expect(screen.queryByRole("button", { name: CONTINUE_LABEL })).toBeNull();
  });

  it("scopes this run's send evidence to the signed-in account and organization", () => {
    // Desktop keeps this host mounted across sign-out and organization
    // switches; the hook drops its evidence when this identity changes.
    const view = render(
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          isLoaded: true,
          orgId: "org-a",
          userId: "user-a",
        })}
      >
        <HostHarness />
      </AuthAdapterProvider>
    );
    view.rerender(
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          isLoaded: true,
          orgId: "org-b",
          userId: "user-a",
        })}
      >
        <HostHarness />
      </AuthAdapterProvider>
    );

    expect(mockHostDeps.invite.identities).toContain("user-a:org-a");
    expect(mockHostDeps.invite.identities.at(-1)).toBe("user-a:org-b");
  });

  it("lists this run's invited addresses when the user returns to the step", () => {
    mockHostDeps.invite.invitedEmails = [FIRST_EMAIL, SECOND_EMAIL];

    renderHost();

    expect(screen.getByRole("heading", { name: SENT_TITLE })).not.toBeNull();
    expect(screen.getByText(SENT_PITCH)).not.toBeNull();
    expect(screen.getByText(FIRST_EMAIL)).not.toBeNull();
    expect(screen.getByText(SECOND_EMAIL)).not.toBeNull();
    expect(screen.getByRole("button", { name: CONTINUE_LABEL })).not.toBeNull();
    expect(screen.queryByRole("button", { name: SKIP_LABEL })).toBeNull();
  });

  it("earns the sent state from this run's send before the marker is re-read", () => {
    showPhase(OnboardingPhase.InviteTeam, false);
    mockHostDeps.invite.invitedEmails = [FIRST_EMAIL];

    renderHost();

    expect(screen.getByRole("heading", { name: SENT_TITLE })).not.toBeNull();
    expect(screen.getByText(FIRST_EMAIL)).not.toBeNull();
  });

  it("advances on its own after the prototype's beat once a send lands", () => {
    vi.useFakeTimers();
    mockHostDeps.invite.invitedEmails = [FIRST_EMAIL];
    mockHostDeps.invite.outcome = {
      invited: 1,
      status: OnboardingInviteStatus.Sent,
    };

    renderHost();
    expect(screen.getByText(`1 invitation ${INVITE_SENT_WORD}`)).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(INVITE_CONFIRMATION_DURATION_MS - 1);
    });
    expect(mockHostDeps.mutate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mockHostDeps.mutate).toHaveBeenCalledTimes(1);
    expect(mockHostDeps.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        event: { type: OnboardingEvent.SendInvitations },
      }),
      expect.anything()
    );
  });

  it.each([CONTINUE_LABEL, BACK_LABEL])(
    "posts once when %s is pressed during the beat",
    (label) => {
      vi.useFakeTimers();
      mockHostDeps.invite.invitedEmails = [FIRST_EMAIL];
      mockHostDeps.invite.outcome = {
        invited: 1,
        status: OnboardingInviteStatus.Sent,
      };

      renderHost();
      act(() => {
        vi.advanceTimersByTime(INVITE_CONFIRMATION_DURATION_MS / 2);
      });
      fireEvent.click(screen.getByRole("button", { name: label }));
      act(() => {
        vi.advanceTimersByTime(INVITE_CONFIRMATION_DURATION_MS * 2);
      });

      expect(mockHostDeps.mutate).toHaveBeenCalledTimes(1);
    }
  );

  it.each([CONTINUE_LABEL, BACK_LABEL])(
    "posts nothing more when %s is pressed after the beat posted",
    (label) => {
      vi.useFakeTimers();
      mockHostDeps.invite.invitedEmails = [FIRST_EMAIL];
      mockHostDeps.invite.outcome = {
        invited: 1,
        status: OnboardingInviteStatus.Sent,
      };

      renderHost();
      act(() => {
        vi.advanceTimersByTime(INVITE_CONFIRMATION_DURATION_MS);
      });
      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(mockHostDeps.mutate).toHaveBeenCalledTimes(1);
    }
  );

  it("does not auto-advance a send that lands after Back was pressed", () => {
    vi.useFakeTimers();
    mockHostDeps.invite.invitedEmails = [];
    mockHostDeps.invite.outcome = { status: OnboardingInviteStatus.Pending };
    const { rerender } = renderHost();
    fireEvent.click(screen.getByRole("button", { name: BACK_LABEL }));
    expect(mockHostDeps.mutate).toHaveBeenCalledTimes(1);

    mockHostDeps.invite.invitedEmails = [FIRST_EMAIL];
    mockHostDeps.invite.outcome = {
      invited: 1,
      status: OnboardingInviteStatus.Sent,
    };
    rerender(<HostHarness />);
    act(() => {
      vi.advanceTimersByTime(INVITE_CONFIRMATION_DURATION_MS * 2);
    });

    expect(mockHostDeps.mutate).toHaveBeenCalledTimes(1);
  });

  it("posts nothing more when Continue follows a Back still in flight", () => {
    mockHostDeps.invite.invitedEmails = [FIRST_EMAIL];
    mockHostDeps.invite.outcome = {
      invited: 1,
      status: OnboardingInviteStatus.Sent,
    };

    renderHost();
    fireEvent.click(screen.getByRole("button", { name: BACK_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_LABEL }));

    expect(mockHostDeps.mutate).toHaveBeenCalledTimes(1);
    expect(mockHostDeps.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ event: { type: OnboardingEvent.Back } }),
      expect.anything()
    );
  });

  it("posts nothing more when Skip follows a Back still in flight", () => {
    renderHost();
    fireEvent.click(screen.getByRole("button", { name: BACK_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: SKIP_LABEL }));

    expect(mockHostDeps.mutate).toHaveBeenCalledTimes(1);
  });

  it("paces a newer send again after a transition that did not leave", () => {
    vi.useFakeTimers();
    mockHostDeps.mutate.mockImplementation(
      (_command: unknown, options?: { onSettled?: () => void }) =>
        options?.onSettled?.()
    );
    mockHostDeps.invite.invitedEmails = [FIRST_EMAIL];
    mockHostDeps.invite.outcome = {
      invited: 1,
      status: OnboardingInviteStatus.Sent,
    };
    const { rerender } = renderHost();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_LABEL }));
    act(() => {
      vi.advanceTimersByTime(INVITE_CONFIRMATION_DURATION_MS * 2);
    });
    expect(mockHostDeps.mutate).toHaveBeenCalledTimes(1);

    mockHostDeps.invite.invitedEmails = [FIRST_EMAIL, SECOND_EMAIL];
    mockHostDeps.invite.outcome = {
      invited: 1,
      status: OnboardingInviteStatus.Sent,
    };
    rerender(<HostHarness />);
    act(() => {
      vi.advanceTimersByTime(INVITE_CONFIRMATION_DURATION_MS);
    });

    expect(mockHostDeps.mutate).toHaveBeenCalledTimes(2);
  });

  it("does not advance a partial send on its own", () => {
    vi.useFakeTimers();
    mockHostDeps.invite.invitedEmails = [FIRST_EMAIL];
    mockHostDeps.invite.outcome = {
      alreadyMember: 1,
      failed: 0,
      invited: 1,
      status: OnboardingInviteStatus.Partial,
    };

    renderHost();
    act(() => {
      vi.advanceTimersByTime(INVITE_CONFIRMATION_DURATION_MS * 2);
    });

    expect(mockHostDeps.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: CONTINUE_LABEL })).not.toBeNull();
  });

  it("shows the addresses, not the confirmation, after leaving and returning", () => {
    vi.useFakeTimers();
    mockHostDeps.invite.invitedEmails = [FIRST_EMAIL];
    mockHostDeps.invite.outcome = {
      invited: 1,
      status: OnboardingInviteStatus.Sent,
    };
    const { rerender } = renderHost();
    expect(screen.getByText(`1 invitation ${INVITE_SENT_WORD}`)).not.toBeNull();

    showPhase(OnboardingPhase.DownloadDesktop);
    rerender(<HostHarness />);
    showPhase(OnboardingPhase.InviteTeam);
    rerender(<HostHarness />);

    expect(screen.queryByText(`1 invitation ${INVITE_SENT_WORD}`)).toBeNull();
    expect(screen.getByText(FIRST_EMAIL)).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(INVITE_CONFIRMATION_DURATION_MS * 2);
    });
    expect(mockHostDeps.mutate).not.toHaveBeenCalled();
  });
});

/**
 * The step's own words, copied rather than imported so a reworded string fails
 * here instead of passing with it.
 */
const SENT_TITLE = "Invitations sent";
const ASK_TITLE = "Invite people you build with";
const SENT_PITCH =
  "Your teammates have been invited. You can invite more people later.";
const SKIP_LABEL = "Skip for now";
const CONTINUE_LABEL = "Continue";
const BACK_LABEL = "Back";
const FIRST_EMAIL = "first@example.com";
const SECOND_EMAIL = "second@example.com";

function renderHost() {
  return render(<HostHarness />);
}

function HostHarness() {
  return (
    <GuidedOnboardingDialogHost
      analysisStarted={true}
      brand={<span>Closedloop.ai</span>}
      dashboardActive={false}
      desktopMode={false}
      host={OnboardingHost.Web}
      onBackFallback={vi.fn()}
      onDashboardAvailable={vi.fn()}
      organizationChosen
      organizationName="Example Organization"
      organizationSlug="example-organization"
    />
  );
}

function showPhase(phase: OnboardingPhase, teamInvited = true): void {
  mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
    data: snapshotAt(phase, teamInvited),
    isLoading: false,
  });
}

/** `teamInvited` is the persisted per-user marker, true unless a case says not. */
function snapshotAt(
  phase: OnboardingPhase,
  teamInvited: boolean
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: false,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 5,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history:
        phase === OnboardingPhase.InviteTeam
          ? [OnboardingPhase.Welcome, OnboardingPhase.CreateOrganization]
          : [
              OnboardingPhase.Welcome,
              OnboardingPhase.CreateOrganization,
              OnboardingPhase.InviteTeam,
            ],
      organizationEstablished: true,
      phase,
      resuming: false,
    }),
  };
}
