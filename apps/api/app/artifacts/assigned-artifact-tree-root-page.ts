import { LinkType } from "@repo/api/src/types/artifact";
import type { AssignedTreeSort } from "@repo/api/src/types/assigned-tree-sort";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import {
  assignedAnchorScopeSql,
  buildAnchorNarrowingSql,
  type TreeAnchorFilters,
} from "./assigned-artifact-tree-anchors";
import { MAX_CHAIN_DEPTH } from "./assigned-artifact-tree-graph";
import {
  assignedTreeRootOrderBySql,
  assignedTreeRootSortJoinSql,
} from "./assigned-tree-root-sort";

/**
 * ISS-10472 Phase A: order and count the assignee's ROOT GROUPS in one
 * statement, ids only.
 *
 * The read this replaces fetched at most `MAX_TREE_ANCHORS + 1` anchor ids into
 * Node and climbed to roots there, so a reader with more than 500 assigned
 * artifacts could not reach row 501 by any route. Here the anchor set is an
 * UNCAPPED CTE and `LIMIT`/`OFFSET` apply to the distinct roots instead, which
 * is what makes the later pages reachable at all.
 *
 * It reproduces the Node derivation in `assigned-artifact-tree-service.ts`
 * (`classifyParentEdges` → `adoptCanonicalParent` → `resolveInScopeRootIds`),
 * with one deliberate difference recorded in {@link canonicalParentLateralSql}.
 */
export type RootPage = {
  /** Root artifact ids for this page, in the requested order. */
  ids: string[];
  /**
   * Total distinct roots behind the same predicate, read in the SAME snapshot
   * as `ids` via `count(*) OVER ()`. An exact total, not a floor: two
   * statements could report `50 items, total 49` across a concurrent write,
   * and one window function cannot.
   */
  total: number;
};

export type RootPageInput = {
  assigneeId: string;
  organizationId: string;
  viewerUserId: string;
  limit: number;
  offset: number;
  filters?: TreeAnchorFilters;
  /** ISS-12636: the requested root column, or stack rank when absent. */
  sort?: AssignedTreeSort;
};

/** Resolve one page of root groups, plus the exact total behind it. */
export async function resolveRootPage(input: RootPageInput): Promise<RootPage> {
  const rows = await withDb((db) =>
    db.$queryRaw<Array<{ id: string | null; total: number }>>(
      rootPageSql(input)
    )
  );
  // The count is aggregated independently of the page, so an OUT-OF-RANGE page
  // still reports the real total. Reporting 0 there instead would be read as an
  // empty SET — the caller cannot clamp off a 0, and the grouped read already
  // returns the real total on the same request (marisolashgrove/tamsinb, PR
  // #9026).
  return {
    ids: rows.flatMap((row) => (row.id === null ? [] : [row.id])),
    total: Number(rows[0]?.total ?? 0),
  };
}

/**
 * `PRODUCES` as an inlined enum literal.
 *
 * Built from the enum constant, never from input. Inlined for the same reason
 * `SESSION_TYPE_LITERAL` is in the anchors module: a bound `$n::"LinkType"` is
 * an I/O cast Postgres does not fold, so it proves nothing against the
 * `(organization_id, target_id, link_type)` index the upward climb depends on.
 */
const PRODUCES_LINK_LITERAL = Prisma.raw(`'${LinkType.Produces}'::"LinkType"`);

/** `BRANCH` inlined from the enum constant, never from input. */
const BRANCH_TYPE_LITERAL = Prisma.raw(
  `'${ArtifactType.BRANCH}'::"ArtifactType"`
);

/**
 * One cursor's canonical parent, or no row.
 *
 * Suppressed edges retain lineage but cannot parent a tree node. An explicit
 * canonical edge wins over legacy edges; ties retain the established creation
 * order and id tiebreak. The same election runs in the downward walk below.
 *
 * `project_id IS NOT NULL AND = ` is `sharesProject`: the per-project tree
 * treats a null on either side as no shared project (FEA-1749 makes
 * `project_id` nullable for every type), so two project-less artifacts must
 * never merge into one component. A bare `=` already yields NULL for a null
 * operand, so the explicit `IS NOT NULL` is documentation rather than logic.
 */
