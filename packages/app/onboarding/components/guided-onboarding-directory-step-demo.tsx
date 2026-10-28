"use client";

import {
  Dialog,
  DialogContent,
} from "@repo/design-system/components/ui/dialog";
import { useState } from "react";
import type {
  AutoExcludedDirectory,
  DirectoryScopeEntry,
  DirectoryScopeListCopy,
} from "../../shared/components/directory-scope-list";
import type {
  AddDirectoryControlCopy,
  PickedDirectory,
} from "../../shared/components/directory-scope-list-with-add";
import {
  GuidedOnboardingDirectoryStep,
  type GuidedOnboardingDirectoryStepCopy,
} from "./guided-onboarding-directory-step";

/**
 * The mock host for {@link GuidedOnboardingDirectoryStep}: it holds the list
 * state and frames the step in the guided-onboarding card, which the
 * production-bound prototype route cannot draw itself
 * (`scripts/lint/production-bound-prototype-route.ts`). `pick` stands in for
 * the native folder picker; leave it and `addCopy` unset to show web, where
 * there is no picker. This module originates no words.
 */
export type GuidedOnboardingDirectoryStepDemoProps = {
  /** The product name the card shows, as the shell's brand slot draws it. */
  readonly brandName: string;
  readonly copy: GuidedOnboardingDirectoryStepCopy;
  readonly listCopy: DirectoryScopeListCopy;
  readonly initialEntries: readonly DirectoryScopeEntry[];
  readonly initialIncludedIds: readonly string[];
  readonly defaultExpandedIds?: readonly string[];
  readonly autoExcluded?: readonly AutoExcludedDirectory[];
  readonly addCopy?: AddDirectoryControlCopy;
  readonly pick?: PickedDirectory | null;
  readonly onBack?: () => void;
  readonly onContinue: (includedIds: string[]) => void;
  readonly onPickError?: (error: unknown) => void;
};

export const GuidedOnboardingDirectoryStepDemo = ({
  addCopy,
  autoExcluded,
  brandName,
  copy,
  defaultExpandedIds,
  initialEntries,
  initialIncludedIds,
  listCopy,
  onBack,
  onContinue,
  onPickError,
  pick,
}: GuidedOnboardingDirectoryStepDemoProps) => {
  const [entries, setEntries] = useState(initialEntries);
  const [includedIds, setIncludedIds] = useState(initialIncludedIds);

  return (
    <Dialog open>
      <DialogContent
        // The real shell's card className (`guided-onboarding-dialog.tsx`),
        // as `guided-onboarding-phases.stories.tsx` copies it.
        className="grid-cols-1 gap-0 overflow-hidden p-0 transition-none focus:outline-hidden"
        showCloseButton={false}
        size="large"
      >
        <GuidedOnboardingDirectoryStep
          add={
            addCopy && pick !== undefined
              ? {
                  copy: addCopy,
                  onAdd: (entry) =>
                    setEntries((previous) => [...previous, entry]),
                  onPickError: onPickError ?? (() => undefined),
                  pickDirectory: () => Promise.resolve(pick),
                }
              : undefined
          }
          autoExcluded={autoExcluded}
          brand={<span className="font-semibold">{brandName}</span>}
          copy={copy}
          defaultExpandedIds={defaultExpandedIds}
          entries={entries}
          includedIds={includedIds}
          listCopy={listCopy}
          onBack={onBack}
          onContinue={onContinue}
          onIncludedIdsChange={setIncludedIds}
        />
      </DialogContent>
    </Dialog>
  );
};
