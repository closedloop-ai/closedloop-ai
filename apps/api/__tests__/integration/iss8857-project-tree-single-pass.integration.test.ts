import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

/**
 * ISS-8857: the project-tree read used to select the same artifact scope twice
 * — once with the assignee for the tree, once with the tag relations for the
 * `?include=details` enrichment — and re-join the two row sets in JavaScript.
 * The expectation below is a literal contract capture rather than derived from
 * the projection under change: if the read drops a column, reorders roots,
 * loses a tag on a row that has one, or leaks the raw `tagArtifacts` relation
 * onto the wire, this literal stops matching.
 */

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const SEED_INSTANT = new Date("2026-08-05T12:00:00.000Z");

/** Keys whose values are assigned by the database or the clock, not the seed. */
const VOLATILE_KEYS = new Set(["updatedAt", "email"]);

const DOCUMENT_STATUS_MUTATION = {
  allowedStatuses: [
    DocumentStatus.Draft,
    DocumentStatus.InReview,
    DocumentStatus.ChangesRequested,
    DocumentStatus.Approved,
    DocumentStatus.Executed,
    DocumentStatus.Obsolete,
  ],
  expectedStatusByIdField: "expectedStatusById",
  expectedStatusField: "expectedStatus",
} as const;

const EXPECTED_DETAILED_TREE = {
  nodes: [
    {
      root: {
        id: "<rootPrd>",
        organizationId: "<organizationId>",
        projectId: "<projectId>",
        type: "DOCUMENT",
        subtype: "PRD",
        templateForType: null,
        name: "Root PRD",
        slug: null,
        assigneeId: "<userId>",
        status: "DRAFT",
        priority: null,
        dueDate: null,
        externalUrl: null,
        sortOrder: 1000,
        createdAt: "2026-08-05T12:00:00.000Z",
        createdById: null,
        customFieldValues: [],
        updatedAt: "<volatile>",
        statusMutation: DOCUMENT_STATUS_MUTATION,
        assignee: {
          id: "<userId>",
          email: "<volatile>",
          firstName: "Test",
          lastName: "User",
          avatarUrl: null,
        },
        tags: [
          {
            id: "<sharedTag>",
            organizationId: "<organizationId>",
            name: "shared",
            color: "#111111",
            createdById: "<userId>",
            createdAt: "2026-08-05T12:00:08.000Z",
            updatedAt: "<volatile>",
          },
          {
            id: "<soloTag>",
            organizationId: "<organizationId>",
            name: "solo",
            color: "#222222",
            createdById: "<userId>",
            createdAt: "2026-08-05T12:00:09.000Z",
            updatedAt: "<volatile>",
          },
        ],
      },
      children: [
        {
          id: "<childPlan>",
          organizationId: "<organizationId>",
          projectId: "<projectId>",
          type: "DOCUMENT",
          subtype: "PRD",
          templateForType: null,
          name: "Child Plan",
          slug: null,
          assigneeId: null,
          status: "DRAFT",
          priority: null,
          dueDate: null,
          externalUrl: null,
          sortOrder: null,
          createdAt: "2026-08-05T12:00:01.000Z",
          createdById: null,
          customFieldValues: [],
          updatedAt: "<volatile>",
          statusMutation: DOCUMENT_STATUS_MUTATION,
          assignee: null,
          depth: 1,
          linkType: "PRODUCES",
          parentId: "<rootPrd>",
          tags: [
            {
              id: "<sharedTag>",
              organizationId: "<organizationId>",
              name: "shared",
              color: "#111111",
              createdById: "<userId>",
              createdAt: "2026-08-05T12:00:08.000Z",
              updatedAt: "<volatile>",
            },
          ],
        },
        {
          id: "<grandchild>",
          organizationId: "<organizationId>",
          projectId: "<projectId>",
          type: "DOCUMENT",
          subtype: "PRD",
          templateForType: null,
          name: "Grandchild Feature",
          slug: null,
          assigneeId: null,
          status: "DRAFT",
          priority: null,
          dueDate: null,
          externalUrl: null,
          sortOrder: null,
          createdAt: "2026-08-05T12:00:02.000Z",
          createdById: null,
          customFieldValues: [],
          updatedAt: "<volatile>",
          statusMutation: DOCUMENT_STATUS_MUTATION,
          assignee: null,
          depth: 2,
          linkType: "PRODUCES",
          parentId: "<childPlan>",
        },
        {
          id: "<secondChild>",
          organizationId: "<organizationId>",
          projectId: "<projectId>",
          type: "DOCUMENT",
          subtype: "PRD",
          templateForType: null,
          name: "Second Child",
          slug: null,
          assigneeId: "<userId>",
          status: "DRAFT",
          priority: null,
          dueDate: null,
          externalUrl: null,
          sortOrder: null,
          createdAt: "2026-08-05T12:00:03.000Z",
          createdById: null,
          customFieldValues: [],
          updatedAt: "<volatile>",
          statusMutation: DOCUMENT_STATUS_MUTATION,
          assignee: {
            id: "<userId>",
            email: "<volatile>",
            firstName: "Test",
            lastName: "User",
            avatarUrl: null,
          },
          depth: 1,
          linkType: "PRODUCES",
          parentId: "<rootPrd>",
        },
      ],
    },
    {
      root: {
        id: "<adoptedRoot>",
        organizationId: "<organizationId>",
        projectId: "<projectId>",
        type: "DOCUMENT",
        subtype: "PRD",
        templateForType: null,
        name: "Externally Parented Root",
        slug: null,
        assigneeId: null,
        status: "DRAFT",
        priority: null,
        dueDate: null,
        externalUrl: null,
        sortOrder: 2000,
        createdAt: "2026-08-05T12:00:04.000Z",
        createdById: null,
        customFieldValues: [],
        updatedAt: "<volatile>",
        statusMutation: DOCUMENT_STATUS_MUTATION,
        assignee: null,
      },
      children: [],
    },
  ],
  externalParents: [
    {
      childId: "<adoptedRoot>",
      parent: {
        id: "<externalParent>",
        organizationId: "<organizationId>",
        projectId: "<externalProjectId>",
        type: "DOCUMENT",
        subtype: "PRD",
        templateForType: null,
        name: "External Parent",
        slug: null,
        assigneeId: "<userId>",
        status: "DRAFT",
        priority: null,
        dueDate: null,
        externalUrl: null,
        sortOrder: 500,
        createdAt: "2026-08-05T12:00:05.000Z",
        createdById: null,
        updatedAt: "<volatile>",
        assignee: {
          id: "<userId>",
          email: "<volatile>",
          firstName: "Test",
          lastName: "User",
          avatarUrl: null,
        },
      },
      linkType: "PRODUCES",
    },
  ],
};

