import { randomUUID } from "node:crypto";
import {
  OnboardingRestoreOutcome,
  type PersistedOnboardingState,
  restoreOnboardingState,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import {
  guidedOnboardingAttemptStore,
  type OnboardingAttemptMarkers,
  type OnboardingAttemptRecord,
} from "@/app/onboarding/guided/attempt-store";
import { onboardingService } from "@/app/onboarding/service";
import type { VibeSeedContext } from "../stage";
import { homeTeamOwnerId, signedInPersonId } from "./base-seed-roster";

/**
 * ISS-12135 (bug 29): settle the guided onboarding run for the signed-in person
 * and the home team's owner, so a seeded org stops showing new-org prompts for
 * steps it has already satisfied.
 *
 * The run row is written through `guidedOnboardingAttemptStore`, the writer
 * `guidedOnboardingTransitionService.apply` itself calls. `apply` cannot be
 * loaded here: it composes a snapshot through `clerk-service`, which imports
 * `@clerk/nextjs/server`, and that fails to load outside Next (see
 * `local-trusted-identity.ts`). So the state is checked with the same
 * `restoreOnboardingState` verdict `apply` checks a posted state with, on every
 * host, before anything is written.
 *
 * The invite step goes through `onboardingService.recordUserInvitesSent`, the
 * call the invitation route makes after a send. GitHub and the Desktop download
 * are re-derived on every read (installation or grant; own compute target), and
 * the Anthropic key and Google Drive are not seeded, so none of those is written.
 */
export async function settleOnboardingProgress(
  context: VibeSeedContext
): Promise<void> {
  if (!isRunAtRest(SETTLED_RUN_STATE)) {
    throw new Error(
      "the settled onboarding run no longer restores on every host; update SETTLED_RUN_STATE to a state the machine can reach"
    );
  }
  const { organizationId } = context;
  const ownerUserId = await homeTeamOwnerId(context);
  const userIds = listSettlementUserIds(signedInPersonId(context), ownerUserId);
  const activeMemberCount = await context.prisma.user.count({
    where: { organizationId, active: true },
  });
  const summaries: string[] = [];
  for (const userId of userIds) {
    summaries.push(
      await settleUser(context, userId, hasTeammates(activeMemberCount))
    );
  }
  context.log(`onboarding progress: ${summaries.join("; ")}`);
}

/** What one user's run needs to reach {@link SETTLED_RUN_STATE}. */
export const SettledRunAction = {
  Create: "create",
  Advance: "advance",
  None: "none",
} as const;
export type SettledRunAction =
  (typeof SettledRunAction)[keyof typeof SettledRunAction];

export type SettledRunPlan =
  | {
      action: typeof SettledRunAction.Create;
      markers: OnboardingAttemptMarkers;
    }
  | {
      action: typeof SettledRunAction.Advance;
      revision: number;
      markers: OnboardingAttemptMarkers;
    }
  | { action: typeof SettledRunAction.None };

/**
 * The run at rest after the Dashboard tour: `Ready`, reached through
 * `DashboardTour` from the `DashboardAvailable` root. The tour hop is
 * load-bearing alongside `tourCompletedAt`: a stored run at `Ready` without the
 * tour marker re-arms the six-step tour (`isDashboardTourRequestedByRun`).
 */
export const SETTLED_RUN_STATE: PersistedOnboardingState =
  serializeOnboardingState({
    phase: OnboardingPhase.Ready,
    history: [
      OnboardingPhase.DashboardAvailable,
      OnboardingPhase.DashboardTour,
    ],
    accountProvider: null,
    resuming: false,
    organizationEstablished: true,
  });

/**
 * Whether a stored run state is settled on every host: restored as-is, at
 * `Ready`, outside a resumed step, with its organization established (which
 * `hasLeftGuidedTakeover` requires).
 */
export function isRunAtRest(state: unknown): boolean {
  return Object.values(OnboardingHost).every((host) => {
    const restored = restoreOnboardingState(state, host);
    return (
      restored.outcome === OnboardingRestoreOutcome.Restored &&
      restored.state.phase === OnboardingPhase.Ready &&
      !restored.state.resuming &&
      restored.state.organizationEstablished
    );
  });
}

/**
 * The write that settles `existing`, or none when it is already settled. A
 * marker the run already carries is left alone, the same write-once rule the
 * transition service's `markersFor` keeps, so a rerun never moves a recorded
 * time.
 */
export function planSettledRun(
  existing: Pick<
    OnboardingAttemptRecord,
    "state" | "revision" | "completedAt" | "tourCompletedAt"
  > | null,
  now: Date
): SettledRunPlan {
  if (existing === null) {
    return {
      action: SettledRunAction.Create,
      markers: { tourCompletedAt: now, completedAt: now },
    };
  }
  const markers: OnboardingAttemptMarkers = {};
  if (existing.tourCompletedAt === null) {
    markers.tourCompletedAt = now;
  }
  if (existing.completedAt === null) {
    markers.completedAt = now;
  }
  if (isRunAtRest(existing.state) && Object.keys(markers).length === 0) {
    return { action: SettledRunAction.None };
  }
  return {
    action: SettledRunAction.Advance,
    revision: existing.revision,
    markers,
  };
}

/** The signed-in person first, then the home team's owner when that is someone else. */
export function listSettlementUserIds(
  signedInUserId: string,
  ownerUserId: string | null
): readonly string[] {
  if (ownerUserId === null || ownerUserId === signedInUserId) {
    return [signedInUserId];
  }
  return [signedInUserId, ownerUserId];
}

/**
 * Whether the org has anyone besides one member, the only evidence the seed
 * has that invitations went out.
 */
export function hasTeammates(activeMemberCount: number): boolean {
  return activeMemberCount > 1;
}

async function settleUser(
  context: VibeSeedContext,
  userId: string,
  teammatesExist: boolean
): Promise<string> {
  const { organizationId } = context;
  const action = await settleRun(context, userId);
  if (teammatesExist) {
    await onboardingService.recordUserInvitesSent(organizationId, userId);
  }
  const run = await guidedOnboardingAttemptStore.find(organizationId, userId);
  assertSettled(userId, run, teammatesExist);
  const status = await onboardingService.getStatus(organizationId, userId);
  const open = status.checklist
    .filter((item) => !item.completed)
    .map((item) => item.id);
  return `${userId} run ${action}, invites ${teammatesExist ? "marked" : "open (no teammates)"}, checklist open [${open.join(", ")}]`;
}

async function settleRun(
  context: VibeSeedContext,
  userId: string
): Promise<SettledRunAction> {
  const { organizationId } = context;
  const existing = await guidedOnboardingAttemptStore.find(
    organizationId,
    userId
  );
  const plan = planSettledRun(existing, context.now);
  const write = {
    organizationId,
    userId,
    state: SETTLED_RUN_STATE,
    commandId: randomUUID(),
  };
  if (plan.action === SettledRunAction.Create) {
    const created = await guidedOnboardingAttemptStore.create({
      ...write,
      markers: plan.markers,
      experienceVariant: WorkspaceExperience.V2,
      host: OnboardingHost.Web,
    });
    if (created === null) {
      throw new Error(
        `onboarding run for user ${userId} was created concurrently; rerun the stage`
      );
    }
  } else if (plan.action === SettledRunAction.Advance) {
    const moved = await guidedOnboardingAttemptStore.compareAndSwap({
      ...write,
      markers: plan.markers,
      revision: plan.revision,
    });
    if (moved !== 1) {
      throw new Error(
        `onboarding run for user ${userId} moved past revision ${plan.revision} during the seed; rerun the stage`
      );
    }
  }
  return plan.action;
}

function assertSettled(
  userId: string,
  run: OnboardingAttemptRecord | null,
  teammatesExist: boolean
): void {
  const settled =
    run !== null &&
    isRunAtRest(run.state) &&
    run.completedAt !== null &&
    run.tourCompletedAt !== null &&
    (run.invitesSentAt !== null || !teammatesExist);
  if (!settled) {
    throw new Error(
      `onboarding run for user ${userId} is still not settled after the seed wrote it`
    );
  }
}
