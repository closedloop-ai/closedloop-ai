import type { MonitoredActivityRetainedSnapshot } from "@repo/api/src/types/artifact-activity";
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  MonitoredTargetDisposition,
  monitoredActivityTargetUrl,
} from "@repo/api/src/types/monitored-activity-target";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import type { SessionUntrackedRepositoryTarget } from "@repo/api/src/types/session-untracked-repository";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { FixedWindowRateLimiter } from "@/lib/fixed-window-rate-limiter";
import { MONITORED_ACTIVITY_RETAINED_SNAPSHOT_SCHEMA } from "./monitored-session-activity-retained-snapshot";
import { sessionUntrackedRepositoryRowsQuery } from "./session-untracked-repositories-rows";

/**
 * PLN-2061 M5: the untracked-repository targets a session's run touched, read
 * back off the `monitored_activity_retained` rows ISS-9182 files on the SESSION
 * artifact (`monitored-session-activity-retention.ts`, the only writer).
 *
 * Operator ruling 2026-09-18 (Kerensa Whitlock, PLN-2061 "Governing rulings"): a
 * session shows the untracked repository it touched, on session detail. This
 * renders retained evidence and computes nothing new.
 *
 * Omitted — not an empty array — when nothing qualifies, so the detail wire
 * stays additive. Also omitted when the read fails: this is optional enrichment
 * on the detail read and must not fail it (`apps/api/AGENTS.md`, "Optional
 * enrichment must not sit on a fatal path").
 */
export async function readSessionUntrackedRepositoryTargets(input: {
  organizationId: string;
  sessionArtifactId: string;
}): Promise<SessionUntrackedRepositoryTarget[] | undefined> {
  let rows: RetainedRow[];
  try {
    rows = await readRetainedRows(input);
  } catch (error) {
    log.error(SESSION_UNTRACKED_REPOSITORIES_READ_FAILED_EVENT, {
      organizationId: input.organizationId,
      sessionId: input.sessionArtifactId,
      error: parseError(error),
    });
    return undefined;
  }
  const { targets, unreadableRowCount } =
    toSessionUntrackedRepositoryTargets(rows);
  if (unreadableRowCount > 0) {
    reportUnreadableRetainedRows({
      organizationId: input.organizationId,
      sessionId: input.sessionArtifactId,
      unreadableRows: unreadableRowCount,
    });
  }
  return targets.length === 0 ? undefined : targets;
}

/**
 * Filter retained rows to the untracked dispositions, collapse repeated
 * deliveries of one target to its first row, and order the result by
 * repository, then kind, then PR number or branch name.
 *
 * A row whose `after` does not parse — an absent or unknown disposition
 * included — is excluded, since it cannot be shown to name an untracked
 * repository, and counted in `unreadableRowCount`: the only writer always
 * stamps a known disposition, so such a row is corrupt. A row whose repository
 * name is empty is excluded and counted too: normalization can empty a
 * producer's name, and such a row names no repository to show. A row that
 * parses to a tracked disposition is excluded without being counted.
 */
export function toSessionUntrackedRepositoryTargets(
  rows: readonly RetainedRow[]
): {
  targets: SessionUntrackedRepositoryTarget[];
  unreadableRowCount: number;
} {
  const byKey = new Map<string, SessionUntrackedRepositoryTarget>();
  let unreadableRowCount = 0;
  for (const row of rows) {
    const parsed = MONITORED_ACTIVITY_RETAINED_SNAPSHOT_SCHEMA.safeParse(
      row.after
    );
    if (!parsed.success || parsed.data.repositoryFullName.length === 0) {
      unreadableRowCount += 1;
      continue;
    }
    if (!UNTRACKED_DISPOSITION[parsed.data.disposition]) {
      continue;
    }
    const target = toUntrackedTarget(parsed.data);
    const key = untrackedTargetSortKey(target);
    if (!byKey.has(key)) {
      byKey.set(key, target);
    }
  }
  const targets = [...byKey.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, target]) => target);
  return { targets, unreadableRowCount };
}

/**
 * Not the session's whole retained history: the rows that can change the
 * answer — each target's earliest certified untracked row, plus every row the
 * SQL cannot certify — in `(createdAt, id)` order, so the in-memory pass above
 * reaches the same targets and the same unreadable count
 * ({@link sessionUntrackedRepositoryRowsQuery}).
 */
function readRetainedRows(input: {
  organizationId: string;
  sessionArtifactId: string;
}): Promise<RetainedRow[]> {
  return withDb((db) =>
    db.$queryRaw<RetainedRow[]>(
      sessionUntrackedRepositoryRowsQuery({
        ...input,
        untrackedDispositions: UNTRACKED_DISPOSITIONS,
      })
    )
  );
}

