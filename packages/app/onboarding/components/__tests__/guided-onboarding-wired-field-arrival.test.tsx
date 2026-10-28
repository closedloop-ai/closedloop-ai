// @vitest-environment jsdom

/**
 * ISS-11147 — the retired register entries reach the SCREEN, not just a fold.
 *
 * `../../lib/__tests__/guided-onboarding-unwired-register.test.ts` proves each
 * retired field has a production producer that yields a value. tamsinb's review
 * caught what that leaves open: every probe there calls a fold function on
 * inputs the file builds, and none of them touches the host, so deleting
 * `members={members}` from `guided-onboarding-dialog-host.tsx` costs a field its
 * only route to the user and that suite stays green.
 *
 * This is the other end of the same claim. It renders the REAL shared host and
 * stubs only the reads below it — the roster query for `members.*`, the phase
 * snapshot for the run — so the host's own prop hop, the dialog's, and the
 * step's rendering are all production code. Delete the prop and the sentence
 * the roster produced stops appearing.
 *
 * `discovery.*` is covered here for the SHARED host's hop only. The desktop
 * host's `discovery={discovery.discovery}` is a second hop in `apps/desktop`
 * and is not reachable from this package, exactly as `account.email` is not;
 * the register test names both absences rather than implying coverage.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
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
import type { User } from "@repo/api/src/types/user";
import { ApproverRole } from "@repo/api/src/types/user";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  foldOnboardingSessionDiscovery,
  OnboardingEnumerationQuality,
} from "../../lib/onboarding-session-discovery";
import {
  IDLE_INVITE_OUTCOME,
  OnboardingAnalysisEstimateStatus,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";

const SIGNER_ID = "user-signer";
const TEAMMATE_ID = "user-teammate";
const SECOND_TEAMMATE_ID = "user-second-teammate";
const TEAMMATE_NAME = "Given Teammate";
const HARNESS = "claude";
const FOUND_SESSIONS = 41;
const ANALYZED_SESSIONS = 17;
const LOG_BYTES = 1_234_567;
const REMAINING_MINUTES = 9;

/**
 * Deliberate copies of the step's own words rather than imports of the strings
 * under test: importing them would let either wording pass. The numbers in them
 * are the folded roster's and the folded inventory's, so a host that stopped
 * handing the field down renders the claim-free copy instead and fails here.
 */
const ROSTER_PITCH =
  "2 people at your company already use Closedloop. Invite anyone missing so your team can learn from the same playbook.";
const CLAIM_FREE_PITCH =
  "Teams learn agentic coding faster together. Invite people you trust to compare workflows and share what works.";
/**
 * The running-scan sentence, copied from the step rather than imported. It
 * renders only when BOTH `logBytes` and `sessionsFound` arrived — either one
 * missing takes the awaiting-scan copy instead — so its presence pins two of
 * the four retired `discovery.*` fields, and the count pins which value.
 */
const DISCOVERY_SENTENCE = /We found .+ of logs across 41 local sessions\./;
const AWAITING_SCAN =
  "Session counts, sizes, and the time estimate will appear here once the scan reports them. You can start using Closedloop in the meantime.";

const mockHostDeps = vi.hoisted(() => ({
  currentUser: undefined as unknown,
  organizationUsers: undefined as unknown,
  mutate: vi.fn(),
  useGuidedOnboardingSnapshot: vi.fn(),
}));

// Behind `useDesktopAppRunning`: these suites mount the host with no provider.
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
  useOnboardingInviteTeam: () => ({
    invite: vi.fn(),
    invitedEmails: [],
    outcome: IDLE_INVITE_OUTCOME,
  }),
}));