function canonicalParentLateralSql(organizationId: string): Prisma.Sql {
  return Prisma.sql`
          SELECT l.source_id AS parent_id, parent.project_id AS parent_project_id
          FROM artifact_links l
          JOIN artifacts parent
            ON parent.id = l.source_id
           AND parent.organization_id = ${organizationId}::uuid
          WHERE l.organization_id = ${organizationId}::uuid
            AND l.target_id = climb.cursor_id
            AND l.link_type = ${PRODUCES_LINK_LITERAL}
            AND l.metadata #> '{hierarchy,suppressed}' IS DISTINCT FROM 'true'::jsonb
            AND parent.project_id IS NOT NULL
            AND parent.project_id = climb.cursor_project_id
          ORDER BY
            COALESCE(l.metadata #> '{hierarchy,canonical}' = 'true'::jsonb, false) DESC,
            l.created_at ASC, l.id ASC
          LIMIT 1`;
}

/**
 * The root derivation, as a `WITH RECURSIVE` prefix every root read shares.
 *
 * Extracted because ISS-10472 has TWO readers of it — the ungrouped page below
 * and the grouped section read in `assigned-tree-root-sections.ts` — and a
 * second copy of this climb would be a second definition of what a root IS.
 * The consumer appends its own final `SELECT` over `distinct_roots`.
 *
 * `roots` takes the TERMINAL of each anchor's climb (`DISTINCT ON (anchor_id)
 * ... ORDER BY anchor_id, depth DESC`) rather than every node without a
 * canonical parent. The difference is load-bearing and `resolveInScopeRootIds`
 * states it: an artifact reached only as a CROSS-PROJECT parent has no
 * canonical parent of its own, and promoting it to a top-level row would show
 * the viewer someone else's work. Climbing from the anchors yields exactly the
 * component roots that carry one.
 *
 * `artifact_links` is user-writable, so a canonical-parent CYCLE (A→B→A) is
 * representable and has no node without a parent to be the root. Node's
 * `createsCycle` refuses to adopt whichever closing edge it reaches first,
 * which leaves exactly ONE member unparented; the climb cannot copy that,
 * because a climb started from each member terminates on a different one — so
 * with two members of one cycle assigned, BOTH came back as roots and the
 * materializer then emitted each as a root AND as the other's child, repeating
 * one component across pages (whitlockk, PR #9026).
 *
 * `closes_cycle` marks the row whose parent is already on the path, which ends
 * that climb and leaves the cycle's members as the path's tail. The cycle's
 * REPRESENTATIVE is then the member whose canonical parent is the LOWEST id in
 * it — which is where Node's refusal lands when it climbs from that lowest
 * member, and which every member of the cycle computes identically, so the
 * component collapses to one root however many of its members are assigned.
 * The nodes BELOW it keep their canonical parents, so the downward walk renders
 * the component once: its own path guard stops it closing back on the
 * representative. `MAX_CHAIN_DEPTH` bounds the climb a second time, so a guard
 * bug cannot spin.
 *
 * The anchor set is UNCAPPED, which is the fix: the read this replaces took at
 * most `MAX_TREE_ANCHORS + 1` anchors into Node and climbed there, so a reader
 * with more than 500 assigned artifacts could not reach row 501 by any route.
 */
