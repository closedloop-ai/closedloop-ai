const RELATIVE_EXPORT_PREFIX = "./";

export const SAMPLE_EXPORT_PATH = "./samples/validate-perf-jsonl.sh" as const;
export const SAMPLE_EXPORT_TARGET =
  "./dist/samples/validate-perf-jsonl.sh" as const;
export const SAMPLE_SOURCE_PATH =
  removeRelativeExportPrefix(SAMPLE_EXPORT_PATH);
export const SAMPLE_DIST_PATH =
  removeRelativeExportPrefix(SAMPLE_EXPORT_TARGET);

function removeRelativeExportPrefix(path: `./${string}`) {
  return path.slice(RELATIVE_EXPORT_PREFIX.length);
}
