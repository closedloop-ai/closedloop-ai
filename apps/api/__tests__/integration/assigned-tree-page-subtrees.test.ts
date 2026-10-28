/**
 * ISS-10472 Phase B: the subtree walk UNDER a page's roots, and the
 * cross-project parent edges of the nodes it reached.
 *
 * Separate from the root-selection suite because the properties differ: these
 * are about the DOWNWARD recursive walk — depth-first order, the canonical
 * parent test re-derived per candidate child, and the exact complement of that
 * test for an external parent. Real Postgres for the same reason: none of it is
 * decidable against a fake.
 */

import { LinkType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  resolveManuallyOrderedPageDescendants,
  resolvePageDescendants,
  resolvePageExternalParents,
  resolveRootPage,
} from "@/app/artifacts/assigned-artifact-tree-root-page";
import { assignedArtifactTreeService } from "@/app/artifacts/assigned-artifact-tree-service";
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
} from "./assigned-tree-page-helpers";

const organizations = createCommittedTestOrganizationTracker();

describe.skipIf(!hasDatabase)(
  "ISS-10472 Phase B page subtrees (Postgres)",
  () => {
    it("flattens a page's subtrees depth-first, matching the shipped walk", async () => {
      // The shape that separates depth-first from breadth-first: two branches
      // under one root, each with a grandchild. Depth-first is
      // [childA, grandchildA, childB, grandchildB]; breadth-first would be
      // [childA, childB, grandchildA, grandchildB]. A single-branch fixture
      // cannot tell them apart.
      const organizationId = await organizations.create();
      const assignee = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, assignee.id, {
        name: "Depth First",
      });
      const base = { organizationId, createdById: assignee.id, projectId };

      const root = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        name: "df-root",
      });
      // Seeded in sibling order: `created_at ASC` is the sibling key, and these
      // are created in sequence, so childA precedes childB.
      const childA = await seedArtifact({
        ...base,
        assigneeId: null,
        name: "df-child-a",
      });
      const grandchildA = await seedArtifact({
        ...base,
        assigneeId: null,
        name: "df-grandchild-a",
      });
      const childB = await seedArtifact({
        ...base,
        assigneeId: null,
        name: "df-child-b",
      });
      const grandchildB = await seedArtifact({
        ...base,
        assigneeId: null,
        name: "df-grandchild-b",
      });
      await link(organizationId, root.id, childA.id);
      await link(organizationId, childA.id, grandchildA.id);
      await link(organizationId, root.id, childB.id);
      await link(organizationId, childB.id, grandchildB.id);

      const descendants = await resolvePageDescendants({
        organizationId,
        rootIds: [root.id],
      });

      expect(descendants.map((row) => row.id)).toEqual([
        childA.id,
        grandchildA.id,
        childB.id,
        grandchildB.id,
      ]);
      expect(descendants.map((row) => row.depth)).toEqual([1, 2, 1, 2]);
      expect(descendants.map((row) => row.parentId)).toEqual([
        root.id,
        childA.id,
        root.id,
        childB.id,
      ]);

      // Parity with the shipped read, which flattens the same subtree through
      // `flattenCanonicalSubtree`. This is the assertion that would catch the
      // SQL and the Node walk drifting apart.
      const tree = await assignedArtifactTreeService.getAssignedArtifactTree(
        assignee.id,
        organizationId,
        assignee.id
      );
      const shipped = tree.nodes.find((node) => node.root.id === root.id);
      expect(shipped?.children.map((child) => child.id)).toEqual(
        descendants.map((row) => row.id)
      );
      expect(shipped?.children.map((child) => child.depth)).toEqual(
        descendants.map((row) => row.depth)
      );
    });

    it("orders manual child placements before unplaced oldest-first ties in SQL and both tree reads", async () => {
      const organizationId = await organizations.create();
      const assignee = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, assignee.id, {
        name: "Manual child order",
      });
      const base = { organizationId, createdById: assignee.id, projectId };
      const root = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        name: "manual-root",
      });
      const older = await seedArtifact({
        ...base,
        assigneeId: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        name: "unplaced-old",
      });
      const tieA = await seedArtifact({
        ...base,
        assigneeId: null,
        createdAt: new Date("2026-07-03T00:00:00.000Z"),
        name: "unplaced-tie-a",
      });
      const tieB = await seedArtifact({
        ...base,
        assigneeId: null,
        createdAt: new Date("2026-07-03T00:00:00.000Z"),
        name: "unplaced-tie-b",
      });
      const rankedLater = await seedArtifact({
        ...base,
        assigneeId: null,
        createdAt: new Date("2026-07-05T00:00:00.000Z"),
        name: "ranked-later",
      });
      const rankedFirst = await seedArtifact({
        ...base,
        assigneeId: null,
        createdAt: new Date("2026-07-06T00:00:00.000Z"),
        name: "ranked-first",
      });
      await link(organizationId, root.id, tieB.id);
      await link(organizationId, root.id, rankedLater.id, 2000);
      await link(organizationId, root.id, older.id);
      await link(organizationId, root.id, rankedFirst.id, 1000);
      await link(organizationId, root.id, tieA.id);

      const tiedIds = [tieA.id, tieB.id].sort();
      const expectedManual = [
        rankedFirst.id,
        rankedLater.id,
        older.id,
        ...tiedIds,
      ];
      const defaultDescendants = await resolvePageDescendants({
        organizationId,
        rootIds: [root.id],
      });
      expect(defaultDescendants.map((row) => row.id)).toEqual([
        older.id,
        ...tiedIds,
        rankedLater.id,
        rankedFirst.id,
      ]);

      const descendants = await resolveManuallyOrderedPageDescendants({
        organizationId,
        rootIds: [root.id],
      });
      expect(descendants.map((row) => row.id)).toEqual(expectedManual);

      const unpaged =
        await assignedArtifactTreeService.getManuallyOrderedAssignedArtifactTree(
          assignee.id,
          organizationId,
          assignee.id,
          {}
        );
      expect(unpaged.nodes[0]?.children.map((child) => child.id)).toEqual(
        expectedManual
      );
      const paged =
        await assignedArtifactTreeService.getManuallyOrderedAssignedArtifactTreePage(
          assignee.id,
          organizationId,
          assignee.id,
          { limit: 10, offset: 0 },
          {}
        );
      expect(paged.nodes[0]?.children.map((child) => child.id)).toEqual(
        expectedManual
      );
    });

    it("descends only the canonical parent when a child has two", async () => {
      // Without this fixture the canonical-parent check can be deleted from the
      // descent and every other case stays green: each child there has exactly
      // one parent, so ANY produces-edge and THE canonical edge agree.
      const organizationId = await organizations.create();
      const assignee = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, assignee.id, {
        name: "Two Parents",
      });
      const base = { organizationId, createdById: assignee.id, projectId };

      const root = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        name: "tp-root",
      });
      const firstParent = await seedArtifact({
        ...base,
        assigneeId: null,
        name: "tp-parent-first",
      });
      const secondParent = await seedArtifact({
        ...base,
        assigneeId: null,
        name: "tp-parent-second",
      });
      const shared = await seedArtifact({
        ...base,
        assigneeId: null,
        name: "tp-shared-child",
      });
      await link(organizationId, root.id, firstParent.id);
      await link(organizationId, root.id, secondParent.id);
      // Link order decides: the EARLIER edge is canonical, so `shared` hangs off
      // firstParent and must appear exactly once.
      await link(organizationId, firstParent.id, shared.id);
      await link(organizationId, secondParent.id, shared.id);

      const descendants = await resolvePageDescendants({
        organizationId,
        rootIds: [root.id],
      });

      const sharedRows = descendants.filter((row) => row.id === shared.id);
      expect(sharedRows).toHaveLength(1);
      expect(sharedRows[0]?.parentId).toBe(firstParent.id);
      expect(descendants.map((row) => row.id)).toEqual([
        firstParent.id,
        shared.id,
        secondParent.id,
      ]);
    });

    it("matches the unpaged canonical parent and root promotion while retaining secondary lineage", async () => {
      const organizationId = await organizations.create();
      const assignee = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, assignee.id, {
        name: "Canonical parent parity",
      });
      const base = { organizationId, createdById: assignee.id, projectId };
      const oldParent = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        name: "old-parent",
      });
      const newParent = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        name: "new-parent",
      });
      const child = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        name: "shared-child",
      });
      await link(organizationId, oldParent.id, child.id);
      await link(organizationId, newParent.id, child.id);
      const edge = (sourceId: string) => ({
        organizationId,
        sourceId,
        targetId: child.id,
        linkType: LinkType.Produces,
      });
      await withDb((db) =>
        db.artifactLink.updateMany({
          where: edge(oldParent.id),
          data: { metadata: { hierarchy: { suppressed: true } } },
        })
      );
      await withDb((db) =>
        db.artifactLink.updateMany({
          where: edge(newParent.id),
          data: { metadata: { hierarchy: { canonical: true } } },
        })
      );

      const read = async () => {
        const unpaged =
          await assignedArtifactTreeService.getAssignedArtifactTree(
            assignee.id,
            organizationId,
            assignee.id
          );
        const paged =
          await assignedArtifactTreeService.getAssignedArtifactTreePage(
            assignee.id,
            organizationId,
            assignee.id,
            { limit: 10, offset: 0 }
          );
        const shape = (tree: typeof unpaged) =>
          new Map(
            tree.nodes.map((node) => [
              node.root.id,
              node.children.map((descendant) => descendant.id),
            ])
          );
        expect(shape(paged)).toEqual(shape(unpaged));
        return paged;
      };

      const reparented = await read();
      expect(
        reparented.nodes.find((node) => node.root.id === oldParent.id)?.children
      ).toEqual([]);
      expect(
        reparented.nodes
          .find((node) => node.root.id === newParent.id)
          ?.children.map((row) => row.id)
      ).toEqual([child.id]);

      await withDb((db) =>
        db.artifactLink.updateMany({
          where: edge(newParent.id),
          data: { metadata: { hierarchy: { suppressed: true } } },
        })
      );
      const promoted = await read();
      expect(promoted.nodes.some((node) => node.root.id === child.id)).toBe(
        true
      );
      const retained = await withDb((db) =>
        db.artifactLink.count({
          where: {
            organizationId,
            targetId: child.id,
            linkType: LinkType.Produces,
          },
        })
      );
      expect(retained).toBe(2);
    });

    it("treats explicit noncanonical and absent metadata equally before the creation tie-break", async () => {
      const organizationId = await organizations.create();
      const assignee = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, assignee.id, {
        name: "Noncanonical parent parity",
      });
      const base = { organizationId, createdById: assignee.id, projectId };
      const olderParent = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        name: "older-parent",
      });
      const newerParent = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        name: "newer-parent",
      });
      const child = await seedArtifact({
        ...base,
        assigneeId: null,
        name: "unranked-child",
      });
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId,
            sourceId: olderParent.id,
            targetId: child.id,
            linkType: LinkType.Produces,
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
          },
        })
      );
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId,
            sourceId: newerParent.id,
            targetId: child.id,
            linkType: LinkType.Produces,
            metadata: { hierarchy: { canonical: false } },
            createdAt: new Date("2026-07-02T00:00:00.000Z"),
          },
        })
      );

      const args = [assignee.id, organizationId, assignee.id] as const;
      const unpaged = await assignedArtifactTreeService.getAssignedArtifactTree(
        ...args
      );
      const paged =
        await assignedArtifactTreeService.getAssignedArtifactTreePage(...args, {
          limit: 10,
          offset: 0,
        });
      const childParent = (tree: typeof unpaged) =>
        tree.nodes.find((node) =>
          node.children.some((descendant) => descendant.id === child.id)
        )?.root.id;
      expect(childParent(unpaged)).toBe(olderParent.id);
      expect(childParent(paged)).toBe(olderParent.id);
    });

    it("does not descend into a cross-project child", async () => {
      const organizationId = await organizations.create();
      const assignee = await createTestUser(organizationId);
      const projectA = await createTestProject(organizationId, assignee.id, {
        name: "Descent A",
      });
      const projectB = await createTestProject(organizationId, assignee.id, {
        name: "Descent B",
      });
      const base = { organizationId, createdById: assignee.id };

      const root = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        projectId: projectA,
        name: "xp-root",
      });
      const sameProject = await seedArtifact({
        ...base,
        assigneeId: null,
        projectId: projectA,
        name: "xp-same-project-child",
      });
      const otherProject = await seedArtifact({
        ...base,
        assigneeId: null,
        projectId: projectB,
        name: "xp-other-project-child",
      });
      await link(organizationId, root.id, sameProject.id);
      await link(organizationId, root.id, otherProject.id);

      const descendants = await resolvePageDescendants({
        organizationId,
        rootIds: [root.id],
      });

      // The shipped read reports a cross-project link in `externalParents` and
      // never as a node, so the flatten must not pull it in as a child row.
      expect(descendants.map((row) => row.id)).toEqual([sameProject.id]);
    });

    it("reports a cross-project parent of a page node as external", async () => {
      // The complement of the descent rule: the same edge the flatten refuses to
      // follow must still be REPORTED, because the unpaged read reports it and a
      // paged response that dropped it would lose a field the contract carries.
      const organizationId = await organizations.create();
      const assignee = await createTestUser(organizationId);
      const projectA = await createTestProject(organizationId, assignee.id, {
        name: "External A",
      });
      const projectB = await createTestProject(organizationId, assignee.id, {
        name: "External B",
      });
      const base = { organizationId, createdById: assignee.id };

      const anchor = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        projectId: projectA,
        name: "ext-anchor",
      });
      const foreignParent = await seedArtifact({
        ...base,
        assigneeId: null,
        projectId: projectB,
        name: "ext-foreign-parent",
      });
      const sameProjectParent = await seedArtifact({
        ...base,
        assigneeId: null,
        projectId: projectA,
        name: "ext-same-project-parent",
      });
      await link(organizationId, foreignParent.id, anchor.id);
      await link(organizationId, sameProjectParent.id, anchor.id);

      const external = await resolvePageExternalParents({
        organizationId,
        nodeIds: [anchor.id],
      });

      // The same-project parent is canonical, not external, so it must not appear.
      expect(external).toEqual([
        {
          childId: anchor.id,
          parentId: foreignParent.id,
          linkType: "PRODUCES",
        },
      ]);
    });

    it("treats two null projects as unrelated, not as a shared one", async () => {
      // `sharesProject` is `both non-null AND equal`, so a null project on either
      // side is NOT a shared project (FEA-1749 makes it nullable for every type).
      // Without this fixture the null arms of the external predicate can be
      // deleted and every other case stays green.
      const organizationId = await organizations.create();
      const assignee = await createTestUser(organizationId);
      const base = {
        organizationId,
        createdById: assignee.id,
        projectId: null,
      };

      const projectless = await seedArtifact({
        ...base,
        assigneeId: assignee.id,
        name: "null-project-anchor",
      });
      const projectlessParent = await seedArtifact({
        ...base,
        assigneeId: null,
        name: "null-project-parent",
      });
      await link(organizationId, projectlessParent.id, projectless.id);

      // Not adopted as a canonical parent, so the anchor is its own root...
      const page = await resolveRootPage({
        assigneeId: assignee.id,
        organizationId,
        viewerUserId: assignee.id,
        limit: PAGE_SIZE,
        offset: 0,
      });
      expect(page.ids).toEqual([projectless.id]);
      expect(
        await resolvePageDescendants({
          organizationId,
          rootIds: [projectless.id],
        })
      ).toEqual([]);

      // ...and the edge is still reported rather than lost.
      expect(
        await resolvePageExternalParents({
          organizationId,
          nodeIds: [projectless.id],
        })
      ).toEqual([
        {
          childId: projectless.id,
          parentId: projectlessParent.id,
          linkType: "PRODUCES",
        },
      ]);
    });
  }
);
