/**
 * ISS-10472 Phase A: the SQL root derivation agrees with the shipped Node one,
 * and the page it slices can reach past the anchor cap that is the defect.
 *
 * Runs against a real Postgres because every property under test is a property
 * of the QUERY: a recursive CTE's termination, `DISTINCT ON` picking the
 * climb's terminal, the total aggregated in the page's own snapshot and own
 * statement, and `LIMIT`/`OFFSET` over an ordering the database — not the
 * comparator — applies. None of that is decidable against a fake.
 *
 * Parity is asserted against `assignedArtifactTreeService`, the SHIPPED read,
 * rather than against the private helpers it composes. The question this slice
 * has to answer is whether readers see the same root rows after the derivation
 * moves into SQL, and only the public surface answers that.
 */

import { LinkType } from "@repo/api/src/types/artifact";
import {
  type AssignedTreeSort,
  AssignedTreeSortDirection,
  AssignedTreeSortKey,
} from "@repo/api/src/types/assigned-tree-sort";
import { IssueStatus } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import { createLegacyProducesLinks } from "@/__tests__/support/artifact-links/legacy-produces-cycle.test-helpers";
import {
  resolvePageDescendants,
  resolveRootPage,
} from "@/app/artifacts/assigned-artifact-tree-root-page";
import { assignedArtifactTreeService } from "@/app/artifacts/assigned-artifact-tree-service";
import { generateSlug } from "@/app/documents/document-utils";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";
import {
  hasDatabase,
  link,
  PAGE_SIZE,
  seedArtifact,
  shippedRootIds,
} from "./assigned-tree-page-helpers";

const organizations = createCommittedTestOrganizationTracker();

