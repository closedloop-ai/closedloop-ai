import { buildModelFilterOptionsFromCounts } from "@repo/api/src/agent-session-model-facet";
import type { AgentSessionModelFacetOption } from "@repo/api/src/types/agent-session-facet-options";

/**
 * Shape of a `SessionDetail.groupBy({ by: ["model"] })` row. `SessionDetail.model`
 * is nullable, so a session with no captured primary model groups under a null key.
 */
type PrimaryModelGroup = {
  model: string | null;
  _count: {
    _all: number;
  };
};

/**
 * FEA-4303: build the Sessions Model filter facet options from a groupBy over the
 * PRIMARY displayed model (`SessionDetail.model`) — the exact string the Sessions
 * table paints in its Model column and the same field the Model filter predicate
 * matches (`query-builder.ts`). Delegates to the shared
 * `buildModelFilterOptionsFromCounts` so the cloud and desktop usage producers
 * emit identical facet options (null-drop, sort) from the same corpus.
 */
export function buildModelFilterOptions(
  groups: PrimaryModelGroup[]
): AgentSessionModelFacetOption[] {
  return buildModelFilterOptionsFromCounts(
    groups.map((group) => ({
      model: group.model,
      sessionCount: group._count._all,
    }))
  );
}
