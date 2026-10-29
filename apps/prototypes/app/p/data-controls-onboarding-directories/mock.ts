import type { GuidedOnboardingDirectoryStepDemoProps } from "@repo/app/onboarding/components/guided-onboarding-directory-step-demo";
import {
  FIXTURE_ADDED_PICK,
  FIXTURE_BRAND_NAME,
  FIXTURE_DISCOVERED_ENTRIES,
  FIXTURE_DISCOVERED_EXPANDED_IDS,
  FIXTURE_DISCOVERED_INCLUDED_IDS,
  PLACEHOLDER_DIRECTORY_STEP_COPY,
  PLACEHOLDER_SCOPE_LIST_COPY,
} from "@repo/app/onboarding/components/guided-onboarding-directory-step-fixtures";
import {
  ADD_DIRECTORY_CONTROL_COPY,
  FIXTURE_AUTO_EXCLUDED,
} from "@repo/app/shared/components/directory-scope-list-with-add-fixtures";

export const mockProps: GuidedOnboardingDirectoryStepDemoProps = {
  addCopy: ADD_DIRECTORY_CONTROL_COPY,
  autoExcluded: FIXTURE_AUTO_EXCLUDED,
  brandName: FIXTURE_BRAND_NAME,
  copy: PLACEHOLDER_DIRECTORY_STEP_COPY,
  defaultExpandedIds: FIXTURE_DISCOVERED_EXPANDED_IDS,
  initialEntries: FIXTURE_DISCOVERED_ENTRIES,
  initialIncludedIds: FIXTURE_DISCOVERED_INCLUDED_IDS,
  listCopy: PLACEHOLDER_SCOPE_LIST_COPY,
  // The step hands its confirmed scope to the sync-level step, which this
  // prototype does not draw.
  onContinue: () => undefined,
  pick: FIXTURE_ADDED_PICK,
};