// The ROSTER READ, not the fold above it: `useOnboardingOrganizationMembers`,
// `foldOnboardingOrganizationMembers`, and the host's `members={members}` all
// stay production code, which is the whole point of this file.
vi.mock("../../../users/hooks/use-users", () => ({
  useCurrentUser: () => mockHostDeps.currentUser,
  useOrganizationUsers: () => mockHostDeps.organizationUsers,
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
  mockHostDeps.currentUser = { data: makeUser(SIGNER_ID, "Given Signer") };
  mockHostDeps.organizationUsers = {
    data: [
      makeUser(SIGNER_ID, "Given Signer"),
      makeUser(TEAMMATE_ID, TEAMMATE_NAME),
      makeUser(SECOND_TEAMMATE_ID, "Given Colleague"),
    ],
    isError: false,
  };
});

describe("retired register fields, arrival on screen", () => {
  it("renders the folded roster the host handed the invite step", () => {
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshotAt(OnboardingPhase.InviteTeam),
      isLoading: false,
    });

    renderHost();

    expect(screen.getByText(ROSTER_PITCH)).not.toBeNull();
    expect(screen.getByText(TEAMMATE_NAME)).not.toBeNull();
    expect(screen.queryByText(CLAIM_FREE_PITCH)).toBeNull();
  });

  /**
   * The paired control for the case above. Without it, a host that stopped
   * passing `members` would be indistinguishable from one whose roster read had
   * not settled, and the absence assertion there would pass for the wrong
   * reason — it reads the same locator this case proves can match.
   */
  it("makes no roster claim while the read has not settled", () => {
    mockHostDeps.organizationUsers = { data: undefined, isError: false };
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshotAt(OnboardingPhase.InviteTeam),
      isLoading: false,
    });

    renderHost();

    expect(screen.getByText(CLAIM_FREE_PITCH)).not.toBeNull();
    expect(screen.queryByText(ROSTER_PITCH)).toBeNull();
    expect(screen.queryByText(TEAMMATE_NAME)).toBeNull();
  });

  it("renders the folded discovery the host handed the analysis step", () => {
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshotAt(OnboardingPhase.SessionDiscovery),
      isLoading: false,
    });

    // Session Discovery is a DESKTOP-only phase, so the shared host must be
    // mounted as the desktop shell mounts it or the run restores to Welcome.
    renderHost({
      desktopMode: true,
      discovery: measuredDiscovery(),
      host: OnboardingHost.Desktop,
    });

    expect(screen.getByText(DISCOVERY_SENTENCE)).not.toBeNull();
    expect(screen.queryByText(AWAITING_SCAN)).toBeNull();
  });

  /** Same pairing: the locator above must be one an absent field can miss. */
  it("states no session count when the host hands down no discovery", () => {
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshotAt(OnboardingPhase.SessionDiscovery),
      isLoading: false,
    });

    renderHost({ desktopMode: true, host: OnboardingHost.Desktop });

    expect(screen.getByText(AWAITING_SCAN)).not.toBeNull();
    expect(screen.queryByText(DISCOVERY_SENTENCE)).toBeNull();
  });
});

function renderHost(
  props: Partial<ComponentProps<typeof GuidedOnboardingDialogHost>> = {}
) {
  return render(
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
      {...props}
    />
  );
}

/** The production discovery fold over one host's measurements. */
function measuredDiscovery() {
  return foldOnboardingSessionDiscovery({
    absent: [],
    analyzed: [{ harness: HARNESS, sessions: ANALYZED_SESSIONS }],
    bytes: null,
    estimate: {
      remainingMinutes: REMAINING_MINUTES,
      status: OnboardingAnalysisEstimateStatus.Measured,
    },
    found: [{ harness: HARNESS, sessions: FOUND_SESSIONS }],
    label: (harness: string) => `Label:${harness}`,
    logBytes: LOG_BYTES,
    quality: OnboardingEnumerationQuality.Whole,
  }).discovery;
}

function snapshotAt(phase: OnboardingPhase): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 5,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history: historyTo(phase),
      organizationEstablished: true,
      phase,
      resuming: false,
    }),
  };
}

/** A chain the machine could actually have walked to `phase`. */
function historyTo(phase: OnboardingPhase): OnboardingPhase[] {
  if (phase === OnboardingPhase.InviteTeam) {
    return [OnboardingPhase.Welcome, OnboardingPhase.CreateOrganization];
  }
  return [OnboardingPhase.Welcome];
}

function makeUser(id: string, firstName: string): User {
  return {
    active: true,
    avatarUrl: null,
    clerkId: `clerk-${id}`,
    createdAt: new Date("2025-06-01"),
    email: `${id}@example.com`,
    firstName,
    githubUsername: null,
    id,
    lastName: null,
    linearId: null,
    organizationId: "org-1",
    phoneNumber: null,
    role: ApproverRole.Engineer,
    slackId: null,
    updatedAt: new Date("2025-06-01"),
  };
}
