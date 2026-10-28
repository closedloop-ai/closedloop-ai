/**
 * The approved word for an artifact's owning project, spelled once for every
 * surface that names the field: the Branch and Session Details rows, and the
 * Branches list column (ISS-12453).
 *
 * Its own module, not `artifact-project-value.tsx`, because the Branches column
 * view model is a pure helper its own suite imports — holding the label beside
 * the picker made that model, every importer of it, and that suite load
 * `useBatchMoveArtifacts`, `useProjects`, the popover and react-query for one
 * string (tamsinb review, PR #8794). Same shape as `PRIORITY_COLUMN_LABEL` in
 * `shared/lib/priority-constants.ts`.
 */
export const ARTIFACT_PROJECT_FIELD_LABEL = "Project";