type Seed = {
  organizationId: string;
  otherOrganizationId: string;
  projectId: string;
  crossOrgGhostId: string;
  labels: Map<string, string>;
};

describe.skipIf(!hasDatabase)("ISS-8857 project tree single-pass read", () => {
  it("returns the detailed tree the pre-refactor two-pass read returned", async () => {
    await autoRollbackTransaction(async () => {
      const seed = await seedProject();

      const result = await projectTreeService.getProjectTreeWithDetails(
        seed.projectId,
        seed.organizationId
      );

      expect(normalize(result, seed.labels)).toStrictEqual(
        EXPECTED_DETAILED_TREE
      );
    });
  });

  it("omits tag and generation-status enrichment from the undetailed read", async () => {
    await autoRollbackTransaction(async () => {
      const seed = await seedProject();

      const result = await projectTreeService.getProjectTree(
        seed.projectId,
        seed.organizationId
      );

      const rows = result.nodes.flatMap((node) => [
        node.root,
        ...node.children,
      ]);
      expect(rows.map((row) => row.name)).toStrictEqual([
        "Root PRD",
        "Child Plan",
        "Grandchild Feature",
        "Second Child",
        "Externally Parented Root",
      ]);
      for (const row of rows) {
        expect(Object.keys(row)).not.toContain("tags");
        expect(Object.keys(row)).not.toContain("generationStatus");
        expect(Object.keys(row)).not.toContain("tagArtifacts");
      }
    });
  });

  it("excludes an artifact of another organization that names this project", async () => {
    await autoRollbackTransaction(async () => {
      const seed = await seedProject();

      const [tree, detailed] = await Promise.all([
        projectTreeService.getProjectTree(seed.projectId, seed.organizationId),
        projectTreeService.getProjectTreeWithDetails(
          seed.projectId,
          seed.organizationId
        ),
      ]);

      // The ghost row carries THIS project's `projectId` and the lowest
      // `sortOrder` in the fixture, so dropping `organizationId` from the read
      // would surface it as the first root rather than merely leaking it
      // somewhere in the list.
      for (const response of [tree, detailed]) {
        const ids = response.nodes.flatMap((node) => [
          node.root.id,
          ...node.children.map((child) => child.id),
        ]);
        expect(ids).not.toContain(seed.crossOrgGhostId);
      }

      const ghostVisibleToItsOwner = await projectTreeService.getProjectTree(
        seed.projectId,
        seed.otherOrganizationId
      );
      expect(
        ghostVisibleToItsOwner.nodes.map((node) => node.root.id)
      ).toStrictEqual([seed.crossOrgGhostId]);
    });
  });
});

function at(offsetMs: number): Date {
  return new Date(SEED_INSTANT.getTime() + offsetMs);
}

function createArtifact(input: {
  organizationId: string;
  projectId: string;
  name: string;
  assigneeId: string | null;
  sortOrder: number | null;
  createdAtOffsetMs: number;
}) {
  return withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: ArtifactType.Document,
        subtype: ArtifactSubtype.Prd,
        name: input.name,
        status: "DRAFT",
        assigneeId: input.assigneeId,
        sortOrder: input.sortOrder,
        createdAt: at(input.createdAtOffsetMs),
      },
    })
  );
}

