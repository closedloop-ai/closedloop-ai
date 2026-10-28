import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { DirectCollaboratorSource } from "@repo/api/src/types/artifact-collaborators";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
  branchPersonKey,
} from "@repo/api/src/types/branch-identity";
import { ThreadSource } from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  branchCollaboratorIdentityCtesSql,
  branchCollaboratorIdentityJoinSql,
} from "@/app/branches/branch-list-sql/branch-list-identity-sql";
import { directCommentCountService } from "./direct-comment-count-service";
import { artifactCollaboratorsService } from "./service";

const tracker = createCommittedTestOrganizationTracker();
describe.skipIf(!keys().DATABASE_URL)("direct artifact participation", () => {
  afterEach(() => tracker.cleanup());
  it.each([
    ArtifactType.Document,
    ArtifactType.Deployment,
    ArtifactType.Session,
    ArtifactType.Branch,
  ])(
    "%s combines direct edits and native/inline comments without assignee or linked comments",
    async (artifactType) => {
      const organizationId = await tracker.create();
      const foreignOrg = await tracker.create();
      const [creator, editor, commenter, inline, assignee] = await Promise.all(
        Array.from({ length: 5 }, () => createTestUser(organizationId))
      );
      const foreignUser = await createTestUser(foreignOrg);
      const artifact = await seedArtifact(
        organizationId,
        artifactType,
        creator.id,
        assignee.id
      );
      const foreign = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: foreignOrg,
            type: artifactType,
            name: "Foreign",
            status: "test",
          },
          select: { id: true },
        })
      );
      const linked = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId,
            type: ArtifactType.Document,
            name: "Other",
            status: "test",
          },
          select: { id: true },
        })
      );
      await withDb((db) =>
        db.artifactActivityEvent.createMany({
          data: [
            {
              organizationId,
              artifactId: artifact.id,
              action: ArtifactActivityAction.Creation,
              actorType: ArtifactActivityActorType.User,
              actorId: creator.id,
            },
            {
              organizationId,
              artifactId: artifact.id,
              action: ArtifactActivityAction.FieldChange,
              actorType: ArtifactActivityActorType.Agent,
              actorId: editor.id,
            },
            {
              organizationId,
              artifactId: artifact.id,
              action: ArtifactActivityAction.FieldChange,
              actorType: ArtifactActivityActorType.User,
              actorId: foreignUser.id,
            },
          ],
        })
      );
      const nativeThreadId = await addComment(
        organizationId,
        artifact.id,
        commenter.id,
        ThreadSource.Native
      );
      await addReply(nativeThreadId, inline.id);
      await addComment(
        organizationId,
        artifact.id,
        inline.id,
        ThreadSource.Liveblocks
      );
      await addComment(
        organizationId,
        artifact.id,
        commenter.id,
        ThreadSource.Native
      );
      await addComment(
        organizationId,
        artifact.id,
        assignee.id,
        ThreadSource.Native,
        new Date()
      );
      await addComment(
        organizationId,
        linked.id,
        assignee.id,
        ThreadSource.Native
      );
      await addComment(
        foreignOrg,
        artifact.id,
        foreignUser.id,
        ThreadSource.Native
      );
      const response = await artifactCollaboratorsService.readBoundedBatch(
        organizationId,
        { artifactType, artifactIds: [artifact.id, foreign.id] }
      );
      expect(response.ok).toBe(true);
      if (!response.ok) {
        throw new Error("expected admitted batch");
      }
      expect(response.value.results).toHaveLength(1);
      const entry = response.value.results[0];
      expect(entry.commentCount).toBe(3);
      const sharedCounts = await withDb((db) =>
        directCommentCountService.read(db, organizationId, [
          artifact.id,
          foreign.id,
        ])
      );
      expect(sharedCounts).toEqual(new Map([[artifact.id, 3]]));
      if (artifactType === ArtifactType.Branch) {
        const editorKey = branchPersonKey({
          provider: BranchPersonProvider.ClosedLoop,
          id: editor.id,
          userId: editor.id,
        });
        const matching = await withDb((db) =>
          db.$queryRaw<{ id: string }[]>(Prisma.sql`
          WITH ${branchCollaboratorIdentityCtesSql(Prisma.sql`SELECT ${artifact.id}::uuid AS id`)}
          SELECT a.id FROM artifacts a JOIN branch_detail b ON b.artifact_id = a.id
          ${branchCollaboratorIdentityJoinSql()}
          WHERE a.organization_id = ${organizationId}::uuid AND a.id = ${artifact.id}::uuid
            AND branch_collaborator_identity.collaborator_keys @> ARRAY[${editorKey}]::text[]
        `)
        );
        expect(matching).toEqual([{ id: artifact.id }]);
      }
      expect(
        entry.collaborators.people.map((person) => person.userId).sort()
      ).toEqual([creator.id, editor.id, commenter.id, inline.id].sort());
      expect(
        entry.collaborators.sources[DirectCollaboratorSource.Interactions]
      ).toBe(BranchIdentityAvailability.Incomplete);
    }
  );

  it("counts threads per artifact and survives a non-uuid actor id", async () => {
    const organizationId = await tracker.create();
    const [creator, assignee, editor, commenter, other] = await Promise.all(
      Array.from({ length: 5 }, () => createTestUser(organizationId))
    );
    const busy = await seedArtifact(
      organizationId,
      ArtifactType.Deployment,
      creator.id,
      assignee.id
    );
    const quiet = await seedArtifact(
      organizationId,
      ArtifactType.Deployment,
      creator.id,
      assignee.id
    );
    await withDb((db) =>
      db.artifactActivityEvent.createMany({
        data: [
          {
            organizationId,
            artifactId: busy.id,
            action: ArtifactActivityAction.FieldChange,
            actorType: ArtifactActivityActorType.Agent,
            actorId: "claude-code",
          },
          {
            organizationId,
            artifactId: busy.id,
            action: ArtifactActivityAction.FieldChange,
            actorType: ArtifactActivityActorType.User,
            actorId: editor.id,
          },
        ],
      })
    );
    const busyThread = await addComment(
      organizationId,
      busy.id,
      commenter.id,
      ThreadSource.Native
    );
    await addReply(busyThread, other.id);
    await addReply(busyThread, editor.id);
    await addComment(organizationId, busy.id, other.id, ThreadSource.Native);
    await addComment(organizationId, quiet.id, other.id, ThreadSource.Native);

    const response = await artifactCollaboratorsService.readBoundedBatch(
      organizationId,
      {
        artifactType: ArtifactType.Deployment,
        artifactIds: [busy.id, quiet.id],
      }
    );
    if (!response.ok) {
      throw new Error("expected admitted batch");
    }
    const byId = new Map(
      response.value.results.map((entry) => [entry.artifactId, entry])
    );
    expect(byId.get(busy.id)?.commentCount).toBe(2);
    expect(byId.get(quiet.id)?.commentCount).toBe(1);
    expect(
      byId
        .get(busy.id)
        ?.collaborators.people.map((person) => person.userId)
        .sort()
    ).toEqual(expect.arrayContaining([creator.id, editor.id, commenter.id]));
    expect(
      byId.get(busy.id)?.collaborators.sources[
        DirectCollaboratorSource.Interactions
      ]
    ).toBe(BranchIdentityAvailability.Incomplete);
  });

  it.each([
    [ArtifactType.Document, false, BranchIdentityAvailability.Incomplete],
    [ArtifactType.Document, true, BranchIdentityAvailability.Complete],
    [ArtifactType.Session, false, BranchIdentityAvailability.Incomplete],
    [ArtifactType.Session, true, BranchIdentityAvailability.Complete],
    [ArtifactType.Branch, false, BranchIdentityAvailability.Complete],
    [ArtifactType.Deployment, false, BranchIdentityAvailability.Complete],
  ] as const)(
    "%s interaction coverage with creation-time proof %s is %s",
    async (artifactType, withProof, expected) => {
      const organizationId = await tracker.create();
      const [creator, assignee] = await Promise.all([
        createTestUser(organizationId),
        createTestUser(organizationId),
      ]);
      const artifact = await seedArtifact(
        organizationId,
        artifactType,
        creator.id,
        assignee.id,
        withProof
      );
      const response = await artifactCollaboratorsService.readBoundedBatch(
        organizationId,
        { artifactType, artifactIds: [artifact.id] }
      );
      if (!response.ok) {
        throw new Error("expected admitted batch");
      }
      expect(
        response.value.results[0]?.collaborators.sources[
          DirectCollaboratorSource.Interactions
        ]
      ).toBe(expected);
    }
  );
});

