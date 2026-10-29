import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import { OnboardingStep } from "@repo/api/src/types/onboarding";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { projectsFixture, projectsTeamFixture } from "./projects-fixtures";

// Per-page API responses for Surfaces/Onboarding: the wizard a new
// workspace's first user runs (`apps/app/app/(onboarding)/onboarding`).

/** `GET /onboarding` for a user who has not finished the wizard. */
export const onboardingStatusFixture: OnboardingStatus = {
  wizardCompleted: false,
  checklistDismissed: false,
  checklist: [],
};

export const onboardingTeamFixture = projectsTeamFixture;
export const onboardingProjectFixture = projectsFixture[0];

/**
 * The wizard's state as `onboarding-constants.ts` persists it to
 * sessionStorage (`onboarding_wizard_state`), for a story that opens the
 * wizard part-way through, the way a reload does.
 */
export type OnboardingWizardSeed = {
  currentStep: OnboardingStep;
  createdTeamId: string | null;
  createdTeamName: string | null;
  createdProjectId: string | null;
  createdProjectName: string | null;
};

const teamCreatedSeed = {
  createdTeamId: onboardingTeamFixture.id,
  createdTeamName: onboardingTeamFixture.name,
  createdProjectId: null,
  createdProjectName: null,
};

/** Back on Create Team after creating the team. */
export const teamCreatedWizardSeed: OnboardingWizardSeed = {
  ...teamCreatedSeed,
  currentStep: OnboardingStep.CreateTeam,
};

/** On Create Project, with the team created. */
export const createProjectWizardSeed: OnboardingWizardSeed = {
  ...teamCreatedSeed,
  currentStep: OnboardingStep.CreateProject,
};

/** On Create Project, with the project created. */
export const projectCreatedWizardSeed: OnboardingWizardSeed = {
  ...createProjectWizardSeed,
  createdProjectId: onboardingProjectFixture?.id ?? null,
  createdProjectName: onboardingProjectFixture?.name ?? null,
};

export const onboardingApiRoutes: FixtureRoute[] = [
  {
    method: "GET",
    path: "/onboarding",
    respond: () => onboardingStatusFixture,
  },
  {
    method: "POST",
    path: "/teams",
    respond: ({ body }) => ({
      ...onboardingTeamFixture,
      name: (body as { name?: string } | undefined)?.name ?? "",
    }),
  },
  {
    method: "POST",
    path: "/projects",
    respond: () => onboardingProjectFixture,
  },
];
