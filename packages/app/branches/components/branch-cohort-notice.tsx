"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import { BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import {
  BranchCohortNoticeKind,
  type BranchCohortNoticeModel,
} from "../lib/branch-cohort-transparency";

/** Shared finite-window update notice for the web and Desktop lists. */
export function BranchCohortNotice({
  model,
  rangeLabel,
}: {
  model: BranchCohortNoticeModel;
  rangeLabel: string;
}) {
  const enabled = useFeatureFlagEnabledOptional(
    BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY
  );
  const copy = noticeCopy(model, rangeLabel);
  if (!enabled || copy === null) {
    return null;
  }
  return (
    <Alert
      aria-atomic="true"
      aria-live="polite"
      role="status"
      variant={copy.warning ? "warning" : "info"}
    >
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.description}</AlertDescription>
    </Alert>
  );
}

function noticeCopy(
  model: BranchCohortNoticeModel,
  rangeLabel: string
): { title: string; description: string; warning: boolean } | null {
  switch (model.kind) {
    case BranchCohortNoticeKind.Partial:
    case BranchCohortNoticeKind.Unavailable:
    case BranchCohortNoticeKind.Hidden:
    case BranchCohortNoticeKind.Complete:
      return null;
    case BranchCohortNoticeKind.Updating:
      return {
        title: `Updating Branches for ${rangeLabel}`,
        description:
          "Results from the previous range remain visible until the new range is ready.",
        warning: false,
      };
    case BranchCohortNoticeKind.UpdateFailed:
      return {
        title: `Couldn't update Branches for ${rangeLabel}`,
        description:
          "Results from the previous range remain visible. Try the range again.",
        warning: true,
      };
    default:
      return assertNever(model);
  }
}

function assertNever(_value: never): never {
  throw new Error("Unhandled Branch cohort notice kind");
}
