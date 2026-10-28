import type { JsonObject } from "@repo/api/src/types/common";
import {
  buildDesktopReleaseChannelPageUrl,
  DesktopPublicMirrorRepo,
} from "@repo/api/src/types/desktop-release";
import {
  ChecklistItemId,
  type OnboardingChecklistItem,
  type OnboardingState,
  type OnboardingStatus,
} from "@repo/api/src/types/onboarding";
import {
  OnboardingRestoreOutcome,
  restoreOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  isBlockingPhase,
  OnboardingHost,
} from "@repo/api/src/types/onboarding-phase";
import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { buildSettingsPanelRoute } from "@repo/api/src/types/settings-route-links";
import { GitHubInstallationStatus, Prisma, withDb } from "@repo/database";
import { z } from "zod";
import { resolveGitHubDataConnectionStatus } from "@/app/integrations/github/data-connection-status";
import { writeOrganizationSettings } from "@/lib/organization-settings-write";
import {
  mapRecordedWrite,
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import {
  guidedOnboardingAttemptStore,
  type OnboardingAttemptRecord,
} from "./guided/attempt-store";
import type { OnboardingWrite } from "./onboarding-receipt";

/** Key under which onboarding state lives in the `Organization.settings` blob. */
export const ONBOARDING_SETTINGS_KEY = "onboarding";

/**
 * The download channel's release PAGE, which is platform-neutral by
 * construction — not a direct asset link (ISS-9708).
 *
 * This row is built where the reader's platform is not knowable, so any
 * per-platform asset URL here is a guess: it used to be the macOS `.dmg` for
 * every visitor, which handed a Windows or Linux reader a one-click download of
 * an artifact their machine cannot run. A client-side correction cannot close
 * that hole either, because the row renders before PostHog's anonymous bootstrap
 * has resolved the signed-in user's flags — so the fix is to stop asserting a
 * platform in the payload at all. The page lists whatever assets the channel
 * actually carries, which is correct for every reader in every flag state and
 * needs no timing to work out.
 *
 * Deliberately the PUBLIC mirror, not `closedloop-ai/closedloop-ai`: this link
 * is handed to a brand-new user who has no reason to have access to the private
 * repo, where the same page 404s. The channel tag is rolling, so the URL always
 * resolves to the newest build without a release-time edit here.
 */
export const DESKTOP_LATEST_RELEASE_PAGE_URL =
  buildDesktopReleaseChannelPageUrl(DesktopPublicMirrorRepo);

const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  wizardCompletedAt: null,
  wizardCompletedBy: null,
  checklistDismissedAt: null,
  createdTeamId: null,
  createdProjectId: null,
  invitesSentAt: null,
};

const onboardingStateSchema = z.object({
  wizardCompletedAt: z.string().nullable().default(null),
  wizardCompletedBy: z.string().nullable().default(null),
  // Legacy. ISS-5991 moved checklist dismissal to User.onboardingChecklistDismissedAt
  // and backfilled this org-wide value onto every member; nothing reads or writes
  // it here any more, but historical settings blobs still carry it.
  checklistDismissedAt: z.string().nullable().default(null),
  createdTeamId: z.string().nullable().default(null),
  createdProjectId: z.string().nullable().default(null),
  invitesSentAt: z.string().nullable().default(null),
});

/**
 * Safely extract onboarding state from Organization.settings JSON blob.
 */
export function getOnboardingState(settings: JsonObject): OnboardingState {
  const result = onboardingStateSchema.safeParse(
    settings[ONBOARDING_SETTINGS_KEY]
  );
  if (!result.success) {
    return { ...DEFAULT_ONBOARDING_STATE };
  }
  return result.data;
}

/**
 * Onboarding service — reads/writes onboarding state from Organization.settings,
 * computes checklist completion from actual DB data.
 */
