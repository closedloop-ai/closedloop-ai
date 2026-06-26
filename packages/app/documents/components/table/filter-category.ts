/**
 * Toggle-group categories used by document-table consumers (project page,
 * My Tasks). Centralized so hooks and components don't reach into the
 * page-specific component file to import the type.
 */
export type FilterCategory =
  | "all"
  | "documents"
  | "features"
  | "plans"
  | "branches";
