import type { ArtifactSubtype } from "@repo/api/src/types/artifact";
import { normalizeArtifactSubtype } from "@repo/api/src/types/artifact";
import type { TreeNode } from "@repo/api/src/types/project-tree";
import type { BasicUser } from "@repo/api/src/types/user";
import type { Artifact } from "@repo/database";

// FEA-3956: the persisted `subtype` is narrowed to the canonical API
// `ArtifactSubtype` (which excludes the input-only `ISSUE`). Prisma's generated
// enum now includes `ISSUE`, but rows never store it (map-in-code, PRD-560 dec.
// 2); `normalizeArtifactRowSubtype` maps any skewed value down to the persisted
// set at the point these rows are shaped into the wire contract, so the tree
// `Artifact`/`TreeChild` types stay exact.
export type ArtifactWithAssignee = Omit<Artifact, "subtype"> & {
  subtype: ArtifactSubtype | null;
  assignee: BasicUser | null;
};

/**
 * FEA-3956: normalize a Prisma artifact row's persisted subtype to the canonical
 * API set before it is shaped into the wire `Artifact`/`TreeChild` contract.
 * Rows never store the canonical `ISSUE` (map-in-code, PRD-560 dec. 2), but the
 * generated Prisma enum now includes it; mapping keeps a skewed value resolving
 * to `FEATURE` instead of leaking `ISSUE` into the tree contract.
 */
export function normalizeArtifactRowSubtype(
  row: Omit<Artifact, "subtype"> & {
    subtype: Artifact["subtype"];
    assignee: BasicUser | null;
  }
): ArtifactWithAssignee {
  return row.subtype
    ? { ...row, subtype: normalizeArtifactSubtype(row.subtype) }
    : { ...row, subtype: null };
}

/**
 * Order root nodes by stack rank ASC, NULLs last, with createdAt DESC and then
 * artifact id ASC as tiebreakers (PRD-421). The migration in
 * `20260528220059_backfill_artifact_sort_order` seeds every existing root
 * document with a deterministic sortOrder, so NULL handling is mostly a
 * compatibility window for any rows created between migration and the
 * createDocument update in PLN-755 T-A.6 that assigns sortOrder atomically.
 *
 * Shared by the per-project tree and the assignee-scoped tree (FEA-1651) so the
 * two responses cannot order their roots by parallel, drifting rules.
 *
 * ISS-5307 / FEA-4329: the final `id` comparison is what makes this a TOTAL
 * order. `sortOrder` is not unique (NULLs during the migration window, and two
 * roots can carry the same rank), and `createdAt` is not unique either — rows
 * written in the same transaction routinely share a millisecond. With both
 * equal the comparator used to return 0, leaving those roots in whatever order
 * the driver happened to hand back, which differs between reads. That is
 * invisible to an unbounded caller that receives every root anyway, but a
 * BOUNDED read slices this list: two reads that disagree about the order of a
 * tied pair drop one root from the bound and admit the other, so a row can be
 * skipped entirely or served twice. Ordering ties by the artifact's unique id
 * makes the sequence reproducible across reads, which is the precondition for
 * slicing it at all.
 */
export function compareByStackRank(a: TreeNode, b: TreeNode): number {
  const aRank = a.root.sortOrder;
  const bRank = b.root.sortOrder;
  if (aRank !== null && bRank !== null) {
    if (aRank !== bRank) {
      return aRank - bRank;
    }
  } else if (aRank === null && bRank !== null) {
    return 1;
  } else if (aRank !== null && bRank === null) {
    return -1;
  }
  // Both null OR equal — fall through to createdAt DESC.
  const byCreatedAt = b.root.createdAt.getTime() - a.root.createdAt.getTime();
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  // Same rank AND same timestamp: break the tie on the unique id so the
  // sequence is identical on every read and a bounded slice is stable.
  return a.root.id.localeCompare(b.root.id);
}