export const onboardingService = {
  async getStatus(
    organizationId: string,
    userId: string
  ): Promise<OnboardingStatus> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { settings: true },
      })
    );

    const settings = (org?.settings as JsonObject) ?? {};
    const state = getOnboardingState(settings);

    // Run checks in parallel for performance
    const [
      teamCount,
      projectCount,
      desktopComputeTarget,
      githubInstallation,
      githubDataConnection,
      googleIntegration,
      userCount,
      caller,
      guidedAttempt,
    ] = await Promise.all([
      withDb((db) => db.team.count({ where: { organizationId } })),
      withDb((db) =>
        db.project.count({
          where: { organizationId },
        })
      ),
      // Scoped to the CALLER, unlike every other row here — see the builder for
      // why. The rest describe the workspace and are true for everyone once
      // they are true for anyone; this row is also the only surface in the
      // product still pointing at the download, so an org-wide check would hand
      // a pre-ticked row and no link to every teammate who joined after the
      // first install.
      withDb((db) =>
        db.computeTarget.findFirst({
          where: ownDesktopComputeTargetWhere(organizationId, userId),
          select: { id: true },
        })
      ),
      withDb((db) =>
        db.gitHubInstallation.findFirst({
          where: connectedGitHubInstallationWhere(organizationId),
          select: { id: true },
        })
      ),
      // `hasActiveInstallation: false` for the same reason as the guided
      // snapshot: the sibling installation read above is strictly wider and is
      // ORed with this, so re-running it here would only cost a pooled
      // connection on a read that runs on every authenticated page.
      withDb((db) =>
        resolveGitHubDataConnectionStatus(db, {
          hasActiveInstallation: false,
          organizationId,
          userId,
        })
      ),
      withDb((db) =>
        db.googleIntegration.findUnique({
          where: { organizationId },
          select: { id: true },
        })
      ),
      withDb((db) =>
        db.user.count({ where: { organizationId, active: true } })
      ),
      withDb((db) =>
        db.user.findFirst({
          where: { id: userId, organizationId },
          select: { onboardingChecklistDismissedAt: true },
        })
      ),
      guidedOnboardingAttemptStore.find(organizationId, userId),
    ]);

    const wizardCompleted =
      isOnboardingWizardCompleted({
        projectCount,
        state,
        teamCount,
      }) || hasLeftGuidedTakeover(guidedAttempt);

    const checklist: OnboardingChecklistItem[] = [
      {
        id: ChecklistItemId.CreateTeam,
        label: "Create a team",
        description: "Set up your first team to organize projects",
        completed: teamCount > 0,
        href: "/settings",
      },
      // No href: projects are created at /teams/<teamId>/projects, and there is
      // no org-level projects route to send someone to without a team id this
      // service does not have. A row whose job is "here is the next thing to do"
      // is worse for pointing at a page that cannot do it than for pointing
      // nowhere. A finished guided run completes onboarding without a project
      // (see `hasLeftGuidedTakeover`), so this row can render unticked.
      {
        id: ChecklistItemId.CreateProject,
        label: "Create a project",
        description: "Start your first project within a team",
        completed: projectCount > 0,
      },
      {
        id: ChecklistItemId.DownloadDesktop,
        label: "Download the desktop app",
        description:
          "Install Closedloop Desktop to analyze your agent sessions",
        completed: desktopComputeTarget !== null,
        href: DESKTOP_LATEST_RELEASE_PAGE_URL,
        external: true,
      },
      {
        id: ChecklistItemId.ConnectGitHub,
        label: "Connect GitHub",
        description: "Link your repositories for code management",
        completed: isOnboardingGitHubConnected({
          githubDataConnected: githubDataConnection.connected,
          hasConnectedInstallation: githubInstallation !== null,
        }),
        href: buildSettingsPanelRoute({ panel: SettingsPanelId.Profile }),
      },
      {
        id: ChecklistItemId.ConnectGoogle,
        label: "Connect Google Drive",
        description: "Import documents and collaborate on files",
        completed: googleIntegration !== null,
        href: buildSettingsPanelRoute({ panel: SettingsPanelId.Plugins }),
      },
      {
        id: ChecklistItemId.InviteMembers,
        label: "Invite team members",
        description: "Add colleagues to your organization",
        completed: isTeamInvited(userCount, settings),
        href: "/settings?tab=organization#/organization-members",
      },
    ];

    return {
      wizardCompleted,
      checklistDismissed: caller?.onboardingChecklistDismissedAt != null,
      checklist,
    };
  },

  async completeWizard(
    organizationId: string,
    userId: string,
    createdTeamId?: string,
    createdProjectId?: string,
    recordWrite?: RecordWriteInTransaction<OnboardingWrite>
  ): Promise<OnboardingStatus> {
    const patch: Partial<OnboardingState> = {
      wizardCompletedAt: new Date().toISOString(),
      wizardCompletedBy: userId,
      createdTeamId: createdTeamId ?? null,
      createdProjectId: createdProjectId ?? null,
    };

    // ISS-7142: the row-count judgment moved into the shared writer, which
    // keeps the throw-on-zero this path already had (the route funnels a throw
    // into the same 500 the previous P2025 produced) and adds the refusal for
    // a predicate widened past this organization.
    await writeOrganizationSettings(
      buildOnboardingStatePatch(organizationId, patch),
      { organizationId, subject: COMPLETE_WIZARD_WRITE_SUBJECT },
      mapRecordedWrite<void, OnboardingWrite>(recordWrite, () => ({
        changed: true,
      }))
    );

    return onboardingService.getStatus(organizationId, userId);
  },

  /**
   * ISS-5991: scoped to the caller, not the org. The checklist is a personal
   * to-do prompt, so an org-wide dismissal took it away from every teammate.
   */
  async dismissChecklist(
    organizationId: string,
    userId: string,
    recordWrite?: RecordWriteInTransaction<OnboardingWrite>
  ): Promise<OnboardingStatus> {
    // Org-scoped by `updateMany` rather than `update`: the tenant guard belongs
    // in the `where` clause (apps/api/AGENTS.md), and `update` only accepts a
    // unique selector.
    await writeRecorded(
      recordWrite,
      () =>
        withDb((db) =>
          db.user.updateMany({
            where: { id: userId, organizationId },
            data: { onboardingChecklistDismissedAt: new Date() },
          })
        ),
      ({ count }) => ({ changed: count > 0 })
    );

    return onboardingService.getStatus(organizationId, userId);
  },

  /**
   * Record that this org has sent invitations, so the checklist's invite row
   * completes on the send rather than on the invitee's acceptance.
   *
   * A timestamp in the org's own settings rather than a live read of Clerk's
   * pending-invitation list: `getStatus` runs on every authenticated page and
   * again on every window focus, and is otherwise entirely local.
   */
  async recordInvitesSent(organizationId: string): Promise<void> {
    await writeOrganizationSettings(
      buildOnboardingStatePatch(organizationId, {
        invitesSentAt: new Date().toISOString(),
      }),
      { organizationId, subject: RECORD_INVITES_SENT_WRITE_SUBJECT }
    );
  },

  /**
   * Record that THIS user sent invitations, which is what completes the guided
   * run's invite step (ISS-11670).
   *
   * The per-user counterpart to {@link onboardingService.recordInvitesSent}
   * above, written on the same send and gated on the same `invited > 0`. The
   * two are not redundant: that one answers whether the ORGANIZATION has ever
   * invited anyone, which the v1 checklist row asks, and this one answers
   * whether this reader has, which the guided invite step asks.
   */
  async recordUserInvitesSent(
    organizationId: string,
    userId: string
  ): Promise<void> {
    await guidedOnboardingAttemptStore.markInvitesSent({
      organizationId,
      userId,
    });
  },
};

