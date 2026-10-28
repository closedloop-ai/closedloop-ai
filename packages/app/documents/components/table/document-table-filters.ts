import type { Priority } from "@repo/api/src/types/common";
import type { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import type { ArtifactStatusFacetValue } from "@repo/app/documents/lib/artifact-status-facet-value";
import type {
  TableFiltersController,
  TableFiltersState,
  TableFiltersViewModel,
} from "@repo/design-system/components/ui/table-filters";

// Concrete document-domain bindings of the generic design-system table-filter
// types. The design-system module is domain-agnostic (TStatus/TPriority default
// to string); the documents surface flavors them with ArtifactStatus/Priority.
// The mixed table renders both Documents and Features, so the status binding is
// the combined ArtifactStatus union (PRD-495).
/**
 * What the priority facet can select: one of the four members, or the artifacts
 * that have NO priority (ISS-9665). A string union rather than `Priority | null`
 * because the design system constrains a facet value to `string` and the
 * selection is persisted in view state. The token IS
 * {@link PRIORITY_UNSET_VALUE}, the one the `:priority=NONE` search grammar
 * uses, so the two ways to ask for unset artifacts cannot drift apart.
 */
export type PriorityFacetValue = Priority | typeof PRIORITY_UNSET_VALUE;

export type DocumentTableFiltersState = TableFiltersState<
  ArtifactStatusFacetValue,
  PriorityFacetValue
>;

export type DocumentTableFiltersController = TableFiltersController<
  ArtifactStatusFacetValue,
  PriorityFacetValue
>;

export type DocumentTableFiltersViewModel = TableFiltersViewModel<
  ArtifactStatusFacetValue,
  PriorityFacetValue
>;
