import type { Priority } from "@repo/api/src/types/common";
import type { DocumentStatus } from "@repo/api/src/types/document";
import type {
  TableFiltersController,
  TableFiltersState,
  TableFiltersViewModel,
} from "@repo/design-system/components/ui/table-filters";

// Concrete document-domain bindings of the generic design-system table-filter
// types. The design-system module is domain-agnostic (TStatus/TPriority default
// to string); the documents surface flavors them with DocumentStatus/Priority.
export type DocumentTableFiltersState = TableFiltersState<
  DocumentStatus,
  Priority
>;

export type DocumentTableFiltersController = TableFiltersController<
  DocumentStatus,
  Priority
>;

export type DocumentTableFiltersViewModel = TableFiltersViewModel<
  DocumentStatus,
  Priority
>;