/**
 * ISS-7092: patch onboarding fields into `settings->'onboarding'` in ONE
 * statement (mirrors `frustration-setting-service`), rather than reading the
 * whole `settings` blob into JS, merging, and writing it back.
 *
 * The old read-modify-write silently clobbered any concurrent write to an
 * unrelated `settings` key — last writer won over the entire blob, with no
 * error and nothing in a log. Here every read of `settings` happens inside the
 * same UPDATE, on the row Postgres has already locked, so there is no window
 * between the read and the write for another writer to land in:
 *
 *   - `jsonb_set(..., ARRAY['onboarding'], ..., true)` rewrites only that one
 *     top-level key, so a sibling key (`calculateSessionFrustration`, …) is
 *     carried through untouched; and
 *   - `<existing onboarding> || <patch>` merges at the sub-key level, so a
 *     sub-key this call does not set (the legacy `checklistDismissedAt`)
 *     survives too.
 *
 * The `jsonb_typeof` guard keeps the pre-existing tolerance for a malformed
 * blob: `||` errors when its left side is a JSON scalar, and `getOnboardingState`
 * already treats a non-object `onboarding` value as absent, so a corrupt value
 * is replaced by the patch instead of failing the request.
 *
 * ISS-7157: `updated_at` is set by the statement because a raw UPDATE never
 * reaches the Prisma client layer that applies `@updatedAt`, and set through
 * `GREATEST` so a delayed write cannot put its older captured time back. The
 * bound value is a FLOOR — the shared writer raises it to a reading taken after
 * this statement took the row lock. See `writeOrganizationSettings`.
 */