async function addComment(
  organizationId: string,
  artifactId: string,
  authorId: string,
  source: ThreadSource,
  deletedAt?: Date
): Promise<string> {
  const thread = await withDb((db) =>
    db.commentThread.create({
      data: {
        organizationId,
        artifactId,
        source,
        comments: {
          create: {
            authorId,
            body: {},
            bodyFormat: CommentBodyFormat.RichV1,
            ...(deletedAt ? { deletedAt } : {}),
          },
        },
      },
      select: { id: true },
    })
  );
  return thread.id;
}

async function addReply(threadId: string, authorId: string): Promise<void> {
  await withDb((db) =>
    db.comment.create({
      data: {
        threadId,
        authorId,
        body: {},
        bodyFormat: CommentBodyFormat.RichV1,
      },
      select: { id: true },
    })
  );
}

async function seedArtifact(
  organizationId: string,
  artifactType: ArtifactType,
  creatorId: string,
  assigneeId: string,
  withCoverageProof = false
): Promise<{ id: string }> {
  if (artifactType === ArtifactType.Session) {
    const id = await createTestSessionDetail({
      organizationId,
      userId: creatorId,
      label: "participation-session",
      ...(withCoverageProof
        ? { metadataActivityCoverageStartedAt: new Date() }
        : {}),
    });
    await withDb((db) =>
      db.artifact.updateMany({
        where: { organizationId, id },
        data: { createdById: creatorId, assigneeId },
      })
    );
    return { id };
  }
  const created = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: artifactType,
        name: "Participation",
        status: "test",
        createdById: creatorId,
        assigneeId,
        ...(artifactType === ArtifactType.Branch
          ? {
              branch: {
                create: {
                  organizationId,
                  branchName: "participation",
                  repositoryFullName: "acme/app",
                },
              },
            }
          : {}),
      },
      select: { id: true },
    })
  );
  if (withCoverageProof) {
    await withDb((db) =>
      db.artifactActivityEvent.create({
        data: {
          organizationId,
          artifactId: created.id,
          action: ArtifactActivityAction.Creation,
          actorType: ArtifactActivityActorType.User,
          actorId: creatorId,
        },
        select: { id: true },
      })
    );
  }
  return created;
}
