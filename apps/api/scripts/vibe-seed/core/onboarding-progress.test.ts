import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import {
  ONBOARDING_STATE_VERSION,
  OnboardingRestoreOutcome,
  restoreOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { TeamRole } from "@repo/api/src/types/teams";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import type { PrismaClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const attemptStore = vi.hoisted(() => ({
  find: vi.fn(),
  create: vi.fn(),
  compareAndSwap: vi.fn(),
}));
const onboarding = vi.hoisted(() => ({
  recordUserInvitesSent: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock("@/app/onboarding/guided/attempt-store", () => ({
  guidedOnboardingAttemptStore: attemptStore,
}));
vi.mock("@/app/onboarding/service", () => ({
  onboardingService: onboarding,
}));
vi.mock("./org-setup", () => ({
  resolveHomeTeamId: vi.fn(async () => TEAM_ID),
}));

import type { OnboardingAttemptRecord } from "@/app/onboarding/guided/attempt-store";
import type { VibeSeedContext } from "../stage";
import {
  hasTeammates,
  isRunAtRest,
  listSettlementUserIds,
  planSettledRun,
  SETTLED_RUN_STATE,
  SettledRunAction,
  settleOnboardingProgress,
} from "./onboarding-progress";

const ORG_ID = "0192f0a0-0000-7000-8000-0000000000a1";
const TEAM_ID = "0192f0a0-0000-7000-8000-0000000000c1";
const SIGNED_IN_ID = "0192f0a0-0000-7000-8000-0000000000d1";
const OWNER_ID = "0192f0a0-0000-7000-8000-0000000000d2";
const NOW = new Date("2026-10-06T12:00:00.000Z");
const EARLIER = new Date("2026-10-01T09:00:00.000Z");

const BLOCKING_STATE = {
  version: ONBOARDING_STATE_VERSION,
  phase: OnboardingPhase.Welcome,
  history: [],
  accountProvider: null,
  resuming: false,
  organizationEstablished: false,
};

function attempt(
  overrides: Partial<OnboardingAttemptRecord> = {}
): OnboardingAttemptRecord {
  return {
    id: "0192f0a0-0000-7000-8000-0000000000e1",
    experienceVariant: WorkspaceExperience.V2,
    host: OnboardingHost.Web,
    state: SETTLED_RUN_STATE,
    revision: 3,
    lastCommandId: null,
    accountSkippedAt: null,
    desktopDownloadedAt: null,
    tourCompletedAt: EARLIER,
    invitesSentAt: EARLIER,
    completedAt: EARLIER,
    createdAt: EARLIER,
    ...overrides,
  };
}

describe("SETTLED_RUN_STATE", () => {
  it("restores unchanged at Ready on every host", () => {
    for (const host of Object.values(OnboardingHost)) {
      const restored = restoreOnboardingState(SETTLED_RUN_STATE, host);
      expect(restored.outcome).toBe(OnboardingRestoreOutcome.Restored);
      expect(restored.state.phase).toBe(OnboardingPhase.Ready);
    }
    expect(isRunAtRest(SETTLED_RUN_STATE)).toBe(true);
  });

  it("does not count a blocking, resumed, or unestablished run as at rest", () => {
    expect(isRunAtRest(BLOCKING_STATE)).toBe(false);
    expect(isRunAtRest({ ...SETTLED_RUN_STATE, history: [] })).toBe(false);
    expect(
      isRunAtRest({ ...SETTLED_RUN_STATE, organizationEstablished: false })
    ).toBe(false);
    expect(isRunAtRest(null)).toBe(false);
  });
});

describe("planSettledRun", () => {
  it("creates a run with both completion markers when none exists", () => {
    expect(planSettledRun(null, NOW)).toEqual({
      action: SettledRunAction.Create,
      markers: { tourCompletedAt: NOW, completedAt: NOW },
    });
  });

  it("writes nothing for a run already at rest with both markers", () => {
    expect(planSettledRun(attempt(), NOW)).toEqual({
      action: SettledRunAction.None,
    });
  });

  it("advances a blocking run at its own revision without moving recorded markers", () => {
    expect(
      planSettledRun(
        attempt({ state: BLOCKING_STATE, completedAt: null, revision: 7 }),
        NOW
      )
    ).toEqual({
      action: SettledRunAction.Advance,
      revision: 7,
      markers: { completedAt: NOW },
    });
  });

  it("stamps a missing tour marker on a run that is otherwise at rest", () => {
    expect(planSettledRun(attempt({ tourCompletedAt: null }), NOW)).toEqual({
      action: SettledRunAction.Advance,
      revision: 3,
      markers: { tourCompletedAt: NOW },
    });
  });
});

describe("listSettlementUserIds", () => {
  it("settles the signed-in person once when they own the home team", () => {
    expect(listSettlementUserIds(SIGNED_IN_ID, SIGNED_IN_ID)).toEqual([
      SIGNED_IN_ID,
    ]);
    expect(listSettlementUserIds(SIGNED_IN_ID, null)).toEqual([SIGNED_IN_ID]);
  });

  it("settles a separate owner too", () => {
    expect(listSettlementUserIds(SIGNED_IN_ID, OWNER_ID)).toEqual([
      SIGNED_IN_ID,
      OWNER_ID,
    ]);
  });
});

describe("hasTeammates", () => {
  it("is true only past a single active member", () => {
    expect(hasTeammates(1)).toBe(false);
    expect(hasTeammates(2)).toBe(true);
  });
});

describe("settleOnboardingProgress", () => {
  const teamMemberFindFirst = vi.fn();
  const userCount = vi.fn();
  const log = vi.fn();

  function context(): VibeSeedContext {
    return {
      prisma: {
        teamMember: { findFirst: teamMemberFindFirst },
        user: { count: userCount },
      } as unknown as PrismaClient,
      organizationId: ORG_ID,
      userId: SIGNED_IN_ID,
      desktopStorePath: null,
      corpusShiftMs: 0,
      desktopAuth: null,
      now: NOW,
      log,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    onboarding.getStatus.mockResolvedValue({
      wizardCompleted: true,
      checklistDismissed: false,
      checklist: [
        { id: ChecklistItemId.InviteMembers, completed: true },
        { id: ChecklistItemId.ConnectGoogle, completed: false },
      ],
    });
  });

  it("creates each user's settled run and marks their invites when the org has teammates", async () => {
    teamMemberFindFirst.mockResolvedValue({ userId: OWNER_ID });
    userCount.mockResolvedValue(7);
    attemptStore.find
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(attempt())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(attempt());
    attemptStore.create.mockResolvedValue(attempt());

    await settleOnboardingProgress(context());

    expect(teamMemberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: TEAM_ID,
          role: TeamRole.Owner,
        }),
      })
    );
    expect(attemptStore.create).toHaveBeenCalledTimes(2);
    for (const userId of [SIGNED_IN_ID, OWNER_ID]) {
      expect(attemptStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          userId,
          state: SETTLED_RUN_STATE,
          markers: { tourCompletedAt: NOW, completedAt: NOW },
          experienceVariant: WorkspaceExperience.V2,
          host: OnboardingHost.Web,
        })
      );
      expect(onboarding.recordUserInvitesSent).toHaveBeenCalledWith(
        ORG_ID,
        userId
      );
    }
    expect(attemptStore.compareAndSwap).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain(ChecklistItemId.ConnectGoogle);
  });

  it("writes no run on a rerun and leaves invites open for a solo org", async () => {
    teamMemberFindFirst.mockResolvedValue({ userId: SIGNED_IN_ID });
    userCount.mockResolvedValue(1);
    attemptStore.find.mockResolvedValue(attempt({ invitesSentAt: null }));

    await settleOnboardingProgress(context());

    expect(attemptStore.create).not.toHaveBeenCalled();
    expect(attemptStore.compareAndSwap).not.toHaveBeenCalled();
    expect(onboarding.recordUserInvitesSent).not.toHaveBeenCalled();
  });

  it("fails the stage when the run is still unsettled after the write", async () => {
    teamMemberFindFirst.mockResolvedValue(null);
    userCount.mockResolvedValue(3);
    attemptStore.find.mockResolvedValue(
      attempt({ state: BLOCKING_STATE, completedAt: null })
    );
    attemptStore.compareAndSwap.mockResolvedValue(1);

    await expect(settleOnboardingProgress(context())).rejects.toThrow(
      "still not settled"
    );
    expect(attemptStore.compareAndSwap).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 3, markers: { completedAt: NOW } })
    );
  });
});