function buildOnboardingStatePatch(
  organizationId: string,
  patch: Partial<OnboardingState>
): Prisma.Sql {
  const existing = Prisma.sql`COALESCE("settings", '{}'::jsonb)`;
  const existingOnboarding = Prisma.sql`${existing} -> ${ONBOARDING_SETTINGS_KEY}`;
  return Prisma.sql`
    UPDATE "organizations"
    SET "settings" = jsonb_set(
      ${existing},
      ARRAY[${ONBOARDING_SETTINGS_KEY}]::text[],
      CASE
        WHEN jsonb_typeof(${existingOnboarding}) = 'object'
          THEN ${existingOnboarding}
        ELSE '{}'::jsonb
      END || ${JSON.stringify(patch)}::jsonb,
      true
    ),
    "updated_at" = GREATEST("updated_at", ${new Date()})
    WHERE "id" = ${organizationId}::uuid
  `;
}

/**
 * Whether this organization has invited anyone yet.
 *
 * Sending the invitation is the act the checklist row asks for, and it is done
 * the moment it is sent — accepting is the invitee's move, on their own clock,
 * and can take days. Keying on the member count alone left the row unticked in
 * front of the admin who had just invited someone. `invitesSentAt` is the org's
 * own record of that send; the member count still ticks the row for an org that
 * grew before it existed.
 *
 * ORG-SCOPED, AND ONLY THE V1 CHECKLIST ROW MAY READ IT. The guided snapshot
 * shared this predicate until ISS-11670, on the reasoning that one function
 * cannot drift where two expressions can. What that shared answer could not
 * survive is that the two surfaces ask different questions: this row asks
 * whether the ORGANIZATION has invited anyone, and the guided invite step asks
 * whether THIS READER has — so an org that already had two members granted the
 * step to every one of them, which rendered as "Your teammates have been
 * invited" over a hidden composer and, through `isStepOutstanding`, skipped the
 * step outright.
 *
 * The operator ruled on 2026-09-30 that each new user is prompted regardless of
 * what the rest of the org has done. `buildServerContext` therefore reads the
 * per-user `invitesSentAt` marker on the run instead, and this function keeps
 * answering the org question for the checklist, where the org answer is the
 * right one. Do not re-point the guided snapshot at it.
 */
export function isTeamInvited(
  activeUserCount: number,
  settings: JsonObject
): boolean {
  return (
    activeUserCount > 1 || getOnboardingState(settings).invitesSentAt !== null
  );
}

/**
 * The GitHub installations that still let the app act for an organization, as a
 * ready-made `where`.
 *
 * `SUSPENDED` counts alongside `ACTIVE` because a suspended installation is
 * still connected — it is re-enabled, not re-installed — so asking the user to
 * connect again would be wrong.
 *
 * One builder rather than the same predicate in two places, for the same reason
 * as {@link isTeamInvited}: the v1 checklist's `ConnectGitHub` row and the
 * ISS-8375 guided snapshot's `githubConnected` guard input must answer
 * identically, and a re-derivation could drift without either surface failing a
 * test.
 *
 * Since ISS-11246 this builder is ONE of the two terms rather than the whole
 * answer. Both surfaces OR it with the caller's own usable GitHub grant, and
 * {@link isOnboardingGitHubConnected} is where "must answer identically" now
 * lives.
 */
export function connectedGitHubInstallationWhere(
  organizationId: string
): Prisma.GitHubInstallationWhereInput {
  return {
    organizationId,
    status: {
      in: [GitHubInstallationStatus.ACTIVE, GitHubInstallationStatus.SUSPENDED],
    },
  };
}

/**
 * The caller's OWN registered desktop, as a ready-made `where`.
 *
 * Two filters, two reasons. `isCloudSentinel: false` because the synthetic
 * per-org cloud target has no device behind it, so counting it would report an
 * install for an org that has never installed anything. `userId` because
 * installing is a per-person act: this step asks THIS reader to put an app on
 * their own machine, so a teammate's install must not answer it for them.
 *
 * Shared between the v1 checklist's `DownloadDesktop` row and the ISS-8375
 * guided snapshot's `desktopAppDownloaded` guard input, for the same
 * anti-drift reason as {@link connectedGitHubInstallationWhere}.
 */
export function ownDesktopComputeTargetWhere(
  organizationId: string,
  userId: string
): Prisma.ComputeTargetWhereInput {
  return { organizationId, userId, isCloudSentinel: false };
}

/** Names this writer in the shared row-count guard's messages. */
export const COMPLETE_WIZARD_WRITE_SUBJECT = "Onboarding wizard completion";