/**
 * The corrupt row is persisted and re-read on every GET of the session, so the
 * emission is budgeted per organization per window (`apps/api/AGENTS.md`,
 * "Emission and Abuse Control") — the same shape as
 * `agent_session_trace_sources_unreadable`. Carries counts and ids only, never
 * a repository name.
 */
function reportUnreadableRetainedRows(context: {
  organizationId: string;
  sessionId: string;
  unreadableRows: number;
}): void {
  if (
    !unreadableRowEmissionBudget.attempt(context.organizationId, Date.now())
  ) {
    return;
  }
  log.warn(UNREADABLE_UNTRACKED_REPOSITORY_ROWS_EVENT, context);
}

/** For tests, which must not inherit another spec's spent window. */
export function resetUnreadableUntrackedRepositoryRowEmissionBudget(): void {
  unreadableRowEmissionBudget.clear();
}

type RetainedRow = { id: string; after: unknown };

/**
 * The href is kept only when it is the one the target derives: `after` is a
 * freeform JSON column and the row renders it as a link, so a value this
 * repo's own derivation would not produce is dropped and the entry renders as
 * plain text.
 */
function toUntrackedTarget(
  snapshot: MonitoredActivityRetainedSnapshot
): SessionUntrackedRepositoryTarget {
  const target =
    snapshot.kind === ArtifactRefTargetKind.PullRequest
      ? {
          kind: snapshot.kind,
          repositoryFullName: snapshot.repositoryFullName,
          prNumber: snapshot.prNumber,
        }
      : {
          kind: snapshot.kind,
          repositoryFullName: snapshot.repositoryFullName,
          branchName: snapshot.branchName,
        };
  const url =
    snapshot.url !== undefined &&
    snapshot.url === monitoredActivityTargetUrl(target)
      ? snapshot.url
      : undefined;
  return url === undefined ? target : { ...target, url };
}

/**
 * Dedupe key and sort key in one; the PR number is zero-padded so `#9` sorts
 * before `#10`.
 */
function untrackedTargetSortKey(
  target: SessionUntrackedRepositoryTarget
): string {
  const repository = normalizeRepoFullName(target.repositoryFullName);
  const address =
    target.kind === ArtifactRefTargetKind.PullRequest
      ? String(target.prNumber).padStart(PR_NUMBER_SORT_WIDTH, "0")
      : target.branchName;
  return [repository, target.kind, address].join("\u0000");
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Which dispositions mean the ORGANIZATION cannot track or fetch the
 * repository. Exhaustive so a disposition added later fails `tsc` here until
 * someone decides which side it is on.
 *
 * `IntentionallyAbsent` is excluded: `classifyTarget` returns it for a PR the
 * provider says does not exist on a repository the org can read, and for a
 * branch that is the repository's own default branch — neither says the
 * repository is untracked. The four held dispositions never reach a retained
 * row (retention skips retry-owned candidates) and are excluded for the same
 * reason.
 */
const UNTRACKED_DISPOSITION: Record<MonitoredTargetDisposition, boolean> = {
  [MonitoredTargetDisposition.IntentionallyAbsent]: false,
  [MonitoredTargetDisposition.RepositoryUnfetchable]: true,
  [MonitoredTargetDisposition.RepositoryOutOfScope]: true,
  [MonitoredTargetDisposition.RepositoryIdentityUnknown]: false,
  [MonitoredTargetDisposition.AuthorityConflict]: false,
  [MonitoredTargetDisposition.ProviderIdentityAmbiguous]: false,
  [MonitoredTargetDisposition.TargetNotMaterialized]: false,
  // ISS-11427: a hold that ran past its ceiling says nothing about whether the
  // organization can track or fetch the repository — the classified reason it
  // was held for did, and that reason is not this member.
  [MonitoredTargetDisposition.HoldExpired]: false,
};

const UNTRACKED_DISPOSITIONS = Object.values(MonitoredTargetDisposition).filter(
  (disposition) => UNTRACKED_DISPOSITION[disposition]
);

/** Wide enough for any GitHub PR number, so string order is numeric order. */
const PR_NUMBER_SORT_WIDTH = 12;

/**
 * A detail read whose untracked-repository query failed and was served without
 * the field. Stable snake_case, the `sessions_list_comment_count_read_failed`
 * shape: a monitor keys on the literal, so it must not be reworded casually.
 */
export const SESSION_UNTRACKED_REPOSITORIES_READ_FAILED_EVENT =
  "agent_session_untracked_repositories_read_failed";

/**
 * A detail read that excluded retained rows whose `after` did not parse. Read
 * one line as "at least one in this window for this org", never as a count:
 * the emission is budgeted, see {@link reportUnreadableRetainedRows}.
 */
export const UNREADABLE_UNTRACKED_REPOSITORY_ROWS_EVENT =
  "agent_session_untracked_repository_rows_unreadable";

const unreadableRowEmissionBudget = new FixedWindowRateLimiter({
  maxEntries: 10_000,
  maxRequests: 1,
  windowMs: 60_000,
});
