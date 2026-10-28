import {
  type ArtifactSubtype,
  LinkType,
  normalizeArtifactSubtype,
} from "@repo/api/src/types/artifact";
import type { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import type { DocumentStatusMutationCapability } from "@repo/api/src/types/document-status-mutation";
import type { TreeChild, TreeNode } from "@repo/api/src/types/project-tree";
import type { SessionStatus } from "@repo/api/src/types/session-status";
import type { BasicUser } from "@repo/api/src/types/user";
import { type Artifact, ArtifactType, Prisma } from "@repo/database";

// FEA-3956: the persisted `subtype` is narrowed to the canonical API
// `ArtifactSubtype` (which excludes the input-only `ISSUE`). Prisma's generated
// enum now includes `ISSUE`, but rows never store it (map-in-code, PRD-560 dec.
// 2); `normalizeArtifactRowSubtype` maps any skewed value down to the persisted
// set at the point these rows are shaped into the wire contract, so the tree
// `Artifact`/`TreeChild` types stay exact.
export type ArtifactWithAssignee = Omit<Artifact, "subtype"> & {
  subtype: ArtifactSubtype | null;
  assignee: BasicUser | null;
  productEligibility?: BranchProductEligibility;
  hasCompatibilityProviderFallback?: boolean;
  displayedSessionStatus?: SessionStatus;
  statusMutation?: DocumentStatusMutationCapability;
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

/** Attach API-owned Branch eligibility without widening non-Branch rows. */
export function applyBranchProductEligibility(
  artifactsById: Map<string, ArtifactWithAssignee>,
  eligibilityById: ReadonlyMap<string, BranchProductEligibility>
): void {
  for (const [id, artifact] of artifactsById) {
    if (artifact.type !== ArtifactType.BRANCH) {
      continue;
    }
    const productEligibility = eligibilityById.get(id);
    if (productEligibility) {
      artifactsById.set(id, { ...artifact, productEligibility });
    }
  }
}

/**
 * ISS-8694: attach the server-computed DISPLAY status to Session rows without
 * widening any other kind.
 *
 * It writes `displayedSessionStatus` and never `status`. Since ISS-10364
 * retired the two DISPLAY-ONLY derivations (`stale`/`unknown`) this existed to
 * carry, `displayedById` is always empty (see `session-displayed-status-service.ts`),
 * so this loop never runs; it is left standing for ISS-11131 to remove with
 * the rest of the enrichment.
 */
export function applySessionDisplayedStatus(
  artifactsById: Map<string, ArtifactWithAssignee>,
  displayedById: ReadonlyMap<string, SessionStatus>
): void {
  for (const [id, displayedSessionStatus] of displayedById) {
    const artifact = artifactsById.get(id);
    if (artifact?.type === ArtifactType.SESSION) {
      artifactsById.set(id, { ...artifact, displayedSessionStatus });
    }
  }
}

/** Attach true-only provider fallback availability to matching Branch rows. */
export function applyBranchProviderFallbackAvailability(
  artifactsById: Map<string, ArtifactWithAssignee>,
  branchIdsWithFallback: ReadonlySet<string>
): void {
  for (const id of branchIdsWithFallback) {
    const artifact = artifactsById.get(id);
    if (artifact?.type === ArtifactType.BRANCH) {
      artifactsById.set(id, {
        ...artifact,
        hasCompatibilityProviderFallback: true,
      });
    }
  }
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
  return compareStackRankKeys(a.root, b.root);
}

/**
 * The three sort keys a stack-rank comparison reads. Any row carrying them can
 * be ordered by {@link compareStackRankKeys}, so a producer that never builds a
 * `TreeNode` — the bulk rank read in `artifact-bulk-rank-service.ts` selects
 * scalars only — orders roots by this rule instead of a private copy of it.
 */
export type StackRankKeys = {
  id: string;
  sortOrder: number | null;
  createdAt: Date;
};

/**
 * The stack-rank total order itself, over the sort keys alone. Split out of
 * {@link compareByStackRank} so tree and non-tree readers cannot drift; the
 * doc comment above states why each key is here.
 */
export function compareStackRankKeys(
  a: StackRankKeys,
  b: StackRankKeys
): number {
  const byRank = compareOptionalRanks(a.sortOrder, b.sortOrder);
  if (byRank !== null) {
    return byRank;
  }
  // Both null OR equal — fall through to createdAt DESC.
  const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime();
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  // Same rank AND same timestamp: break the tie on the unique id so the
  // sequence is identical on every read and a bounded slice is stable.
  return a.id.localeCompare(b.id);
}

/**
 * {@link compareStackRankKeys} as an `ORDER BY`, for the alias `a` that the
 * assignee-scoped anchor queries use (ISS-10471).
 *
 * Here rather than in a query because the two must agree and the only way a
 * reader can check that is to see them together. `assigned-tree-stack-rank-parity`
 * drives both over one committed fixture and requires the same sequence, so a
 * change to either side that is not made to the other fails rather than
 * silently splitting the order a page is sliced on from the order it renders in.
 *
 * `NULLS LAST` is explicit: Postgres defaults an `ASC` column to `NULLS LAST`
 * already, but the comparator's null handling is a deliberate rule (an
 * unranked artifact sorts after every ranked one), so it is written rather than
 * inherited.
 *
 * `id ASC` is `localeCompare` on the TypeScript side and `uuid` byte order
 * here. They agree because the `uuid` type normalizes to canonical lowercase
 * hex on storage, so the strings compared always have hyphens at the same four
 * positions and draw from one case — the two conditions under which ICU
 * collation and byte order coincide. That is a property of the column, not of
 * the comparator, which is why the parity suite pins it instead of asserting it
 * from the shape of this string.
 *
 * ISS-10472 Phase A is the adopting consumer: ordering and counting the ROOT
 * set needs this expression, and roots are derived by the upward climb that
 * slice introduces.
 */
export const STACK_RANK_ORDER_BY_SQL = Prisma.sql`a.sort_order ASC NULLS LAST, a.created_at DESC, a.id ASC`;

/** A declared PRODUCES edge from a child artifact up to one of its parents. */
export type ParentEdge = {
  parentId: string;
  linkType: LinkType;
  /** Relationship-owned rank; absent on version-skewed or legacy reads. */
  sortOrder?: number | null;
  /** Explicit canonical projection for a retained multi-parent relationship. */
  canonical?: boolean;
  /** Retained lineage excluded from the current canonical tree projection. */
  suppressed?: boolean;
};

/**
 * Depth-first flatten of one root's subtree over an already-resolved
 * canonical-parent forest, shaped for {@link TreeNode.children}.
 *
 * Depth-first is the CONTRACT, not a preference: `TreeChild` documents `depth`
 * against a chain and `TreeNode` promises "flattened children in depth-first
 * order", so a breadth-first walk would emit `[child, sibling, grandchild]`
 * where every consumer expects `[child, grandchild, sibling]`.
 *
 * Callers supply their own `childIdsByParent`, because sibling ORDER is the one
 * thing the two trees legitimately differ on — the per-project tree keeps
 * link-creation order, the assignee-scoped tree sorts siblings by artifact.
 * Everything else about the walk is shared so the two responses cannot drift.
 */
export function flattenCanonicalSubtree(
  rootId: string,
  artifactsById: Map<string, ArtifactWithAssignee>,
  childIdsByParent: Map<string, string[]>,
  canonicalParents: Map<string, ParentEdge>
): TreeChild[] {
  const children: TreeChild[] = [];
  const visited = new Set<string>([rootId]);
  const stack: Array<{ id: string; depth: number }> = [];
  pushCanonicalChildren(stack, childIdsByParent.get(rootId), 1);

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || visited.has(next.id)) {
      continue;
    }
    visited.add(next.id);
    const artifact = artifactsById.get(next.id);
    const edge = canonicalParents.get(next.id);
    if (!(artifact && edge)) {
      continue;
    }
    children.push({
      ...artifact,
      depth: next.depth,
      linkType: edge.linkType ?? LinkType.Produces,
      parentId: edge.parentId,
    });
    pushCanonicalChildren(stack, childIdsByParent.get(next.id), next.depth + 1);
  }

  return children;
}

