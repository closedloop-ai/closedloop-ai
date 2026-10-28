import type { DirectoryScopeListWithAddDemoProps } from "@repo/app/shared/components/directory-scope-list-with-add-demo";
import {
  ADD_DIRECTORY_CONTROL_COPY,
  FIXTURE_AUTO_EXCLUDED,
  FIXTURE_EXPANDED_IDS,
  FIXTURE_INCLUDED_IDS,
  FIXTURE_PICKS,
  FIXTURE_SCOPE_ENTRIES,
  PICK_LEGEND,
  UNWRITTEN_SCOPE_LIST_COPY,
} from "@repo/app/shared/components/directory-scope-list-with-add-fixtures";

export const mockProps: DirectoryScopeListWithAddDemoProps = {
  addCopy: ADD_DIRECTORY_CONTROL_COPY,
  autoExcluded: FIXTURE_AUTO_EXCLUDED,
  defaultExpandedIds: FIXTURE_EXPANDED_IDS,
  initialEntries: FIXTURE_SCOPE_ENTRIES,
  initialIncludedIds: FIXTURE_INCLUDED_IDS,
  listCopy: UNWRITTEN_SCOPE_LIST_COPY,
  // The simulated picker always resolves, so this is never reached.
  onPickError: (error) => {
    throw error;
  },
  pickLegend: PICK_LEGEND,
  picks: Object.values(FIXTURE_PICKS),
};
