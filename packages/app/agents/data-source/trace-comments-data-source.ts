/**
 * @deprecated Import the shared trace-comments port directly. This compatibility
 * shim remains for external consumers during the package-path migration.
 */
export type { TraceCommentsDataSource } from "../../shared/trace-comments/trace-comments-data-source";
// biome-ignore lint/performance/noBarrelFile: compatibility path retained until version-skewed consumers migrate.
export {
  createHttpTraceCommentsDataSource,
  normalizedTraceCommentSurface,
} from "../../shared/trace-comments/trace-comments-data-source";
