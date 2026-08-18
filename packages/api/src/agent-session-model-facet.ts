import type { AgentSessionModelFacetOption } from "./types/agent-session-facet-options.ts";

/**
 * A per-PRIMARY-model session count: the number of sessions whose single
 * displayed model (`SessionDetail.model` on cloud / `sessions.model` on desktop)
 * equals `model`. `model` is nullable because a session may have no captured
 * primary model (it groups under a null key in a `GROUP BY model`).
 */
export type PrimaryModelSessionCount = {
  model: string | null;
  sessionCount: number;
};

/**
 * FEA-4303: build the Sessions Model filter facet options from per-primary-model
 * session counts — the exact string the Sessions table paints in its Model
 * column and the same field the Model filter predicate matches. Keeping the
 * options, the predicate, and the column on ONE model vocabulary is the fix:
 * sourcing options from the per-token-usage breakdown (which spans
 * secondary/subagent models) let a selectable option return rows whose visible
 * Model showed a different primary model — or none at all.
 *
 * This is the single shared implementation for both usage producers: the cloud
 * service's `SessionDetail.groupBy({ by: ["model"] })` and the desktop
 * `sessions.model` SQL `GROUP BY` / hydrate-path tally.
 *
 * Counts with no primary model (null) are dropped — there is no Model value to
 * filter to. Options are sorted by session count desc (then model asc for a
 * stable tie-break) so the most common models surface first.
 */
export function buildModelFilterOptionsFromCounts(
  counts: readonly PrimaryModelSessionCount[] | undefined
): AgentSessionModelFacetOption[] {
  return (counts ?? [])
    .filter(
      (entry): entry is PrimaryModelSessionCount & { model: string } =>
        entry.model != null
    )
    .map((entry) => ({
      model: entry.model,
      sessionCount: entry.sessionCount,
    }))
    .sort(
      (left, right) =>
        right.sessionCount - left.sessionCount ||
        left.model.localeCompare(right.model)
    );
}
