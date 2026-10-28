import type { MonitoredActivityRetainedSnapshot } from "@repo/api/src/types/artifact-activity";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/branch-activity-kind";
import {
  MonitoredHoldExpiryCause,
  MonitoredTargetDisposition,
} from "@repo/api/src/types/monitored-activity-target";
import {
  ArtifactRefTargetKind,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import { z } from "zod";

const retainedSnapshotFields = {
  url: z.string().optional(),
  eventKind: z.enum(MonitoredSessionActivityEventKind),
  occurredAt: z.iso.datetime(),
  completeness: z.union([
    z.literal(BranchActivityEvidenceCompleteness.Complete),
    z.literal(BranchActivityEvidenceCompleteness.Partial),
  ]),
  disposition: z.enum(MonitoredTargetDisposition),
  holdExpiryCause: z.enum(MonitoredHoldExpiryCause).optional(),
};

/**
 * The `after` of a stored `monitored_activity_retained` row, as
 * `retainedMonitoredActivitySnapshot` writes it. Every reader of that row
 * parses it here, so a row one reader accepts the other accepts too.
 *
 * Bounded by what the writer guarantees and no tighter. `repositoryFullName`
 * is the ingest wire value after `normalizeRepoFullName`, which can empty it
 * (`"/"`), so it has no minimum. `branchName` is the wire's non-empty value
 * verbatim, `prNumber` passed `isValidMonitoredActivityTarget`, and the event
 * fields are the wire event schema's.
 *
 * Mirrored in SQL, as a subset, by `CERTIFIED_RETAINED_SNAPSHOT_SQL`
 * (`session-untracked-repositories-rows.ts`) and the partial index built from
 * it: tightening this schema without that predicate lets the untracked read
 * miss an unreadable row.
 */
export const MONITORED_ACTIVITY_RETAINED_SNAPSHOT_SCHEMA = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal(ArtifactRefTargetKind.Branch),
      repositoryFullName: z.string(),
      branchName: z.string().min(1),
      ...retainedSnapshotFields,
    }),
    z.object({
      kind: z.literal(ArtifactRefTargetKind.PullRequest),
      repositoryFullName: z.string(),
      prNumber: z.number().int().positive().max(PR_INT_MAX),
      ...retainedSnapshotFields,
    }),
  ]
) satisfies z.ZodType<MonitoredActivityRetainedSnapshot>;