describe.skipIf(!hasDatabase)("ISS-10472 Phase A root page (Postgres)", () => {
  it("derives the same roots as the shipped Node walk", async () => {
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectA = await createTestProject(organizationId, assignee.id, {
      name: "Root Page A",
    });
    const projectB = await createTestProject(organizationId, assignee.id, {
      name: "Root Page B",
    });
    const base = { organizationId, createdById: assignee.id };

    // A two-level same-project chain: the anchor's root is the grandparent,
    // which is itself unassigned. Only the upward walk can find it.
    const grandparent = await seedArtifact({
      ...base,
      assigneeId: null,
      projectId: projectA,
      name: "grandparent",
    });
    const parent = await seedArtifact({
      ...base,
      assigneeId: null,
      projectId: projectA,
      name: "parent",
    });
    const anchor = await seedArtifact({
      ...base,
      assigneeId: assignee.id,
      projectId: projectA,
      name: "anchor",
    });
    await link(organizationId, grandparent.id, parent.id);
    await link(organizationId, parent.id, anchor.id);

    // A CROSS-PROJECT parent. `sharesProject` refuses it, so the anchor is its
    // own root and the parent must never be promoted to a top-level row.
    const foreignParent = await seedArtifact({
      ...base,
      assigneeId: null,
      projectId: projectB,
      name: "foreign-parent",
    });
    const crossProjectAnchor = await seedArtifact({
      ...base,
      assigneeId: assignee.id,
      projectId: projectA,
      name: "cross-project-anchor",
    });
    await link(organizationId, foreignParent.id, crossProjectAnchor.id);

    // A 2-cycle a database written before cycle admission can still hold;
    // neither derivation may drop the component or spin on it.
    const cycleA = await seedArtifact({
      ...base,
      assigneeId: assignee.id,
      projectId: projectA,
      name: "cycle-a",
    });
    const cycleB = await seedArtifact({
      ...base,
      assigneeId: null,
      projectId: projectA,
      name: "cycle-b",
    });
    await link(organizationId, cycleA.id, cycleB.id);
    await createLegacyProducesLinks([
      {
        organizationId,
        sourceId: cycleB.id,
        targetId: cycleA.id,
        linkType: LinkType.Produces,
      },
    ]);

    const page = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: PAGE_SIZE * 10,
      offset: 0,
    });
    const shipped = await shippedRootIds(
      assignee.id,
      organizationId,
      assignee.id
    );

    expect([...page.ids].sort()).toEqual([...shipped].sort());
    // Named explicitly, so a derivation that merely returns the anchors still
    // fails: the grandparent is the root and the foreign parent is not a row.
    expect(page.ids).toContain(grandparent.id);
    expect(page.ids).not.toContain(foreignParent.id);
    expect(page.ids).not.toContain(anchor.id);
  });

  it("reaches a root past the anchor cap that is the defect", async () => {
    // The read this replaces fetched at most MAX_TREE_ANCHORS + 1 = 501 anchor
    // ids into Node, so root 501 was unreachable by any route. Seeded one past
    // that boundary; the assertion is that the LAST root is on the last page.
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Beyond The Cap",
    });
    const total = 505;
    for (let index = 0; index < total; index++) {
      await seedArtifact({
        organizationId,
        createdById: assignee.id,
        assigneeId: assignee.id,
        projectId,
        name: `capped-${index}`,
        sortOrder: index,
      });
    }

    const first = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: PAGE_SIZE,
      offset: 0,
    });
    expect(first.total).toBe(total);

    const lastOffset = total - PAGE_SIZE;
    const last = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: PAGE_SIZE,
      offset: lastOffset,
    });
    expect(last.ids).toHaveLength(PAGE_SIZE);
    expect(last.total).toBe(total);
    // `sortOrder` ascending is the first stack-rank key, so the highest
    // sortOrder is the last row of the last page.
    const highest = await withDb((db) =>
      db.artifact.findFirst({
        where: { organizationId, assigneeId: assignee.id },
        orderBy: { sortOrder: "desc" },
        select: { id: true },
      })
    );
    expect(last.ids.at(-1)).toBe(highest?.id);
  });

  it("pages without skipping or repeating a root", async () => {
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Page Boundary",
    });
    const total = 25;
    for (let index = 0; index < total; index++) {
      await seedArtifact({
        organizationId,
        createdById: assignee.id,
        assigneeId: assignee.id,
        projectId,
        // Deliberately NOT a distinct sortOrder per row: three rows share one,
        // so the created_at/id tiebreak is what keeps the order total. Without
        // a tie here the tiebreak could be deleted and this stays green.
        name: `paged-${index}`,
        sortOrder: index % 8,
      });
    }

    const unpaged = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: total,
      offset: 0,
    });
    const walked: string[] = [];
    for (let offset = 0; offset < total; offset += PAGE_SIZE) {
      const page = await resolveRootPage({
        assigneeId: assignee.id,
        organizationId,
        viewerUserId: assignee.id,
        limit: PAGE_SIZE,
        offset,
      });
      expect(page.total).toBe(total);
      walked.push(...page.ids);
    }

    expect(walked).toEqual(unpaged.ids);
    expect(new Set(walked).size).toBe(total);
  });

  it("counts the total in the page's own statement", async () => {
    // The acceptance criterion forbids `50 items, total 49`. One window
    // function over the same scan cannot disagree with the rows it counted,
    // which a second COUNT query could.
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "One Snapshot",
    });
    for (let index = 0; index < 3; index++) {
      await seedArtifact({
        organizationId,
        createdById: assignee.id,
        assigneeId: assignee.id,
        projectId,
        name: `snapshot-${index}`,
      });
    }

    const page = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: 2,
      offset: 0,
    });

    expect(page.ids).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it("reports the real total on a page past the end of a non-empty set", async () => {
    // A 0 here would be read as an empty SET, and the caller clamps off the
    // total — so it could never get back into range (tamsinb, PR #9026).
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Past The End",
    });
    for (let index = 0; index < 3; index++) {
      await seedArtifact({
        organizationId,
        createdById: assignee.id,
        assigneeId: assignee.id,
        projectId,
        name: `past-end-${index}`,
      });
    }

    const page = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: 2,
      offset: 40,
    });

    expect(page.ids).toEqual([]);
    expect(page.total).toBe(3);
  });

  it("reports ONE root for a cycle with two assigned members", async () => {
    // Both climbs terminate on a different member, so each used to come back a
    // root — and the materializer then emitted each artifact as a root AND as
    // the other's child, repeating one component across pages (whitlockk, PR
    // #9026). The unpaged walk refuses one closing edge and reports one root.
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Both Assigned Cycle",
    });
    const base = { organizationId, createdById: assignee.id, projectId };
    const cycleA = await seedArtifact({
      ...base,
      assigneeId: assignee.id,
      name: "both-cycle-a",
    });
    const cycleB = await seedArtifact({
      ...base,
      assigneeId: assignee.id,
      name: "both-cycle-b",
    });
    await link(organizationId, cycleA.id, cycleB.id);
    await createLegacyProducesLinks([
      {
        organizationId,
        sourceId: cycleB.id,
        targetId: cycleA.id,
        linkType: LinkType.Produces,
      },
    ]);

    const page = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: PAGE_SIZE,
      offset: 0,
    });
    const shipped = await shippedRootIds(
      assignee.id,
      organizationId,
      assignee.id
    );

    expect(page.ids).toHaveLength(1);
    expect(page.total).toBe(1);
    // ONE root is the contract; WHICH member is not. Node breaks a cycle at
    // whichever closing edge its frontier reaches first, so the unpaged walk
    // answers one member with a single assigned member and the other with two
    // — the adoption-order dependence `canonicalParentLateralSql` already
    // records. Asserted as a count on both sides rather than as identity, so
    // this case pins what actually holds.
    expect(shipped).toHaveLength(1);
    expect([cycleA.id, cycleB.id]).toContain(page.ids[0]);
  });

  it("renders a both-assigned cycle once across single-root pages", async () => {
    // `limit 1` is the shape the defect was visible in: the same component came
    // back on page 0 and page 1 under two different roots.
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Cycle Across Pages",
    });
    const base = { organizationId, createdById: assignee.id, projectId };
    const cycleA = await seedArtifact({
      ...base,
      assigneeId: assignee.id,
      name: "paged-cycle-a",
    });
    const cycleB = await seedArtifact({
      ...base,
      assigneeId: assignee.id,
      name: "paged-cycle-b",
    });
    await link(organizationId, cycleA.id, cycleB.id);
    await createLegacyProducesLinks([
      {
        organizationId,
        sourceId: cycleB.id,
        targetId: cycleA.id,
        linkType: LinkType.Produces,
      },
    ]);

    const first = await assignedArtifactTreeService.getAssignedArtifactTreePage(
      assignee.id,
      organizationId,
      assignee.id,
      { limit: 1, offset: 0 }
    );
    const second =
      await assignedArtifactTreeService.getAssignedArtifactTreePage(
        assignee.id,
        organizationId,
        assignee.id,
        { limit: 1, offset: 1 }
      );

    expect(first.nodes).toHaveLength(1);
    expect(second.nodes).toEqual([]);
    // The whole component is still on the page it does appear on.
    const rendered = [
      first.nodes[0]?.root.id,
      ...(first.nodes[0]?.children ?? []).map((child) => child.id),
    ];
    expect([...rendered].sort()).toEqual([cycleA.id, cycleB.id].sort());
  });

  it("scopes to one organization and one assignee", async () => {
    const organizationId = await organizations.create();
    const otherOrganizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const otherAssignee = await createTestUser(organizationId);
    const outsider = await createTestUser(otherOrganizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Scoped",
    });
    const otherProjectId = await createTestProject(
      otherOrganizationId,
      outsider.id,
      { name: "Scoped Elsewhere" }
    );

    const mine = await seedArtifact({
      organizationId,
      createdById: assignee.id,
      assigneeId: assignee.id,
      projectId,
      name: "mine",
    });
    await seedArtifact({
      organizationId,
      createdById: assignee.id,
      assigneeId: otherAssignee.id,
      projectId,
      name: "someone-elses",
    });
    await seedArtifact({
      organizationId: otherOrganizationId,
      createdById: outsider.id,
      assigneeId: outsider.id,
      projectId: otherProjectId,
      name: "another-org",
    });

    const page = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: PAGE_SIZE,
      offset: 0,
    });

    expect(page.ids).toEqual([mine.id]);
    expect(page.total).toBe(1);
  });

  it("counts no BRANCH root, which the board is required to drop", async () => {
    // `pruneBranchSubtrees` removes a BRANCH-typed root on the client
    // (ISS-12463). If the server counted one, the footer would promise a row
    // that cannot render — "No footer states a range it cannot reach".
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Branch Root",
    });

    const branchRoot = await withDb((db) =>
      db.artifact.create({
        data: {
          name: "branch-as-root",
          slug: generateSlug(),
          type: ArtifactType.BRANCH,
          status: IssueStatus.Todo,
          organizationId,
          createdById: assignee.id,
          assigneeId: null,
          projectId,
        },
        select: { id: true },
      })
    );
    // The anchor hangs off the branch, so the upward climb terminates on it.
    const anchorArtifact = await seedArtifact({
      organizationId,
      createdById: assignee.id,
      assigneeId: assignee.id,
      projectId,
      name: "branch-child-anchor",
    });
    await link(organizationId, branchRoot.id, anchorArtifact.id);

    const page = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: PAGE_SIZE,
      offset: 0,
    });

    expect(page.ids).not.toContain(branchRoot.id);
    expect(page.total).toBe(page.ids.length);
  });

  it("searches the whole assigned set, not one page, and treats % literally", async () => {
    // Server-side search is what keeps the box honest once the board pages: a
    // client filter over one page would search the rows on screen. The `%` row
    // is the pattern-injection case `escapeSqlLikeLiteral` exists for — without
    // the escape, "100%" matches every title merely starting "100".
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Search Scope",
    });
    const base = {
      organizationId,
      createdById: assignee.id,
      assigneeId: assignee.id,
      projectId,
    };

    const exact = await seedArtifact({
      ...base,
      name: "100% coverage",
      sortOrder: 0,
    });
    await seedArtifact({ ...base, name: "100 almost", sortOrder: 1 });
    await seedArtifact({ ...base, name: "unrelated", sortOrder: 2 });
    // Padding past one page, so a page-local filter would miss the match.
    for (let index = 0; index < PAGE_SIZE * 2; index++) {
      await seedArtifact({
        ...base,
        name: `filler-${index}`,
        sortOrder: 10 + index,
      });
    }

    const matched = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: PAGE_SIZE,
      offset: 0,
      filters: { search: "100%" },
    });

    // Exactly the literal match: "100 almost" must NOT come back.
    expect(matched.ids).toEqual([exact.id]);
    expect(matched.total).toBe(1);

    // Case-insensitive, and a blank term narrows nothing rather than everything.
    const caseInsensitive = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: PAGE_SIZE,
      offset: 0,
      filters: { search: "COVERAGE" },
    });
    expect(caseInsensitive.ids).toEqual([exact.id]);

    const blank = await resolveRootPage({
      assigneeId: assignee.id,
      organizationId,
      viewerUserId: assignee.id,
      limit: PAGE_SIZE,
      offset: 0,
      filters: { search: "   " },
    });
    expect(blank.total).toBe(PAGE_SIZE * 2 + 3);
  });

  it("materializes only the requested roots' subtrees", async () => {
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Only This Page",
    });
    const base = { organizationId, createdById: assignee.id, projectId };

    const wanted = await seedArtifact({
      ...base,
      assigneeId: assignee.id,
      name: "wanted-root",
    });
    const wantedChild = await seedArtifact({
      ...base,
      assigneeId: null,
      name: "wanted-child",
    });
    await link(organizationId, wanted.id, wantedChild.id);

    const offPage = await seedArtifact({
      ...base,
      assigneeId: assignee.id,
      name: "off-page-root",
    });
    const offPageChild = await seedArtifact({
      ...base,
      assigneeId: null,
      name: "off-page-child",
    });
    await link(organizationId, offPage.id, offPageChild.id);

    const descendants = await resolvePageDescendants({
      organizationId,
      rootIds: [wanted.id],
    });

    expect(descendants.map((row) => row.id)).toEqual([wantedChild.id]);
    expect(descendants.map((row) => row.rootId)).toEqual([wanted.id]);
  });

  it("serves the paged tree with the same rows the unpaged read builds", async () => {
    // End-to-end through the service: the paged derivation must produce the
    // same node shape the unpaged one does, not merely the same root ids.
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Service Parity",
    });
    const base = { organizationId, createdById: assignee.id, projectId };

    const root = await seedArtifact({
      ...base,
      assigneeId: assignee.id,
      name: "svc-root",
    });
    const child = await seedArtifact({
      ...base,
      assigneeId: null,
      name: "svc-child",
    });
    const grandchild = await seedArtifact({
      ...base,
      assigneeId: null,
      name: "svc-grandchild",
    });
    await link(organizationId, root.id, child.id);
    await link(organizationId, child.id, grandchild.id);

    const unpaged = await assignedArtifactTreeService.getAssignedArtifactTree(
      assignee.id,
      organizationId,
      assignee.id
    );
    const paged = await assignedArtifactTreeService.getAssignedArtifactTreePage(
      assignee.id,
      organizationId,
      assignee.id,
      { limit: PAGE_SIZE, offset: 0 }
    );

    expect(paged.page).toEqual({ offset: 0, limit: PAGE_SIZE, total: 1 });
    expect(paged.nodes.map((node) => node.root.id)).toEqual(
      unpaged.nodes.map((node) => node.root.id)
    );
    expect(paged.nodes[0]?.children.map((row) => [row.id, row.depth])).toEqual(
      unpaged.nodes[0]?.children.map((row) => [row.id, row.depth])
    );
    // The unpaged read omits `page` entirely, which is how a client tells a
    // paged response from a complete one.
    expect(unpaged.page).toBeUndefined();
    expect(unpaged.truncation).toBeUndefined();
    expect(paged.truncation).toBeUndefined();
  });

  it("pages root groups through the service, total unchanged", async () => {
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Service Paging",
    });
    for (let index = 0; index < 7; index++) {
      await seedArtifact({
        organizationId,
        createdById: assignee.id,
        assigneeId: assignee.id,
        projectId,
        name: `svc-page-${index}`,
        sortOrder: index,
      });
    }

    const firstPage =
      await assignedArtifactTreeService.getAssignedArtifactTreePage(
        assignee.id,
        organizationId,
        assignee.id,
        { limit: 3, offset: 0 }
      );
    const lastPage =
      await assignedArtifactTreeService.getAssignedArtifactTreePage(
        assignee.id,
        organizationId,
        assignee.id,
        { limit: 3, offset: 6 }
      );

    expect(firstPage.nodes).toHaveLength(3);
    expect(firstPage.page?.total).toBe(7);
    expect(lastPage.nodes).toHaveLength(1);
    expect(lastPage.page).toEqual({ offset: 6, limit: 3, total: 7 });
    // Disjoint pages: the last page's row is not on the first.
    const firstIds = firstPage.nodes.map((node) => node.root.id);
    expect(firstIds).not.toContain(lastPage.nodes[0]?.root.id);
  });

  /**
   * ISS-12636: the PRODUCTION statement, executed with a sort.
   *
   * `assigned-tree-root-sort-parity` proves the ORDER BY against Postgres, but
   * over its own `FROM artifacts a` — a different FROM clause than this one. So
   * nothing it asserts can fail if `rootPageSql` stops splicing the expression
   * in, or splices the assignee join where the slice cannot see it. These cases
   * execute the composed statement, which is the only thing that can.
   */
  it("orders the page by the requested column, not by stack rank", async () => {
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Sorted Page",
    });
    // Titles deliberately disagree with stack rank, so a read that ignored the
    // sort comes back in the opposite order rather than an ambiguous one.
    const seeded = await Promise.all(
      [
        { name: "aaa-first-by-title", sortOrder: 300 },
        { name: "mmm-second-by-title", sortOrder: 200 },
        { name: "zzz-third-by-title", sortOrder: 100 },
      ].map((row) =>
        seedArtifact({
          assigneeId: assignee.id,
          createdById: assignee.id,
          name: row.name,
          organizationId,
          projectId,
          sortOrder: row.sortOrder,
        })
      )
    );
    const [aaa, mmm, zzz] = seeded.map((row) => row.id);
    const page = (sort: AssignedTreeSort | undefined) =>
      resolveRootPage({
        assigneeId: assignee.id,
        limit: 10,
        offset: 0,
        organizationId,
        sort,
        viewerUserId: assignee.id,
      });

    const unsorted = await page(undefined);
    const ascending = await page({
      direction: AssignedTreeSortDirection.Asc,
      key: AssignedTreeSortKey.Title,
    });
    const descending = await page({
      direction: AssignedTreeSortDirection.Desc,
      key: AssignedTreeSortKey.Title,
    });

    expect(unsorted.ids).toEqual([zzz, mmm, aaa]);
    expect(ascending.ids).toEqual([aaa, mmm, zzz]);
    expect(descending.ids).toEqual([zzz, mmm, aaa]);
    // The total is of the renderable set and must not move with the ordering.
    expect(ascending.total).toBe(3);
    expect(descending.total).toBe(3);
  });

  it("executes the assignee sort, whose key needs a join the slice must carry", async () => {
    // The one key that joins. If `rootPageSql` omits the join, Postgres raises
    // "missing FROM-clause entry for table assignee" and this case errors
    // rather than returning a wrong order.
    const organizationId = await organizations.create();
    const viewer = await createTestUser(organizationId, {
      firstName: "Zoe",
      lastName: "Adams",
    });
    const projectId = await createTestProject(organizationId, viewer.id, {
      name: "Assignee Sorted Page",
    });
    const assigned = await seedArtifact({
      assigneeId: viewer.id,
      createdById: viewer.id,
      name: "has-an-assignee",
      organizationId,
      projectId,
      sortOrder: 10,
    });

    const sorted = await resolveRootPage({
      assigneeId: viewer.id,
      limit: 10,
      offset: 0,
      organizationId,
      sort: {
        direction: AssignedTreeSortDirection.Asc,
        key: AssignedTreeSortKey.Assignee,
      },
      viewerUserId: viewer.id,
    });

    expect(sorted.ids).toEqual([assigned.id]);
    expect(sorted.total).toBe(1);
  });

  it("threads the sort from the service through to the statement", async () => {
    // The service's `paging.sort` pass-through has its own mutation: deleting
    // it leaves the SQL suites green because they call `resolveRootPage`
    // directly. This drives the service.
    const organizationId = await organizations.create();
    const assignee = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, assignee.id, {
      name: "Service Sorted",
    });
    const seeded = await Promise.all(
      [
        { name: "aaa-service", sortOrder: 300 },
        { name: "zzz-service", sortOrder: 100 },
      ].map((row) =>
        seedArtifact({
          assigneeId: assignee.id,
          createdById: assignee.id,
          name: row.name,
          organizationId,
          projectId,
          sortOrder: row.sortOrder,
        })
      )
    );
    const [aaa, zzz] = seeded.map((row) => row.id);

    const sorted =
      await assignedArtifactTreeService.getAssignedArtifactTreePage(
        assignee.id,
        organizationId,
        assignee.id,
        {
          limit: 10,
          offset: 0,
          sort: {
            direction: AssignedTreeSortDirection.Asc,
            key: AssignedTreeSortKey.Title,
          },
        }
      );

    expect(sorted.nodes.map((node) => node.root.id)).toEqual([aaa, zzz]);
  });
});
