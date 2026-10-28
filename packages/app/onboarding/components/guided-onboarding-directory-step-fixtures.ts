/**
 * @file Fixtures for `GuidedOnboardingDirectoryStep`, read by its stories, its
 * tests and the `data-controls-onboarding-directories` prototype. No shipped
 * render path imports this module.
 *
 * Every directory is fictional. The step's own copy and the shared list's copy
 * have no approved wording, so each slot is a neutral placeholder named after
 * it, allowed for design-only story fixtures by operator ruling (Nerys,
 * 2026-10-15, th_Dc0RuSiAdyCvLQpC_X2G4). Two strings are reused, not written:
 * `continueLabel` is the shipped label of the sync step's primary action
 * (`guided-onboarding-sync-step.tsx`), and the add control's copy is the
 * wording Cosimo Corrigan approved for ISS-12521.
 */

import type {
  DirectoryScopeEntry,
  DirectoryScopeListCopy,
} from "../../shared/components/directory-scope-list";
import { AddDirectoryOutcome } from "../../shared/components/directory-scope-list-with-add";
import { FIXTURE_PICKS } from "../../shared/components/directory-scope-list-with-add-fixtures";
import type { GuidedOnboardingDirectoryStepCopy } from "./guided-onboarding-directory-step";

export const PLACEHOLDER_DIRECTORY_STEP_COPY: GuidedOnboardingDirectoryStepCopy =
  {
    continueLabel: "Continue",
    description: "Placeholder: description",
    eyebrow: "Placeholder: eyebrow",
    title: "Placeholder: title",
  };

export const PLACEHOLDER_SCOPE_LIST_COPY: DirectoryScopeListCopy = {
  autoExcludedHeading: "Placeholder: auto-excluded heading",
  autoExcludedReason: "Placeholder: auto-excluded reason",
  empty: "Placeholder: empty",
  newlyDiscovered: "Placeholder: newly discovered",
  noSelection: "Placeholder: no selection",
  treeLabel: "Placeholder: tree label",
  unavailable: "Placeholder: unavailable",
  unavailableReason: "Placeholder: unavailable reason",
};

/** What a first run's discovery found on a fictional machine. */
export const FIXTURE_DISCOVERED_ENTRIES: readonly DirectoryScopeEntry[] = [
  {
    id: "~/work",
    label: "~/work",
    children: [
      { id: "~/work/harbor-api", label: "harbor-api" },
      { id: "~/work/harbor-app", label: "harbor-app" },
      { id: "~/work/old-ledger", label: "old-ledger", unavailable: true },
    ],
  },
  { id: "~/scratch", label: "~/scratch" },
];

export const FIXTURE_DISCOVERED_INCLUDED_IDS: readonly string[] = [
  "~/work/harbor-api",
  "~/work/harbor-app",
];

export const FIXTURE_DISCOVERED_EXPANDED_IDS: readonly string[] = ["~/work"];

/** The pick the simulated folder picker returns: a fresh, readable directory. */
export const FIXTURE_ADDED_PICK = FIXTURE_PICKS[AddDirectoryOutcome.Added];

/** The product name every guided-onboarding story frames its step with. */
export const FIXTURE_BRAND_NAME = "Closedloop.ai";
