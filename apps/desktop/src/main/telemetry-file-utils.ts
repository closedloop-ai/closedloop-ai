import { existsSync, statSync } from "node:fs";

/**
 * Capture the current byte-offset of a JSONL telemetry file. Used by both the
 * Loop perf watcher and the Phase 5.5 decision-table-verifier scanner to mark
 * the boundary between previously-emitted and newly-appended records.
 *
 * Returns 0 when the file is missing or unreadable so callers stay fail-open.
 */
export function getJsonlFileOffset(filePath: string): number {
  try {
    return existsSync(filePath) ? statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

/**
 * Count the number of LF (0x0a) bytes in `buffer` strictly before `offset`.
 * Used to seed the absolute `lineNumber` reported in parse-failure diagnostics
 * when a streaming reader resumes from a non-zero start offset.
 */
export function countNewlinesBeforeOffset(
  buffer: Buffer,
  offset: number
): number {
  const bound = Math.min(offset, buffer.length);
  let count = 0;
  for (let index = 0; index < bound; index += 1) {
    if (buffer[index] === 0x0a) {
      count += 1;
    }
  }
  return count;
}