/** Names this writer in the shared row-count guard's messages. */
export const RECORD_INVITES_SENT_WRITE_SUBJECT =
  "Onboarding invites-sent marker";

/**
 * Whether this organization's onboarding completion is RECORDED — the marker
 * {@link onboardingService.completeWizard} writes, and the only positive answer
 * here that came from watching someone finish.
 *
 * Split out of {@link isOnboardingWizardCompleted} by ISS-10339 because its two
 * arms are not interchangeable evidence, and one caller can only admit this
 * one. See that predicate for the inferred arm.
 */
export function isOnboardingWizardRecorded(state: OnboardingState): boolean {
  return state.wizardCompletedAt !== null;
}

/**
 * Whether this organization has already finished onboarding, by record or by
 * inference.
 *
 * The teams-and-projects arm is not a shortcut for the marker: organizations
 * that predate the wizard record carry no `wizardCompletedAt` and are still
 * demonstrably onboarded, so a predicate reading only the marker would treat
 * every one of them as a first run.
 *
 * IT IS AN INFERENCE, NOT A RECORD, and only an organization that could never
 * have carried the marker is entitled to it. Any organization holding a team
 * and a project satisfies it, including one that never saw onboarding at all,
 * so the ISS-8375 guided snapshot admits this arm only for an organization
 * created before the guided wizard shipped and falls back to
 * {@link isOnboardingWizardRecorded} for the rest (ISS-10339).
 *
 * Shared with that snapshot, which uses it to decide that an already-onboarded
 * account is not on a first run (ISS-9916). Exported rather than restated there
 * because the legacy arm is exactly the part a second copy would drop.
 */
export function isOnboardingWizardCompleted(inputs: {
  projectCount: number;
  state: OnboardingState;
  teamCount: number;
}): boolean {
  return (
    isOnboardingWizardRecorded(inputs.state) ||
    (inputs.teamCount > 0 && inputs.projectCount > 0)
  );
}

/**
 * Whether the caller's own guided run has left its blocking takeover with an
 * organization established — the moment the web host hands off to the
 * Dashboard, and so the moment `OnboardingGuard` must stop routing this reader
 * to `/onboarding` (ISS-10988). A step resumed from the completion card counts:
 * resuming is only entered from a finished run.
 *
 * Per caller, like the run it reads. It grants nothing to a teammate, so it is
 * deliberately NOT written into the organization's `wizardCompletedAt`, which
 * the guided snapshot also folds every member's first run on.
 *
 * `/onboarding/status` is asked from no particular surface, so the run counts
 * if either host can restore it; a recovered payload restores to a fresh run
 * and never counts.
 */
export function hasLeftGuidedTakeover(
  attempt: OnboardingAttemptRecord | null
): boolean {
  if (!attempt) {
    return false;
  }
  return Object.values(OnboardingHost).some((host) => {
    const restored = restoreOnboardingState(attempt.state, host);
    return (
      restored.outcome === OnboardingRestoreOutcome.Restored &&
      restored.state.organizationEstablished &&
      (restored.state.resuming || !isBlockingPhase(restored.state.phase))
    );
  });
}

/**
 * Whether onboarding should report GitHub connected, folded from the two facts
 * that can make it true.
 *
 * ISS-11246: an installation-only answer is a completion test the offered
 * action cannot pass. The only control either surface opens — the guided
 * step's CTA and this checklist row's Settings link — authorizes a PERSONAL
 * Clerk OAuth grant; installing the App org-wide is deliberately an admin
 * action (`github-connect-action.ts`). So a reader who does exactly what the
 * row asks never ticks it, and it is offered again forever.
 *
 * Strictly widening: the installation term is kept because the two reads
 * disagree on status — {@link connectedGitHubInstallationWhere} admits
 * SUSPENDED, the data-connection read admits only ACTIVE — so dropping it
 * would narrow a suspended-installation org. The grant term is the CALLER's
 * own usable grant and nothing else: `resolveGitHubDataConnectionStatus`
 * scopes it to `(organizationId, userId)` and rejects a revoked grant or one
 * without `repo` scope, so one member's grant cannot finish the step for the
 * rest of the org.
 */
export function isOnboardingGitHubConnected({
  githubDataConnected,
  hasConnectedInstallation,
}: {
  githubDataConnected: boolean;
  hasConnectedInstallation: boolean;
}): boolean {
  return hasConnectedInstallation || githubDataConnected;
}
