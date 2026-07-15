import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactStatus } from "@repo/api/src/types/document";
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
export type DocumentTableFiltersState = TableFiltersState<
  ArtifactStatus,
  Priority
>;

export type DocumentTableFiltersController = TableFiltersController<
  ArtifactStatus,
  Priority
>;

export type DocumentTableFiltersViewModel = TableFiltersViewModel<
  ArtifactStatus,
  Priority
>;
