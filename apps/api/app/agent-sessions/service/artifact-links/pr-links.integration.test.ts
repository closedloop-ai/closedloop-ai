import { LinkType } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { persistSessionPrArtifactLinks } from "./pr-links";
import {
  type SessionPullRequestDetailMap,
  sessionPullRequestDetailKey,
} from "./pull-request-details";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

describeIfDb("session PR-link replacement (ISS-5269, real Postgres)", () => {
  it("preserves omitted replay and downgrades present-empty branch-owned rows", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedLink(true);

      await withDb((db) =>
        persistSessionPrArtifactLinks(
          db,
          fixture.organizationId,
          fixture.sessionArtifactId,
          undefined,
          new Map()
        )
      );
      expect(await readMetadata(fixture.linkId)).toMatchObject({
        prRefs: expect.arrayContaining([
          expect.objectContaining({ prNumber: 1 }),
          expect.objectContaining({ prNumber: 2 }),
        ]),
      });

      await withDb((db) =>
        persistSessionPrArtifactLinks(
          db,
          fixture.organizationId,
          fixture.sessionArtifactId,
          [],
          new Map()
        )
      );
      const metadata = await readMetadata(fixture.linkId);
      expect(metadata).toMatchObject({
        branchLinked: true,
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionBranch],
      });
      expect(metadata).not.toHaveProperty("prRefs");
    });
  });

  it("deletes present-empty pure PR rows because CHECK cannot protect DELETE", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedLink(false);

      await withDb((db) =>
        persistSessionPrArtifactLinks(
          db,
          fixture.organizationId,
          fixture.sessionArtifactId,
          [],
          new Map()
        )
      );

      const count = await withDb((db) =>
        db.artifactLink.count({ where: { id: fixture.linkId } })
      );
      expect(count).toBe(0);
    });
  });

  it("writes only declared identities and converges when the set shrinks", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedLink(false, false);
      const refs = [1, 2].map((prNumber) => ({
        repositoryFullName: "acme/web",
        prNumber,
        relationType: SessionPrRelationType.Created,
      }));
      const details = detailMap(fixture.branchArtifactId, [1, 2, 3]);

      await withDb((db) =>
        persistSessionPrArtifactLinks(
          db,
          fixture.organizationId,
          fixture.sessionArtifactId,
          refs,
          details
        )
      );
      const persisted = await readMetadataByPair(fixture);
      if (!persisted) {
        throw new Error("the session/branch link carries no metadata");
      }
      expect(
        (persisted.prRefs as { prNumber: number }[])
          .map((ref) => ref.prNumber)
          .sort()
      ).toEqual([1, 2]);

      await withDb((db) =>
        persistSessionPrArtifactLinks(
          db,
          fixture.organizationId,
          fixture.sessionArtifactId,
          [refs[1]!],
          details
        )
      );
      expect(await readMetadataByPair(fixture)).toMatchObject({
        linkKind: SessionArtifactLinkKind.SessionPr,
        prRefs: [expect.objectContaining({ prNumber: 2 })],
      });
    });
  });

  it("downgrades links on DIFFERENT branches, each keeping its own branch identity", async () => {
    // ISS-8145 (whitlockk + codex review): the downgrade is one `unnest` UPDATE
    // carrying a payload per id. Only a real round trip can show that the
    // statement parses, that the `::jsonb` cast lands, and that each row got ITS
    // OWN metadata rather than a neighbour's — `branchOnlyMetadata` preserves
    // `branchName`, so these two links downgrade to DIFFERENT values and a
    // single shared payload would silently give one branch the other's name.
    await autoRollbackTransaction(async () => {
      const fixture = await seedBranchLinksOnTwoBranches();

      await withDb((db) =>
        persistSessionPrArtifactLinks(
          db,
          fixture.organizationId,
          fixture.sessionArtifactId,
          [],
          new Map()
        )
      );

      for (const link of fixture.links) {
        const metadata = await readMetadata(link.linkId);
        expect(metadata).toMatchObject({
          linkKind: SessionArtifactLinkKind.SessionBranch,
          linkKinds: [SessionArtifactLinkKind.SessionBranch],
          branchLinked: true,
          branchName: link.branchName,
        });
        // The PR evidence is what the downgrade retracts.
        expect(metadata).not.toHaveProperty("prRefs");
      }
    });
  });
});

