"use client";

/**
 * @file ISS-12524: the guided-onboarding step where a first-time user reviews
 * the directories discovery found, adds or removes directories, and confirms
 * which are in scope before choosing a sync level.
 *
 * Design-only for now: it is NOT a `GuidedOnboardingDialog` phase and is not
 * in `GUIDED_ONBOARDING_PHASES`. Wiring it in waits on `/design-review` and
 * approved copy (decision thread th_hdf9HnMCIvHymYZI13FwD on ISS-12524), which
 * also fixed the open questions this file encodes:
 * - it sits after sign-in and organization and immediately before the
 *   sync-level step (AC-001), so its only exits are Back and Continue;
 * - Continue stays available with zero directories selected (AC-003): nothing
 *   is in scope for upload and the sync step treats that as local-only, so the
 *   step never blocks onboarding;
 * - web has no picker and no local discovery (AC-004): the host passes no
 *   `add` adapter and no entries, and the list shows its own empty state.
 *
 * The list and its add control are ISS-12520's `DirectoryScopeList` and
 * ISS-12521's `DirectoryScopeListWithAdd`, composed unchanged. Every string is
 * a prop: the step's own slots on `GuidedOnboardingDirectoryStepCopy`, the
 * list's on `DirectoryScopeListCopy`, the add control's on its adapter.
 */

import { Button } from "@repo/design-system/components/ui/button";
import type { ReactNode } from "react";
import type {
  AutoExcludedDirectory,
  DirectoryScopeEntry,
  DirectoryScopeListCopy,
} from "../../shared/components/directory-scope-list";
import {
  type AddDirectoryAdapter,
  DirectoryScopeListWithAdd,
} from "../../shared/components/directory-scope-list-with-add";
import {
  GuidedOnboardingBackButton,
  GuidedOnboardingStepLayout,
} from "./guided-onboarding-step-layout";

/** The step's own words. None has an approved source yet (PRD-796). */
export type GuidedOnboardingDirectoryStepCopy = {
  eyebrow: string;
  title: string;
  description: string;
  /** Visible label of the primary action. */
  continueLabel: string;
};

/** Whether anything is in scope, exposed for the host and the tests. */
export const DirectoryStepSelection = {
  None: "none",
  Some: "some",
} as const;
export type DirectoryStepSelection =
  (typeof DirectoryStepSelection)[keyof typeof DirectoryStepSelection];

export type GuidedOnboardingDirectoryStepProps = {
  annotation?: ReactNode;
  brand: ReactNode;
  copy: GuidedOnboardingDirectoryStepCopy;
  listCopy: DirectoryScopeListCopy;
  /** Discovered directories. Empty on web, where nothing can be discovered. */
  entries: readonly DirectoryScopeEntry[];
  /** Controlled. The host decides what a first run starts with. */
  includedIds: readonly string[];
  onIncludedIdsChange: (includedIds: string[]) => void;
  autoExcluded?: readonly AutoExcludedDirectory[];
  defaultExpandedIds?: readonly string[];
  /** Desktop's folder picker. Leave unset on web and the add control is absent. */
  add?: AddDirectoryAdapter;
  onBack?: () => void;
  /**
   * Carries the confirmed scope, possibly empty. The host persists it and
   * advances to the sync-level step.
   */
  onContinue: (includedIds: string[]) => void;
};

export function GuidedOnboardingDirectoryStep({
  add,
  annotation,
  autoExcluded,
  brand,
  copy,
  defaultExpandedIds,
  entries,
  includedIds,
  listCopy,
  onBack,
  onContinue,
  onIncludedIdsChange,
}: GuidedOnboardingDirectoryStepProps) {
  const selection =
    includedIds.length === 0
      ? DirectoryStepSelection.None
      : DirectoryStepSelection.Some;

  return (
    <GuidedOnboardingStepLayout
      annotation={annotation}
      body={
        <DirectoryScopeListWithAdd
          add={add}
          autoExcluded={autoExcluded}
          className="mt-7"
          copy={listCopy}
          defaultExpandedIds={defaultExpandedIds}
          entries={entries}
          includedIds={includedIds}
          onIncludedIdsChange={onIncludedIdsChange}
        />
      }
      brand={brand}
      description={copy.description}
      eyebrow={copy.eyebrow}
      footer={
        <>
          <GuidedOnboardingBackButton onBack={onBack} />
          {/* Never disabled: zero directories is a valid, local-only answer
              (AC-003), not an incomplete step. */}
          <Button
            className="w-full sm:w-56"
            data-selection={selection}
            onClick={() => onContinue([...includedIds])}
            size="lg"
            type="button"
          >
            {copy.continueLabel}
          </Button>
        </>
      }
      title={copy.title}
    />
  );
}