export function distinctRootsCteSql(input: {
  assigneeId: string;
  organizationId: string;
  viewerUserId: string;
  filters?: TreeAnchorFilters;
}): Prisma.Sql {
  const { assigneeId, organizationId, viewerUserId } = input;
  const narrowing = buildAnchorNarrowingSql(viewerUserId, input.filters ?? {});
  return Prisma.sql`
    WITH RECURSIVE anchors AS (
      SELECT a.id, a.project_id
      FROM artifacts a
      WHERE ${assignedAnchorScopeSql(assigneeId, organizationId)}
        ${narrowing}
    ),
    climb AS (
      SELECT
        anchors.id AS anchor_id,
        anchors.id AS cursor_id,
        anchors.project_id AS cursor_project_id,
        0 AS depth,
        ARRAY[anchors.id] AS path,
        false AS closes_cycle
      FROM anchors
      UNION ALL
      SELECT
        climb.anchor_id,
        parent.parent_id,
        parent.parent_project_id,
        climb.depth + 1,
        climb.path || parent.parent_id,
        parent.parent_id = ANY(climb.path)
      FROM climb
      CROSS JOIN LATERAL (${canonicalParentLateralSql(organizationId)}) parent
      WHERE climb.depth < ${MAX_CHAIN_DEPTH}
        AND NOT climb.closes_cycle
    ),
    terminals AS (
      SELECT DISTINCT ON (climb.anchor_id)
        climb.anchor_id,
        climb.cursor_id,
        climb.path,
        climb.closes_cycle
      FROM climb
      ORDER BY climb.anchor_id, climb.depth DESC
    ),
    -- A climb that CLOSED repeats one id as its last element, so the path from
    -- that id's first occurrence to the element before the repeat IS the cycle,
    -- in parent order. WITH ORDINALITY rather than an array slice: a slice
    -- keeps the source array's lower bound, so its subscripts would not start
    -- at 1 and the positions below would be off by the tail's length.
    cycle_members AS (
      SELECT
        terminals.anchor_id,
        step.member,
        row_number() OVER (
          PARTITION BY terminals.anchor_id ORDER BY step.ord
        ) AS position,
        count(*) OVER (PARTITION BY terminals.anchor_id) AS member_count
      FROM terminals
      CROSS JOIN LATERAL unnest(terminals.path)
        WITH ORDINALITY AS step(member, ord)
      WHERE terminals.closes_cycle
        AND step.ord >= array_position(
              terminals.path,
              terminals.path[array_length(terminals.path, 1)]
            )
        AND step.ord < array_length(terminals.path, 1)
    ),
    cycle_lowest AS (
      SELECT DISTINCT ON (anchor_id) anchor_id, position, member_count
      FROM cycle_members
      ORDER BY anchor_id, member
    ),
    -- Position i's canonical parent is position i+1, and the last member's is
    -- the first, so the member whose parent is the LOWEST one sits one position
    -- before it, wrapping.
    cycle_roots AS (
      SELECT cycle_members.anchor_id, cycle_members.member AS root_id
      FROM cycle_members
      JOIN cycle_lowest ON cycle_lowest.anchor_id = cycle_members.anchor_id
      WHERE cycle_members.position =
        (
          (cycle_lowest.position - 2 + cycle_lowest.member_count)
          % cycle_lowest.member_count
        ) + 1
    ),
    roots AS (
      SELECT COALESCE(cycle_roots.root_id, terminals.cursor_id) AS root_id
      FROM terminals
      LEFT JOIN cycle_roots ON cycle_roots.anchor_id = terminals.anchor_id
    ),
    distinct_roots AS (
      SELECT DISTINCT roots.root_id FROM roots
    )`;
}

/**
 * Phase A's ungrouped page: the shared root derivation, ordered by the
 * requested column and sliced by row offset. The grouped board slices by
 * SECTION instead, in `assigned-tree-root-sections.ts`.
 *
 * The total is a CTE aggregate joined to the slice rather than
 * `count(*) OVER ()` beside it: a window function has no row to attach to on a
 * page past the end, so an out-of-range request reported 0 and a caller reading
 * that as an empty set could not clamp back into range. One statement either
 * way, so both still observe one snapshot and cannot report `50 items,
 * total 49`.
 *
 * `LEFT JOIN LATERAL` off a single-row source is what keeps the total readable
 * when the slice is empty: the one row survives with a NULL id, which the
 * caller drops.
 */
function rootPageSql(input: RootPageInput): Prisma.Sql {
  const { limit, offset } = input;
  return Prisma.sql`
    ${distinctRootsCteSql(input)},
    -- Branches are not tasks (ISS-12463), and pruneBranchSubtrees removes a
    -- BRANCH-typed root on the client. Counting one here would make the total
    -- promise a row the board is required to drop, so the footer would read
    -- "10 of 500" over nine rows. The count has to be of what can render.
    renderable AS (
      SELECT a.*
      FROM distinct_roots
      JOIN artifacts a ON a.id = distinct_roots.root_id
      WHERE a.type <> ${BRANCH_TYPE_LITERAL}
    )
    SELECT (SELECT count(*)::int FROM renderable) AS total, page.id
    FROM (SELECT 1) AS counted
    LEFT JOIN LATERAL (
      SELECT a.id
      FROM renderable a
      -- The sort's own join goes HERE rather than on renderable, which the
      -- count also reads: the assignee column is the only key needing one, the
      -- count does not care how rows are ordered, and renderable carries
      -- assignee_id forward so the slice still has something to join on.
      ${assignedTreeRootSortJoinSql(input.sort)}
      ORDER BY ${assignedTreeRootOrderBySql(input.sort)}
      LIMIT ${limit} OFFSET ${offset}
    ) page ON true
  `;
}

