import { relabelBaseSeedGitHub } from "../core/base-seed-github";
import { relabelBaseSeedContent } from "../core/base-seed-relabel";
import { settleOnboardingProgress } from "../core/onboarding-progress";
import { seedOrgPeople } from "../core/org-people";
import {
  completeOnboardingWizard,
  linkProjectsToOwnedTeam,
} from "../core/org-setup";
import type { VibeSeedStage } from "../stage";

/**
 * The relabel stages add no models of their own: they rewrite rows the base
 * seed already wrote, and run first so every later stage (and the search
 * index) reads the new names. Projects join their team before the content
 * relabel because that write stamps `updatedAt`, which the relabel backdates.
 */
export const STAGES: readonly VibeSeedStage[] = [
  {
    name: "org-people",
    models: [],
    run: seedOrgPeople,
  },
  {
    name: "relabel-github",
    models: [],
    run: relabelBaseSeedGitHub,
  },
  {
    name: "project-teams",
    models: ["ProjectTeam"],
    run: linkProjectsToOwnedTeam,
  },
  {
    name: "relabel-content",
    models: [],
    run: relabelBaseSeedContent,
  },
  {
    name: "onboarding-complete",
    models: [],
    run: completeOnboardingWizard,
  },
  {
    name: "onboarding-progress",
    models: ["OnboardingAttempt"],
    run: settleOnboardingProgress,
  },
];