function createProducesLink(
  organizationId: string,
  sourceId: string,
  targetId: string,
  createdAtOffsetMs: number
) {
  return withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId,
        targetId,
        linkType: LinkType.Produces,
        createdAt: at(createdAtOffsetMs),
      },
    })
  );
}

/**
 * A project whose tree exercises every shape the single-pass read has to keep
 * intact: two children under one root plus a grandchild, a tag shared by two
 * artifacts, rows with NO tags and NO assignee, an assigned row, a root reached
 * only through a cross-project (external) parent, and a row that names this
 * project while belonging to a DIFFERENT organization.
 */
async function seedProject(): Promise<Seed> {
  const organizationId = await createTestOrganization();
  const otherOrganizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const otherUser = await createTestUser(otherOrganizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const externalProjectId = await createTestProject(organizationId, user.id);

  const artifacts = {
    rootPrd: { name: "Root PRD", assignee: user.id, sortOrder: 1000, at: 0 },
    childPlan: {
      name: "Child Plan",
      assignee: null,
      sortOrder: null,
      at: 1000,
    },
    grandchild: {
      name: "Grandchild Feature",
      assignee: null,
      sortOrder: null,
      at: 2000,
    },
    secondChild: {
      name: "Second Child",
      assignee: user.id,
      sortOrder: null,
      at: 3000,
    },
    adoptedRoot: {
      name: "Externally Parented Root",
      assignee: null,
      sortOrder: 2000,
      at: 4000,
    },
  };
  const ids: Record<string, string> = {};
  for (const [key, spec] of Object.entries(artifacts)) {
    const created = await createArtifact({
      organizationId,
      projectId,
      name: spec.name,
      assigneeId: spec.assignee,
      sortOrder: spec.sortOrder,
      createdAtOffsetMs: spec.at,
    });
    ids[key] = created.id;
  }

  const externalParent = await createArtifact({
    organizationId,
    projectId: externalProjectId,
    name: "External Parent",
    assigneeId: user.id,
    sortOrder: 500,
    createdAtOffsetMs: 5000,
  });
  const crossOrgGhost = await createArtifact({
    organizationId: otherOrganizationId,
    projectId,
    name: "Cross Org Ghost",
    assigneeId: otherUser.id,
    sortOrder: 1,
    createdAtOffsetMs: 6000,
  });

  await createProducesLink(organizationId, ids.rootPrd!, ids.childPlan!, 100);
  await createProducesLink(
    organizationId,
    ids.childPlan!,
    ids.grandchild!,
    200
  );
  await createProducesLink(organizationId, ids.rootPrd!, ids.secondChild!, 300);
  await createProducesLink(
    organizationId,
    externalParent.id,
    ids.adoptedRoot!,
    400
  );

  const sharedTag = await createTag(organizationId, user.id, "shared", 8000);
  const soloTag = await createTag(organizationId, user.id, "solo", 9000);
  await withDb((db) =>
    db.tagArtifact.createMany({
      data: [
        { tagId: sharedTag.id, artifactId: ids.rootPrd! },
        { tagId: soloTag.id, artifactId: ids.rootPrd! },
        { tagId: sharedTag.id, artifactId: ids.childPlan! },
      ],
    })
  );

  const labels = new Map<string, string>();
  const labelled: Record<string, string> = {
    ...ids,
    organizationId,
    otherOrganizationId,
    projectId,
    externalProjectId,
    userId: user.id,
    otherUserId: otherUser.id,
    externalParent: externalParent.id,
    crossOrgGhost: crossOrgGhost.id,
    sharedTag: sharedTag.id,
    soloTag: soloTag.id,
  };
  for (const [label, id] of Object.entries(labelled)) {
    labels.set(id, `<${label}>`);
  }

  return {
    organizationId,
    otherOrganizationId,
    projectId,
    crossOrgGhostId: crossOrgGhost.id,
    labels,
  };
}

function createTag(
  organizationId: string,
  createdById: string,
  name: string,
  createdAtOffsetMs: number
) {
  return withDb((db) =>
    db.tag.create({
      data: {
        organizationId,
        name,
        color: name === "shared" ? "#111111" : "#222222",
        createdById,
        createdAt: at(createdAtOffsetMs),
      },
    })
  );
}

/**
 * Replace every seeded id with its stable label and every database-assigned or
 * clock-assigned value with a marker, so the whole response can be compared
 * against a literal captured before the rewrite.
 */
function normalize(value: unknown, labels: Map<string, string>): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry, labels));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = VOLATILE_KEYS.has(key)
        ? "<volatile>"
        : normalize(entry, labels);
    }
    return out;
  }
  if (typeof value === "string") {
    return labels.get(value) ?? value;
  }
  return value;
}