/** One flattened descendant of a page root, in depth-first order. */
export type PageDescendant = {
  rootId: string;
  id: string;
  parentId: string;
  depth: number;
};

/**
 * ISS-10472 Phase B: flatten ONLY the subtrees under this page's roots.
 *
 * Depth-first is the contract `flattenCanonicalSubtree` states, not a
 * preference — `TreeNode` promises "flattened children in depth-first order",
 * so a breadth-first walk emits `[child, sibling, grandchild]` where every
 * consumer expects `[child, grandchild, sibling]`. Sibling order is
 * `created_at ASC, id ASC`, which is `compareByCreatedAtThenId`, the order the
 * assignee-scoped tree's `groupChildren` applies.
 *
 * Returns ids and depths; column hydration stays with the caller so this
 * function owns the WALK and nothing else.
 */
export async function resolvePageDescendants(input: {
  organizationId: string;
  rootIds: string[];
}): Promise<PageDescendant[]> {
  if (input.rootIds.length === 0) {
    return [];
  }
  const rows = await withDb((db) =>
    db.$queryRaw<
      Array<{ root_id: string; id: string; parent_id: string; depth: number }>
    >(pageDescendantsSql(input.organizationId, input.rootIds))
  );
  return rows.map((row) => ({
    rootId: row.root_id,
    id: row.id,
    parentId: row.parent_id,
    depth: Number(row.depth),
  }));
}

/** Resolve rank-ordered descendants without a rollout-mode parameter. */
export async function resolveManuallyOrderedPageDescendants(input: {
  organizationId: string;
  rootIds: string[];
}): Promise<PageDescendant[]> {
  if (input.rootIds.length === 0) {
    return [];
  }
  const rows = await withDb((db) =>
    db.$queryRaw<
      Array<{ root_id: string; id: string; parent_id: string; depth: number }>
    >(manualPageDescendantsSql(input.organizationId, input.rootIds))
  );
  return rows.map((row) => ({
    rootId: row.root_id,
    id: row.id,
    parentId: row.parent_id,
    depth: Number(row.depth),
  }));
}

/**
 * The sibling sort key as ONE fixed-width text element.
 *
 * v1 planned to precompute sibling ordinals because a window function is not
 * allowed in a recursive term. Encoding the key itself sidesteps that: Postgres
 * compares arrays element-wise, and a fixed-width `YYYYMMDDHH24MISSUS` stamp
 * followed by the uuid sorts lexicographically exactly as
 * `(created_at ASC, id ASC)` sorts — so `ORDER BY sort_path` IS the depth-first
 * walk, with no second pass and nothing precomputed over rows this page never
 * touches.
 *
 * Fixed width is load-bearing. A variable-width stamp would let `'9…'` sort
 * after `'10…'`, which is the one way this expression can silently stop
 * matching the comparator.
 */
const SIBLING_SORT_KEY_SQL = Prisma.raw(
  `to_char(child.created_at, 'YYYYMMDDHH24MISSUS') || child.id::text`
);

const MANUAL_CHILD_SORT_KEY_SQL = Prisma.sql`
  CASE WHEN l.sort_order IS NULL THEN '1' ELSE '0' END ||
  lpad((COALESCE(l.sort_order, 0)::bigint + 2147483648)::text, 10, '0') ||
  ${SIBLING_SORT_KEY_SQL}
`;

