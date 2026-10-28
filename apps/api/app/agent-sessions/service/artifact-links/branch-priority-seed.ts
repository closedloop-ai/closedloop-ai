import { ArtifactType } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { Priority } from "@repo/api/src/types/common";
import type { SyncedBranchArtifactRef } from "@repo/api/src/types/session-artifact-link";
import type { AgentSessionUpsertTx } from "../records";
import {
  type BranchRefAggregate,
  branchRefAggregateKey,
} from "./branch-ref-aggregate";

/** One materialized branch and the desktop-set priority its ref carried. */
export type BranchPrioritySeed = { artifactId: string; priority: Priority };

/**
 * ISS-10332 / PLN-2086 Milestone 3 step 18: the desktop-set priority per branch
 * identity (the same normalized key `persistSessionBranchArtifactLinks` folds
 * on), first present value wins. One desktop row backs every ref of a branch,
 * so its refs agree; the rule only has to be deterministic.
 */
export function branchRefPrioritiesByIdentity(
  refs: readonly SyncedBranchArtifactRef[]
): Map<string, Priority> {
  const priorities = new Map<string, Priority>();
  for (const ref of refs) {
    if (!ref.priority) {
      continue;
    }
    const key = branchRefAggregateKey({
      repositoryFullName: normalizeRepoFullName(ref.repositoryFullName),
      branchName: ref.branchName,
    });
    if (!priorities.has(key)) {
      priorities.set(key, ref.priority);
    }
  }
  return priorities;
}

/**
 * Seed each materialized branch's priority only while it holds none — the
 * `resolvePriorityPatch` rule the session seed applies, enforced here in the
 * write's own `priority: null` predicate so a `PATCH /branches/[id]` that
 * commits first always wins. Org- and type-scoped like every branch write. One
 * statement per distinct priority, so the cost is bounded by the vocabulary,
 * not by the session's branch count. A never-pushed branch never materializes,
 * so its priority stays on the desktop.
 */
export async function seedBranchPrioritiesIfUnset(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  seeds: readonly BranchPrioritySeed[]
): Promise<void> {
  const idsByPriority = new Map<Priority, string[]>();
  for (const seed of seeds) {
    const ids = idsByPriority.get(seed.priority) ?? [];
    ids.push(seed.artifactId);
    idsByPriority.set(seed.priority, ids);
  }
  for (const [priority, ids] of idsByPriority) {
    await tx.artifact.updateMany({
      where: {
        id: { in: ids },
        organizationId,
        type: ArtifactType.Branch,
        priority: null,
      },
      data: { priority },
    });
  }
}

/**
 * The aggregate a deferred identity is retried from, carrying the priority its
 * ref claimed: the retry drain materializes the branch later, in another
 * transaction, from this payload alone.
 */
export function withBranchPriorityClaim(
  aggregate: BranchRefAggregate,
  priority: Priority | undefined
): BranchRefAggregate {
  return priority ? { ...aggregate, priority } : aggregate;
}
