/**
 * @description ISS-7249's dead-end predicate — what is left of this module
 * after ISS-9555 slice 1 moved the Sessions page params, their parse/write
 * rules and the clamp into `@repo/app/agents/lib/session-pagination`, the ONE
 * declaration both shells now import. Importers were repointed there rather
 * than re-exported through here: a re-export block is a barrel
 * (`lint/performance/noBarrelFile`), and a second SPELLING of one function is
 * the drift that slice closes.
 *
 * This predicate stayed because it has no web counterpart — it feeds the
 * desktop dead-end classifier and nothing else.
 */

import { clampSessionsPageIndex } from "@repo/app/agents/lib/session-pagination";

/**
 * ISS-7249 (whitlockk review): "past the end" is a claim only a SUCCESSFUL read can
 * support. The render model falls back to a total of zero, which is
 * indistinguishable from a real empty scope, so on `?page=2` with a failed
 * initial read the raw clamp comparison reported the page out of range — and
 * the dead-end classifier suppresses its record when it is, so the failure the
 * user was staring at went uncounted. The clamp itself cannot repair that
 * without the response; only a settled total can, which is why the precondition
 * is IN the predicate rather than left to each caller to remember.
 */
export function isSessionsPageOutOfRange({
  hasSettledTotal,
  maxOffset,
  pageIndex,
  pageSize,
  total,
}: {
  /** A successful, non-placeholder response established `total`. */
  hasSettledTotal: boolean;
  /** The host read's offset ceiling; see `clampSessionsPageIndex`. */
  maxOffset?: number;
  pageIndex: number;
  pageSize: number;
  total: number;
}): boolean {
  return (
    hasSettledTotal &&
    clampSessionsPageIndex(pageIndex, total, pageSize, maxOffset) !== pageIndex
  );
}
