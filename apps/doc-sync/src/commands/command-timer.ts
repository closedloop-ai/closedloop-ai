import { log } from "@repo/observability/log";
import { DocSyncDocumentCommand } from "@repo/realtime-contract/doc-sync-internal";

export const DOC_SYNC_COMMAND_COMPLETED_EVENT = "doc_sync.command_completed";

export const CommandName = {
  Clear: "clear",
  CommentAnchor: "comment-anchor",
  Text: "text",
  Delete: "delete",
  SeedVersion: DocSyncDocumentCommand.SeedVersion,
  FirstOpenSeed: DocSyncDocumentCommand.FirstOpenSeed,
  SeedIfNeverStored: DocSyncDocumentCommand.SeedIfNeverStored,
} as const;
export type CommandName = (typeof CommandName)[keyof typeof CommandName];

/**
 * Runs `work` and logs its outcome and duration, plus any ids and counts
 * `describe` adds; never the text, anchor or markdown it carried. `describe`
 * may refine `outcome` (seed-version logs `applied` or `stale`, PLN-2190
 * T-1.4), but never the event, command, document name or duration.
 */
export function commandTimer(now: () => number) {
  return async <T extends { kind: string }>(
    command: CommandName,
    documentName: string,
    work: () => Promise<T>,
    describe?: (result: T) => Record<string, string | number>
  ): Promise<T> => {
    const startedAt = now();
    const result = await work();
    log.info("Doc sync command completed", {
      outcome: result.kind,
      ...describe?.(result),
      event: DOC_SYNC_COMMAND_COMPLETED_EVENT,
      command,
      documentName,
      durationMs: now() - startedAt,
    });
    return result;
  };
}
