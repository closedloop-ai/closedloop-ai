/**
 * @deprecated Import the shared trace-comments provider directly. This shim is
 * retained for version-skewed consumers of the previous Agents-owned path.
 */
// biome-ignore lint/performance/noBarrelFile: compatibility path retained until version-skewed consumers migrate.
export {
  TraceCommentsDataSourceProvider,
  useTraceCommentsDataSource,
} from "../../shared/trace-comments/trace-comments-provider";
