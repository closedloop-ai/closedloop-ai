import type { JsonObject } from "@repo/api/src/types/common";
import type {
  OnboardingChecklistItem,
  OnboardingState,
  OnboardingStatus,
} from "@repo/api/src/types/onboarding";
import { withDb } from "@repo/database";

const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  wizardCompletedAt: null,
  wizardCompletedBy: null,
  checklistDismissedAt: null,
  createdTeamId: null,
  createdProjectId: null,
};

/**
 * Safely extract onboarding state from Organization.settings JSON blob.
 */
function getOnboardingState(settings: JsonObject): OnboardingState {
  const raw = settings.onboarding;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_ONBOARDING_STATE };
  }
  const obj = raw as JsonObject;
  return {
    wizardCompletedAt:
      typeof obj.wizardCompletedAt === "string" ? obj.wizardCompletedAt : null,
    wizardCompletedBy:
      typeof obj.wizardCompletedBy === "string" ? obj.wizardCompletedBy : null,
    checklistDismissedAt:
      typeof obj.checklistDismissedAt === "string"
        ? obj.checklistDismissedAt
        : null,
    createdTeamId:
      typeof obj.createdTeamId === "string" ? obj.createdTeamId : null,
    createdProjectId:
      typeof obj.createdProjectId === "string" ? obj.createdProjectId : null,
  };
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
  async getStatus(organizationId: string): Promise<OnboardingStatus> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: {
          settings: true,
          claudeApiKeyEncrypted: true,
          anthropicApiKey: true,
        },
      })
    );

    const settings = (org?.settings as JsonObject) ?? {};
    const state = getOnboardingState(settings);

    // Run checks in parallel for performance
    const [
      teamCount,
      projectCount,
      githubInstallation,
      linearIntegration,
      googleIntegration,
      userCount,
    ] = await Promise.all([
      withDb((db) => db.team.count({ where: { organizationId } })),
      withDb((db) =>
        db.project.count({
          where: {
            teams: { some: { team: { organizationId } } },
          },
        })
      ),
      withDb((db) =>
        db.gitHubInstallation.findFirst({
          where: { organizationId, status: { in: ["ACTIVE", "SUSPENDED"] } },
          select: { id: true },
        })
      ),
      withDb((db) =>
        db.linearIntegration.findUnique({
          where: { organizationId },
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

    const hasAnthropicKey =
      !!org?.claudeApiKeyEncrypted || !!org?.anthropicApiKey;

    const checklist: OnboardingChecklistItem[] = [
      {
        id: "create-team",
        label: "Create a team",
        description: "Set up your first team to organize projects",
        completed: teamCount > 0,
        href: "/settings",
      },
      {
        id: "create-project",
        label: "Create a project",
        description: "Start your first project within a team",
        completed: projectCount > 0,
      },
      {
        id: "connect-github",
        label: "Connect GitHub",
        description: "Link your repositories for code management",
        completed: githubInstallation !== null,
        href: "/settings?tab=integrations",
      },
      {
        id: "add-anthropic-key",
        label: "Add Anthropic API key",
        description: "Required for AI-powered workflows",
        completed: hasAnthropicKey,
        href: "/settings?tab=integrations",
      },
      {
        id: "connect-linear",
        label: "Connect Linear",
        description: "Sync issues and project tracking",
        completed: linearIntegration !== null,
        href: "/settings?tab=integrations",
      },
      {
        id: "connect-google",
        label: "Connect Google Drive",
        description: "Import documents and collaborate on files",
        completed: googleIntegration !== null,
        href: "/settings?tab=integrations",
      },
      {
        id: "invite-members",
        label: "Invite team members",
        description: "Add colleagues to your organization",
        completed: userCount > 1,
        href: "/settings?tab=organization#/organization-members",
      },
    ];

    return {
      wizardCompleted: state.wizardCompletedAt !== null,
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

    return onboardingService.getStatus(organizationId);
  },

  async dismissChecklist(organizationId: string): Promise<OnboardingStatus> {
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

    return onboardingService.getStatus(organizationId);
  },
};