/** A session holding `branchLinked` PR evidence on two DIFFERENT branches. */
async function seedBranchLinksOnTwoBranches() {
  const organizationId = await createTestOrganization();
  return withDb(async (db) => {
    const session = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: "session-iss8145",
        status: SESSION_STATUS.ACTIVE,
      },
      select: { id: true },
    });
    const links: { linkId: string; branchName: string }[] = [];
    for (const branchName of ["feat/iss8145-one", "feat/iss8145-two"]) {
      const branch = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.BRANCH,
          name: branchName,
          status: BranchStatus.Open,
        },
        select: { id: true },
      });
      const link = await db.artifactLink.create({
        data: {
          organizationId,
          sourceId: session.id,
          targetId: branch.id,
          linkType: LinkType.RelatesTo,
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionBranch,
            linkKinds: [
              SessionArtifactLinkKind.SessionBranch,
              SessionArtifactLinkKind.SessionPrSet,
            ],
            branchLinked: true,
            branchName,
            prRefs: [
              {
                repositoryFullName: "acme/web",
                prNumber: 7,
                relationTypes: [SessionPrRelationType.Created],
              },
            ],
          },
        },
        select: { id: true },
      });
      links.push({ linkId: link.id, branchName });
    }
    return { organizationId, sessionArtifactId: session.id, links };
  });
}

async function seedLink(branchLinked: boolean, createLink = true) {
  const organizationId = await createTestOrganization();
  return withDb(async (db) => {
    const session = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: "session-iss5269",
        status: SESSION_STATUS.ACTIVE,
      },
      select: { id: true },
    });
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: "branch-iss5269",
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    const link = createLink
      ? await db.artifactLink.create({
          data: {
            organizationId,
            sourceId: session.id,
            targetId: branch.id,
            linkType: LinkType.RelatesTo,
            metadata: {
              linkKind: SessionArtifactLinkKind.SessionBranch,
              linkKinds: [
                SessionArtifactLinkKind.SessionBranch,
                SessionArtifactLinkKind.SessionPrSet,
              ],
              branchLinked,
              prRefs: [1, 2].map((prNumber) => ({
                repositoryFullName: "acme/web",
                prNumber,
                relationTypes: [SessionPrRelationType.Created],
              })),
            },
          },
          select: { id: true },
        })
      : null;
    return {
      organizationId,
      sessionArtifactId: session.id,
      branchArtifactId: branch.id,
      linkId: link?.id ?? "",
    };
  });
}

function detailMap(
  branchArtifactId: string,
  numbers: number[]
): SessionPullRequestDetailMap {
  return new Map(
    numbers.map((number) => [
      sessionPullRequestDetailKey("acme/web", number),
      { prDetailId: `pr-${number}`, branchArtifactId },
    ])
  );
}

function readMetadata(linkId: string) {
  return withDb(async (db) => {
    const link = await db.artifactLink.findUniqueOrThrow({
      where: { id: linkId },
      select: { metadata: true },
    });
    return link.metadata as Record<string, unknown>;
  });
}

function readMetadataByPair(fixture: {
  sessionArtifactId: string;
  branchArtifactId: string;
}) {
  return withDb(async (db) => {
    const link = await db.artifactLink.findUniqueOrThrow({
      where: {
        sourceId_targetId_linkType: {
          sourceId: fixture.sessionArtifactId,
          targetId: fixture.branchArtifactId,
          linkType: LinkType.RelatesTo,
        },
      },
      select: { metadata: true },
    });
    return link.metadata as Record<string, unknown>;
  });
}
