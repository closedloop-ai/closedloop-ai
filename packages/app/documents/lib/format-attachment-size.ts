const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

/** Rounds to one decimal so the carry check sees the value we actually render. */
function roundToTenth(value: number): number {
  return Number(value.toFixed(1));
}

/**
 * Human-readable attachment size, shared by every surface that renders one.
 *
 * Each tier is compared *after* rounding, so a size that rounds up to a full
 * 1024 carries into the next unit instead of rendering as `1024 KB` or
 * `1024.0 MB`.
 */
export function formatAttachmentSize(sizeBytes: number): string {
  const kilobytes = Math.ceil(sizeBytes / BYTES_PER_KB);
  if (kilobytes < 1024) {
    return `${kilobytes} KB`;
  }

  const megabytes = roundToTenth(sizeBytes / BYTES_PER_MB);
  if (megabytes < 1024) {
    return `${megabytes.toFixed(1)} MB`;
  }

  return `${roundToTenth(sizeBytes / BYTES_PER_GB).toFixed(1)} GB`;
}
