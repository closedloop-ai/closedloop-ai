import type { JsonObject } from "@repo/api/src/types/common";
import {
  ChecklistItemId,
  type OnboardingChecklistItem,
  type OnboardingState,
  type OnboardingStatus,
} from "@repo/api/src/types/onboarding";
import { withDb } from "@repo/database";
import { z } from "zod";

/**
 * Direct download of the latest universal .dmg.
 *
 * Deliberately the PUBLIC mirror, not `closedloop-ai/symphony-alpha`: this link
 * is handed to a brand-new user who has no reason to have access to the private
 * repo, where the same URL 404s. Both repos carry the rolling `desktop-latest`
 * tag with an unversioned asset name, so the URL always resolves to the newest
 * build without a release-time edit here.
 */
export const DESKTOP_LATEST_DMG_URL =
  "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop-universal.dmg";

const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  wizardCompletedAt: null,
  wizardCompletedBy: null,
  checklistDismissedAt: null,
  createdTeamId: null,
  createdProjectId: null,
};

const onboardingStateSchema = z.object({
  wizardCompletedAt: z.string().nullable().default(null),
  wizardCompletedBy: z.string().nullable().default(null),
  checklistDismissedAt: z.string().nullable().default(null),
  createdTeamId: z.string().nullable().default(null),
  createdProjectId: z.string().nullable().default(null),
});

/**
 * Safely extract onboarding state from Organization.settings JSON blob.
 */
function getOnboardingState(settings: JsonObject): OnboardingState {
  const result = onboardingStateSchema.safeParse(settings.onboarding);
  if (!result.success) {
    return { ...DEFAULT_ONBOARDING_STATE };
  }
  return result.data;
}

/**
 * Merge onboarding state back into the Organization.settings JSON blob.
 */
function mergeOnboardingState(
  settings: JsonObject,
  state: Partial<OnboardingState>
): JsonObject {
  const current = getOnboardingState(settings);
  return {
    ...settings,
    onboarding: { ...current, ...state },
  };
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
        select: {
          settings: true,
          claudeApiKeyEncrypted: true,
        },
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
      googleIntegration,
      userCount,
    ] = await Promise.all([
      withDb((db) => db.team.count({ where: { organizationId } })),
      withDb((db) =>
        db.project.count({
          where: { organizationId },
        })
      ),
      // A real desktop install registers a compute target. The synthetic
      // per-org "cloud" target owns cloud-authored agent components and has no
      // device behind it, so counting it would tick this item for an org that
      // has never installed anything.
      //
      // Scoped to the CALLER, unlike every other row here. The rest describe
      // the workspace — it has a team, a GitHub installation, more than one
      // member — and are true for everyone once they are true for anyone. This
      // one asks the reader to install an app on their own machine, and it is
      // the only surface in the product still pointing at the download, so an
      // org-wide check would hand a pre-ticked row and no link to every teammate
      // who joined after the first install.
      withDb((db) =>
        db.computeTarget.findFirst({
          where: { organizationId, userId, isCloudSentinel: false },
          select: { id: true },
        })
      ),
      withDb((db) =>
        db.gitHubInstallation.findFirst({
          where: { organizationId, status: { in: ["ACTIVE", "SUSPENDED"] } },
          select: { id: true },
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
    ]);

    const hasAnthropicKey = !!org?.claudeApiKeyEncrypted;

    // Legacy orgs: if no wizard record but org already has teams+projects, treat as completed
    const wizardCompleted =
      state.wizardCompletedAt !== null || (teamCount > 0 && projectCount > 0);

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
      // nowhere. (Moot in practice — the checklist only renders once the wizard
      // is complete, which requires a project, so this row is always ticked.)
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
        href: DESKTOP_LATEST_DMG_URL,
        external: true,
      },
      {
        id: ChecklistItemId.ConnectGitHub,
        label: "Connect GitHub",
        description: "Link your repositories for code management",
        completed: githubInstallation !== null,
        href: "/settings?tab=integrations",
      },
      {
        id: ChecklistItemId.AddAnthropicKey,
        label: "Add Anthropic API key",
        description: "Required for AI-powered workflows",
        completed: hasAnthropicKey,
        href: "/settings?tab=integrations",
      },
      {
        id: ChecklistItemId.ConnectGoogle,
        label: "Connect Google Drive",
        description: "Import documents and collaborate on files",
        completed: googleIntegration !== null,
        href: "/settings?tab=integrations",
      },
      {
        id: ChecklistItemId.InviteMembers,
        label: "Invite team members",
        description: "Add colleagues to your organization",
        completed: userCount > 1,
        href: "/settings?tab=organization#/organization-members",
      },
    ];

    return {
      wizardCompleted,
      checklistDismissed: state.checklistDismissedAt !== null,
      checklist,
    };
  },

  async completeWizard(
    organizationId: string,
    userId: string,
    createdTeamId?: string,
    createdProjectId?: string
  ): Promise<OnboardingStatus> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { settings: true },
      })
    );

    const settings = (org?.settings as JsonObject) ?? {};
    const updatedSettings = mergeOnboardingState(settings, {
      wizardCompletedAt: new Date().toISOString(),
      wizardCompletedBy: userId,
      createdTeamId: createdTeamId ?? null,
      createdProjectId: createdProjectId ?? null,
    });

    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { settings: updatedSettings },
      })
    );

    return onboardingService.getStatus(organizationId, userId);
  },

  async dismissChecklist(
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
    const updatedSettings = mergeOnboardingState(settings, {
      checklistDismissedAt: new Date().toISOString(),
    });

    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { settings: updatedSettings },
      })
    );

    return onboardingService.getStatus(organizationId, userId);
  },
};
