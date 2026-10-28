import type { LinkType } from "@repo/api/src/types/artifact";
import type { Prisma } from "@repo/database";
import { z } from "zod";
import { jsonObjectSchema } from "@/lib/json-schema";
import {
  compareByCreatedAtThenId,
  type ParentEdge,
} from "../artifact-tree-shared";

/**
 * Give every child exactly ONE canonical parent, drawn from its own declared
 * PRODUCES edges.
 *
 * ISS-5732: the tree used to collapse each weakly-connected component under a
 * single elected root and pin every member that root's DFS could not reach
 * beneath it with a hardcoded `parentId`. `PRD-513 -> FEA-3730 <- PRD-602` is
 * one such component, so PRD-602 and its whole branch rendered as children of
 * PRD-513 — a lineage no `artifact_link` row asserts. Resolving one REAL parent
 * per child instead makes "a root is an artifact nothing parents" the definition
 * rather than an election, so a fabricated `parentId` has nowhere to come from.
 *
 * The ticket sanctions projecting a DAG deterministically rather than
 * representing it, so a child with two parents nests under one of them: the
 * first eligible edge in the total candidate order that does not close a
 * cycle. An explicit canonical reparent wins timestamp ties, then
 * `(createdAt, id)` breaks remaining ties. The assignee-scoped tree uses the
 * same canonical preference for a shared child.
 *
 * The ordering is applied HERE rather than left to the query's `orderBy`,
 * because the projection must be a function of the rows, not of what the driver
 * happened to return.
 */
export function resolveCanonicalParents(
  internalLinks: CanonicalParentLinkRow[]
): Map<string, ParentEdge> {
  const canonicalParents = new Map<string, ParentEdge>();
  const treeRoot = new Map<string, string>();
  const sortedLinks = orderCanonicalParentCandidates(internalLinks);

  for (const link of sortedLinks) {
    const hierarchy = readCanonicalHierarchyMetadata(link.metadata);
    if (hierarchy?.suppressed === true) {
      continue;
    }
    if (canonicalParents.has(link.targetId)) {
      continue;
    }
    // The child is still unparented, so it roots its own tree: adopting this
    // parent closes a cycle exactly when that tree already contains the parent.
    // Comparing tree roots answers that in near-constant time, where walking the
    // ancestor chain per edge would be quadratic on one long lineage — and this
    // read loads a whole project with no depth cap. A cap would be worse than
    // slow: an undetected cycle leaves every member parented, so the component
    // has no root and vanishes from the response entirely.
    const parentTreeRoot = findTreeRoot(treeRoot, link.sourceId);
    if (parentTreeRoot === link.targetId) {
      continue;
    }
    canonicalParents.set(link.targetId, {
      linkType: link.linkType,
      parentId: link.sourceId,
      sortOrder: link.sortOrder,
    });
    treeRoot.set(link.targetId, parentTreeRoot);
  }

  return canonicalParents;
}

/** Root of `id`'s tree in the forest resolved so far, with path compression. */
function findTreeRoot(treeRoot: Map<string, string>, id: string): string {
  const walked: string[] = [];
  let current = id;
  let parent = treeRoot.get(current);
  while (parent !== undefined && parent !== current) {
    walked.push(current);
    current = parent;
    parent = treeRoot.get(current);
  }
  for (const node of walked) {
    treeRoot.set(node, current);
  }
  return current;
}

/**
 * The columns the project tree reads off an `artifact_links` row: the edge
 * itself, plus the `(createdAt, id)` pair the tie-break above sorts on.
 *
 * Declared beside the resolver rather than beside the read because this is what
 * makes `createdAt` and `id` load-bearing — narrowing the select past them
 * would put the projection back at the mercy of driver order.
 */
export type CanonicalParentLinkRow = {
  id: string;
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  sortOrder: number | null;
  createdAt: Date;
  /** Optional for older callers; absent metadata preserves legacy election/order. */
  metadata?: Prisma.JsonValue | null;
};

export type CanonicalHierarchyMetadata = {
  canonical?: boolean;
  managed?: boolean;
  suppressed?: boolean;
  version?: number;
};

/** Validate the hierarchy-owned namespace inside otherwise generic link metadata. */
export function readCanonicalHierarchyMetadata(
  metadata: Prisma.JsonValue | null | undefined
): CanonicalHierarchyMetadata | undefined {
  const envelope = jsonObjectSchema.safeParse(metadata);
  if (!(envelope.success && "hierarchy" in envelope.data)) {
    return undefined;
  }
  const parsed = canonicalHierarchyMetadataSchema.safeParse(
    envelope.data.hierarchy
  );
  return parsed.success ? parsed.data : undefined;
}

function orderCanonicalParentCandidates(
  links: readonly CanonicalParentLinkRow[]
): CanonicalParentLinkRow[] {
  const legacyOrder = [...links].sort(compareByCreatedAtThenId);
  const firstCandidateTime = new Map<string, number>();
  for (const link of legacyOrder) {
    if (!firstCandidateTime.has(link.targetId)) {
      firstCandidateTime.set(link.targetId, link.createdAt.getTime());
    }
  }
  return legacyOrder.sort((left, right) => {
    const leftPreferred =
      readCanonicalHierarchyMetadata(left.metadata)?.canonical === true;
    const rightPreferred =
      readCanonicalHierarchyMetadata(right.metadata)?.canonical === true;
    const leftTime = leftPreferred
      ? (firstCandidateTime.get(left.targetId) ?? left.createdAt.getTime())
      : left.createdAt.getTime();
    const rightTime = rightPreferred
      ? (firstCandidateTime.get(right.targetId) ?? right.createdAt.getTime())
      : right.createdAt.getTime();
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    const targetOrder = left.targetId.localeCompare(right.targetId);
    if (targetOrder !== 0) {
      return targetOrder;
    }
    if (leftPreferred !== rightPreferred) {
      return leftPreferred ? -1 : 1;
    }
    return compareByCreatedAtThenId(left, right);
  });
}

const canonicalHierarchyMetadataSchema = z.looseObject({
  canonical: z.boolean().optional(),
  managed: z.boolean().optional(),
  suppressed: z.boolean().optional(),
  version: z.number().int().nonnegative().optional(),
});
