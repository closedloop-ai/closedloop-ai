import {
  readRuntimeStatus,
  useRuntimeStatusValue,
} from "./use-runtime-status-poll";

// FEA-3639: a harness transcript root the desktop main process could not read —
// a denied macOS file-access prompt, surfaced so the Sessions view can say so
// explicitly instead of stalling silently. Mirrors the main-side `FileAccessBlock`.
export type FileAccessBlock = {
  /** Harness key (e.g. `"codex"`) whose root is unreadable. */
  harness: string;
  /** The unreadable root, home-abbreviated (e.g. `~/.codex/sessions`). */
  path: string;
};

// Stable empty reference so the (overwhelmingly common) unblocked case never
// churns a re-render: the shared poll re-runs `parse` every second, so returning
// a fresh `[]` each time would re-render every Sessions subscriber once a second.
const NO_FILE_ACCESS_BLOCKS: FileAccessBlock[] = [];

/**
 * Project the file-access blocks out of the runtime-status payload. Degrades to
 * the stable empty array when the field is absent (an older main process → the
 * prompt stays hidden), matching the additive-field degrade of the sibling
 * projections. Entries are validated element-by-element (review fix): this is an
 * IPC boundary, so a version-skewed payload such as `[null]` must be dropped
 * here rather than reaching the banner and throwing on `block.harness`.
 */
export function parseFileAccessBlocks(status: unknown): FileAccessBlock[] {
  const blocks = readRuntimeStatus(status).fileAccessBlocks;
  if (!Array.isArray(blocks)) {
    return NO_FILE_ACCESS_BLOCKS;
  }
  const valid = blocks.filter(isFileAccessBlock);
  // Reuse the stable empty reference when nothing survives, so the common
  // (unblocked / all-malformed) case never churns a re-render every poll.
  return valid.length > 0 ? valid : NO_FILE_ACCESS_BLOCKS;
}

/**
 * Polls the main-process file-access blocks while `active`. Returns the stable
 * empty array until the first response (and whenever nothing is blocked), so the
 * Sessions prompt appears only when a root is genuinely unreadable and clears on
 * the next poll once the user grants access.
 */
export function useFileAccessBlocks(active: boolean): FileAccessBlock[] {
  return (
    useRuntimeStatusValue(active, parseFileAccessBlocks) ??
    NO_FILE_ACCESS_BLOCKS
  );
}

/**
 * Narrow one unknown array element to a `FileAccessBlock`. Uses `in`-guarded
 * property access (no cast) so a `null`/primitive/partial entry from a
 * version-skewed main process is rejected instead of crashing the banner.
 */
function isFileAccessBlock(value: unknown): value is FileAccessBlock {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "harness" in value &&
    typeof value.harness === "string" &&
    "path" in value &&
    typeof value.path === "string"
  );
}
