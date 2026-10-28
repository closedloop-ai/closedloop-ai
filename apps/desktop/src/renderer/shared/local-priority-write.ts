import { stalePriorityConflict } from "@repo/api/src/types/artifact-priority-mutation";
import type { Priority } from "@repo/api/src/types/common";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  type LocalPriorityWriteResult,
  LocalPriorityWriteStatus,
} from "../../shared/local-priority-write-contract";

/**
 * ISS-10332: a local priority write's answer, surfaced the way the cloud route
 * surfaces the same outcome — so the shared optimistic mutation rolls back and
 * re-reads on the same errors whichever source wrote.
 *
 * `Stale` is the `stale_priority` 409 every priority writer answers, built from
 * the canonical conflict so its code and message are the cloud's own. `NotFound`
 * is the caller's own 404, the one its `detail` read already throws.
 */
export function resolveLocalPriorityWrite(
  result: LocalPriorityWriteResult,
  notFound: () => ApiError
): Priority | null {
  switch (result.status) {
    case LocalPriorityWriteStatus.Written:
      return result.priority;
    case LocalPriorityWriteStatus.Stale: {
      const conflict = stalePriorityConflict([]);
      throw new ApiError(conflict.message, conflict.status, conflict.code);
    }
    case LocalPriorityWriteStatus.NotFound:
      throw notFound();
    default:
      return assertNever(result);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled local priority write result: ${String(value)}`);
}
