import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { SyncedComponentUsage } from "@repo/api/src/types/agent-session";
import { normalizeCommandComponentKey } from "@repo/lib/sessions/command-user-turn-id";
import { slashKeyBareName } from "@repo/lib/sessions/skill-shadow-identity";

/**
 * @file agent-session-sync-component-usage-identity.ts
 * @description ISS-6884's component-usage IDENTITY half of the sync payload —
 * how usage rows are grouped, what identity a part must keep whole, and what a
 * group weighs on the wire.
 *
 * Split out of `agent-session-sync-payload.ts` (ISS-7997) for the same reason
 * ISS-7896 split the metadata half out: that file is NOT grandfathered against
 * the repo's hard 1,000-line `noExcessiveLinesPerFile` ceiling, and the degrade
 * this ticket adds could not go in beside it otherwise.
 *
 * Nothing here imports the chunker, which is what makes it severable: these are
 * pure functions of a usage row, and the packing that consults them stays where
 * it was.
 */

/**
 * ISS-6884: partition component usage into the whole groups that are the atomic
 * unit of pagination — see {@link componentUsageMergeKey} for why the unit is
 * the RECEIVER's identity rather than the wire one.
 *
 * The cloud prune (`persistSessionComponentUsage`) treats a payload's branch set
 * for a PRESENT group as authoritative and deletes that group's other branch
 * buckets, so a group split across two parts loses the first part's branches when
 * the second lands. Groups absent from a part are left untouched, so whole-group
 * parts merge correctly regardless of order or of which server version applies
 * them.
 *
 * Grouping is by identity rather than by adjacency: the desktop reader emits
 * each group contiguously, but this must hold for any producer ordering.
 */
export function groupComponentUsageByComponent(
  components: SyncedComponentUsage[] | undefined,
  keyOf: (usage: SyncedComponentUsage) => string
): SyncedComponentUsage[][] {
  if (!components || components.length === 0) {
    return [];
  }
  const byComponent = new Map<string, SyncedComponentUsage[]>();
  for (const usage of components) {
    const key = keyOf(usage);
    const existing = byComponent.get(key);
    if (existing) {
      existing.push(usage);
    } else {
      byComponent.set(key, [usage]);
    }
  }
  return [...byComponent.values()];
}

/**
 * ISS-6884: the identity a part must keep WHOLE — the group the receiver will
 * prune on, which is not always the group the desktop shipped.
 *
 * `persistSessionComponentUsage` rewrites command rows twice before it computes
 * its branch-bucket prune: `admitSyncedCommandUsage` collapses the leading slash
 * run and SUMS the rows that then share an identity (`//clear` + `/clear`), and
 * `foldSkillShadowedCommandUsage` re-keys a slash-invoked `command|/x` onto
 * `skill|x` and sums it into that bucket. Both merges are payload-local. Split
 * across parts they cannot run: the later part's prune would delete the branch
 * buckets the earlier part wrote, and its upsert would REPLACE the summed
 * invocation count rather than add to it — a silent undercount that could not
 * happen while the whole set rode one payload.
 *
 * So a command is keyed by the bare name it could fold onto, and a skill by its
 * own name, which puts every row of one fold family in one part. The desktop
 * cannot know whether a given fold will actually fire (that needs the target's
 * resolved-skill inventory), so this deliberately over-groups: a genuine
 * `/deploy` rides with a `deploy` skill it will never merge into. Two extra
 * groups in one part costs nothing; splitting a fold family costs invocations.
 * Both key helpers are the shared ones the receiver itself uses, so the producer
 * and consumer cannot drift on what "the same identity" means.
 */
export function componentUsageMergeKey(usage: SyncedComponentUsage): string {
  if (usage.componentKind === AgentComponentKind.Command) {
    // Normalize FIRST: the receiver folds on the admitted key, so `//clear` has
    // to reach the same bare name `/clear` does.
    const bareName = slashKeyBareName(
      normalizeCommandComponentKey(usage.componentKey)
    );
    if (bareName) {
      return `${FOLD_FAMILY_KEY_PREFIX}${bareName}`;
    }
  }
  if (usage.componentKind === AgentComponentKind.Skill) {
    return `${FOLD_FAMILY_KEY_PREFIX}${usage.componentKey}`;
  }
  return componentUsageWireKey(usage);
}

/**
 * ISS-6884: the identity a usage row is SHIPPED under. NUL-joined, matching the
 * cloud's own group key: no component kind or key can contain it, so two
 * distinct groups can never collide into one.
 *
 * This is the pre-ISS-6884 grouping, and it remains the unit of the PARITY
 * BASELINE even though pagination groups on the coarser fold-family key above.
 */
export function componentUsageWireKey(usage: SyncedComponentUsage): string {
  return `${usage.componentKind}\u0000${usage.componentKey}`;
}

/**
 * Leads with NUL so a fold-family key can never collide with a
 * `<kind>\u0000<key>` group key — no component kind starts with NUL.
 */
const FOLD_FAMILY_KEY_PREFIX = "\u0000fold\u0000";

/** Wire rows one component-usage group contributes to a chunk's array. */
export function componentUsageGroupRowCount(
  group: SyncedComponentUsage[]
): number {
  return group.length;
}