/** Push a sibling list reversed so the LIFO stack still pops it in order. */
function pushCanonicalChildren(
  stack: Array<{ id: string; depth: number }>,
  childIds: string[] | undefined,
  depth: number
): void {
  if (!childIds) {
    return;
  }
  for (let index = childIds.length - 1; index >= 0; index--) {
    const id = childIds[index];
    if (id) {
      stack.push({ id, depth });
    }
  }
}

/**
 * Invert a canonical-parent map into the per-parent child lists
 * {@link flattenCanonicalSubtree} walks.
 *
 * Insertion order is adoption order, so a caller that adopts in a meaningful
 * order gets that order back as its sibling order; a caller that wants a
 * different one re-sorts the groups itself.
 */
export function groupChildIdsByParent(
  canonicalParents: Map<string, ParentEdge>
): Map<string, string[]> {
  const childIdsByParent = new Map<string, string[]>();
  for (const [childId, edge] of canonicalParents) {
    const siblings = childIdsByParent.get(edge.parentId);
    if (siblings) {
      siblings.push(childId);
      continue;
    }
    childIdsByParent.set(edge.parentId, [childId]);
  }
  return childIdsByParent;
}

/**
 * Oldest first, with the unique id breaking an exact `createdAt` tie.
 *
 * The tiebreak is what makes this a TOTAL order: rows written in one
 * transaction routinely share a millisecond, and a comparator that returned 0
 * there would leave those rows in whatever order the driver handed back — a
 * different order on the next read. Both trees resolve a canonical parent and
 * order siblings off this, so neither may depend on how the rows arrived.
 */
export function compareByCreatedAtThenId(
  a: { id: string; createdAt: Date },
  b: { id: string; createdAt: Date }
): number {
  const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  return a.id.localeCompare(b.id);
}

/** Order children by their canonical parent relationship, then stable row keys. */
export function compareParentRankedArtifacts(
  left: StackRankKeys,
  right: StackRankKeys,
  canonicalParents: ReadonlyMap<string, ParentEdge>
): number {
  const byRank = compareOptionalRanks(
    canonicalParents.get(left.id)?.sortOrder ?? null,
    canonicalParents.get(right.id)?.sortOrder ?? null
  );
  return byRank ?? compareByCreatedAtThenId(left, right);
}

function compareOptionalRanks(
  left: number | null,
  right: number | null
): number | null {
  if (left !== null && right !== null) {
    return left === right ? null : left - right;
  }
  if (left === null && right !== null) {
    return 1;
  }
  if (left !== null && right === null) {
    return -1;
  }
  return null;
}