/**
 * Descend from the page's roots, keeping only edges whose child names THIS
 * node as its canonical parent.
 *
 * The canonical test is re-derived per candidate child rather than precomputed
 * over the organization: a precomputed edge set would have to resolve every
 * artifact's parent before the walk could start, which is the unbounded work
 * Phase B exists to avoid. The correlated subquery is the same
 * same-project canonical-PRODUCES rule {@link canonicalParentLateralSql} applies
 * on the way up, so a node cannot be a child here without being a descendant
 * there.
 *
 * That one test also carries the cross-project rule, which is why no separate
 * `child.project_id = descend.project_id` filter appears here: the subquery
 * already requires the child's canonical parent to share the CHILD's project,
 * so a parent in another project can never equal `descend.id`, and a null
 * project on either side yields no canonical row at all. Mutation testing is
 * what established that — deleting such a filter changed no result, which made
 * it an unreachable branch rather than a guard. If it ever returns as a
 * pre-filter it comes back with a measurement, not on suspicion.
 *
 * `NOT (… = ANY(descend.path))` guards the same user-writable cycle the upward
 * climb guards, and `MAX_CHAIN_DEPTH` bounds it a second time. Node's `visited`
 * set does this work there.
 */
function pageDescendantsSql(
  organizationId: string,
  rootIds: string[]
): Prisma.Sql {
  const org = Prisma.sql`${organizationId}::uuid`;
  return Prisma.sql`
    WITH RECURSIVE descend AS (
      SELECT
        root.id AS root_id,
        root.id AS id,
        NULL::uuid AS parent_id,
        root.project_id,
        0 AS depth,
        ARRAY[]::text[] AS sort_path,
        ARRAY[root.id] AS path
      FROM artifacts root
      WHERE root.organization_id = ${org}
        AND root.id IN (${Prisma.join(
          rootIds.map((id) => Prisma.sql`${id}::uuid`)
        )})
      UNION ALL
      SELECT
        descend.root_id,
        child.id,
        descend.id,
        child.project_id,
        descend.depth + 1,
        descend.sort_path || (${SIBLING_SORT_KEY_SQL}),
        descend.path || child.id
      FROM descend
      JOIN artifact_links l
        ON l.organization_id = ${org}
       AND l.source_id = descend.id
       AND l.link_type = ${PRODUCES_LINK_LITERAL}
       AND l.metadata #> '{hierarchy,suppressed}' IS DISTINCT FROM 'true'::jsonb
      JOIN artifacts child
        ON child.id = l.target_id
       AND child.organization_id = ${org}
      WHERE descend.depth < ${MAX_CHAIN_DEPTH}
        AND NOT (child.id = ANY(descend.path))
        AND descend.id = (
          SELECT canonical.source_id
          FROM artifact_links canonical
          JOIN artifacts canonical_parent
            ON canonical_parent.id = canonical.source_id
           AND canonical_parent.organization_id = ${org}
          WHERE canonical.organization_id = ${org}
            AND canonical.target_id = child.id
            AND canonical.link_type = ${PRODUCES_LINK_LITERAL}
            AND canonical.metadata #> '{hierarchy,suppressed}' IS DISTINCT FROM 'true'::jsonb
            AND canonical_parent.project_id IS NOT NULL
            AND canonical_parent.project_id = child.project_id
          ORDER BY
            COALESCE(canonical.metadata #> '{hierarchy,canonical}' = 'true'::jsonb, false) DESC,
            canonical.created_at ASC, canonical.id ASC
          LIMIT 1
        )
    )
    SELECT descend.root_id, descend.id, descend.parent_id, descend.depth
    FROM descend
    WHERE descend.depth > 0
    ORDER BY descend.root_id, descend.sort_path
  `;
}

function manualPageDescendantsSql(
  organizationId: string,
  rootIds: string[]
): Prisma.Sql {
  const org = Prisma.sql`${organizationId}::uuid`;
  return Prisma.sql`
    WITH RECURSIVE descend AS (
      SELECT
        root.id AS root_id,
        root.id AS id,
        NULL::uuid AS parent_id,
        root.project_id,
        0 AS depth,
        ARRAY[]::text[] AS sort_path,
        ARRAY[root.id] AS path
      FROM artifacts root
      WHERE root.organization_id = ${org}
        AND root.id IN (${Prisma.join(
          rootIds.map((id) => Prisma.sql`${id}::uuid`)
        )})
      UNION ALL
      SELECT
        descend.root_id,
        child.id,
        descend.id,
        child.project_id,
        descend.depth + 1,
        descend.sort_path || (${MANUAL_CHILD_SORT_KEY_SQL}),
        descend.path || child.id
      FROM descend
      JOIN artifact_links l
        ON l.organization_id = ${org}
       AND l.source_id = descend.id
       AND l.link_type = ${PRODUCES_LINK_LITERAL}
       AND l.metadata #> '{hierarchy,suppressed}' IS DISTINCT FROM 'true'::jsonb
      JOIN artifacts child
        ON child.id = l.target_id
       AND child.organization_id = ${org}
      WHERE descend.depth < ${MAX_CHAIN_DEPTH}
        AND NOT (child.id = ANY(descend.path))
        AND descend.id = (
          SELECT canonical.source_id
          FROM artifact_links canonical
          JOIN artifacts canonical_parent
            ON canonical_parent.id = canonical.source_id
           AND canonical_parent.organization_id = ${org}
          WHERE canonical.organization_id = ${org}
            AND canonical.target_id = child.id
            AND canonical.link_type = ${PRODUCES_LINK_LITERAL}
            AND canonical.metadata #> '{hierarchy,suppressed}' IS DISTINCT FROM 'true'::jsonb
            AND canonical_parent.project_id IS NOT NULL
            AND canonical_parent.project_id = child.project_id
          ORDER BY
            COALESCE(canonical.metadata #> '{hierarchy,canonical}' = 'true'::jsonb, false) DESC,
            canonical.created_at ASC, canonical.id ASC
          LIMIT 1
        )
    )
    SELECT descend.root_id, descend.id, descend.parent_id, descend.depth
    FROM descend
    WHERE descend.depth > 0
    ORDER BY descend.root_id, descend.sort_path
  `;
}

/** A cross-project PRODUCES edge into one of the page's nodes. */
export type PageExternalParent = {
  childId: string;
  parentId: string;
  linkType: LinkType;
};

/**
 * ISS-10472: the cross-project parents of THIS page's nodes.
 *
 * The unpaged read gets these for free — `classifyParentEdges` sorts every edge
 * it loaded into canonical or external — so a paged response that omitted them
 * would drop a field the contract carries and `prune-branch-subtrees` passes
 * through to the client. Scoped to the page's node ids, so the cost follows the
 * page rather than the organization.
 *
 * The predicate is the exact complement of the canonical rule: an edge whose
 * parent does NOT share the child's project, which includes a null project on
 * either side. `sharesProject` treats two nulls as unrelated rather than equal
 * (FEA-1749), so `IS DISTINCT FROM` is wrong here and the null cases are
 * spelled out.
 *
 * Deduped on `(child, parent)` in SQL, matching the `seenExternalKeys` set the
 * Node path keys the same way: two edges of different link types between the
 * same pair are one external parent, not two.
 */
export async function resolvePageExternalParents(input: {
  organizationId: string;
  nodeIds: string[];
}): Promise<PageExternalParent[]> {
  if (input.nodeIds.length === 0) {
    return [];
  }
  const org = Prisma.sql`${input.organizationId}::uuid`;
  const rows = await withDb((db) =>
    db.$queryRaw<Array<{ child_id: string; parent_id: string }>>(Prisma.sql`
      SELECT DISTINCT l.target_id AS child_id, l.source_id AS parent_id
      FROM artifact_links l
      JOIN artifacts child
        ON child.id = l.target_id
       AND child.organization_id = ${org}
      JOIN artifacts parent
        ON parent.id = l.source_id
       AND parent.organization_id = ${org}
      WHERE l.organization_id = ${org}
        AND l.link_type = ${PRODUCES_LINK_LITERAL}
        -- ONE array parameter, never one bind per id: nodeIds is every
        -- descendant the page's subtrees returned and nothing caps it before
        -- here, so an IN list would hit Postgres' 65535-parameter limit and
        -- 500 (tamsinb, PR #9026). MAX_TREE_NODES only binds later, in
        -- loadArtifactsById, which chunks.
        AND l.target_id = ANY(${input.nodeIds}::uuid[])
        AND (
          parent.project_id IS NULL
          OR child.project_id IS NULL
          OR parent.project_id <> child.project_id
        )
    `)
  );
  return rows.map((row) => ({
    childId: row.child_id,
    parentId: row.parent_id,
    // Only PRODUCES expresses a parent-child relationship, and the predicate
    // selects nothing else, so this is the edge's type rather than a default.
    linkType: LinkType.Produces,
  }));
}
