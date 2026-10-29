import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactBoardKind,
  ProjectArtifactBoardStatusMatch,
} from "@repo/api/src/types/project-artifact-board-page";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { createRelatedSessionLink } from "@/__tests__/support/agent-sessions/related-session.test-fixtures";
import {
  type BoardFixture,
  readBoardRoots,
  seedBoardRoot,
  withBoardFixture,
} from "@/__tests__/support/artifacts/project-artifact-board.test-db";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// The board read opens its own RepeatableRead transaction, so its rows must be
// committed rather than held in an ambient rollback transaction.
const organizations = createCommittedTestOrganizationTracker();

/** One root of each kind, the list's kinds spelled out. */
async function seedKinds(fixture: BoardFixture) {
  return {
    issue: await seedBoardRoot(fixture, {
      assigneeId: fixture.userId,
      name: "Issue root",
      priority: Priority.High,
      slug: "ISS-1",
      sortOrder: 0,
      status: IssueStatus.Todo,
    }),
    issueOffVocabulary: await seedBoardRoot(fixture, {
      name: "Off-vocabulary issue",
      sortOrder: 1,
      status: "WEIRD",
      subtype: ArtifactSubtype.Feature,
    }),
    prd: await seedBoardRoot(fixture, {
      name: "PRD root",
      sortOrder: 2,
      status: DocumentStatus.Draft,
      subtype: ArtifactSubtype.Prd,
    }),
    branch: await seedBoardRoot(fixture, {
      name: "Branch root",
      priority: Priority.High,
      sortOrder: 3,
      status: "open",
      type: ArtifactType.Branch,
    }),
    session: await seedBoardRoot(fixture, {
      assigneeId: fixture.otherUserId,
      name: "Session root",
      slug: "SES-7",
      sortOrder: 4,
      status: SESSION_STATUS.ACTIVE,
      type: ArtifactType.Session,
    }),
    deployment: await seedBoardRoot(fixture, {
      name: "Deployment root",
      sortOrder: 5,
      status: "READY",
      type: ArtifactType.Deployment,
    }),
  };
}

/**
 * ISS-12929: the portable project list's toolbar facets, applied by the board
 * route to every kind, as the list's own predicate applies them.
 */
describe.skipIf(!hasDatabase)("Project board list toolbar filters", () => {
  afterEach(() => organizations.cleanup());

  it("narrows by the list's kinds", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      const roots = await seedKinds(fixture);
      expect(
        (
          await readBoardRoots(fixture, {
            kinds: [ProjectArtifactBoardKind.Issue],
          })
        ).rootIds
      ).toEqual([roots.issue, roots.issueOffVocabulary]);
      expect(
        (
          await readBoardRoots(fixture, {
            kinds: [
              ProjectArtifactBoardKind.Document,
              ProjectArtifactBoardKind.Deployment,
            ],
          })
        ).rootIds
      ).toEqual([roots.prd, roots.deployment]);
    });
  });

  it("keeps each kind's resolved statuses, an empty facet keeping nothing", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      const roots = await seedKinds(fixture);
      expect(
        (
          await readBoardRoots(fixture, {
            kindStatuses: [
              {
                kind: ProjectArtifactBoardKind.Issue,
                match: ProjectArtifactBoardStatusMatch.Only,
                statuses: [IssueStatus.Todo],
              },
              {
                kind: ProjectArtifactBoardKind.Branch,
                match: ProjectArtifactBoardStatusMatch.Except,
                statuses: ["merged"],
              },
            ],
          })
        ).rootIds
      ).toEqual([roots.issue, roots.branch]);
      expect(
        (await readBoardRoots(fixture, { kindStatuses: [] })).rootIds
      ).toEqual([]);
    });
  });

  it("narrows every kind by priority and tag, unset and untagged failing", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      const roots = await seedKinds(fixture);
      expect(
        (
          await readBoardRoots(fixture, {
            anyKindPriorities: [Priority.High],
          })
        ).rootIds
      ).toEqual([roots.issue, roots.branch]);
      const tag = await withDb((db) =>
        db.tag.create({
          data: {
            color: "blue",
            createdById: fixture.userId,
            name: "Launch",
            organizationId: fixture.organizationId,
          },
          select: { id: true },
        })
      );
      await withDb((db) =>
        db.tagArtifact.createMany({
          data: [
            { artifactId: roots.session, tagId: tag.id },
            { artifactId: roots.prd, tagId: tag.id },
          ],
        })
      );
      expect(
        (await readBoardRoots(fixture, { anyKindTagIds: [tag.id] })).rootIds
      ).toEqual([roots.prd, roots.session]);
    });
  });

  it("narrows to the viewer's artifacts and matches slug or title for any kind", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      const roots = await seedKinds(fixture);
      expect(
        (await readBoardRoots(fixture, { mineOnly: true })).rootIds
      ).toEqual([roots.issue]);
      expect(
        (await readBoardRoots(fixture, { slugOrTitle: "ses-7 session" }))
          .rootIds
      ).toEqual([roots.session]);
      expect(
        (await readBoardRoots(fixture, { slugOrTitle: "root" })).rootIds
      ).toEqual([
        roots.issue,
        roots.prd,
        roots.branch,
        roots.session,
        roots.deployment,
      ]);
    });
  });

  it("narrows by parent and by related-session evidence", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      const roots = await seedKinds(fixture);
      const session = await createTestSessionDetail({
        label: "related",
        organizationId: fixture.organizationId,
        userId: fixture.userId,
      });
      await createRelatedSessionLink({
        contributedAt: "2026-10-01T00:00:00.000Z",
        organizationId: fixture.organizationId,
        sourceId: session,
        targetId: roots.prd,
      });
      // A link the Related Sessions read does not count stays out too.
      await createRelatedSessionLink({
        contributedAt: "2026-10-01T00:00:00.000Z",
        metadata: { relation: "unrecognized" },
        organizationId: fixture.organizationId,
        sourceId: session,
        targetId: roots.issue,
      });
      expect(
        (await readBoardRoots(fixture, { relatedSessionIds: [session] }))
          .rootIds
      ).toEqual([roots.prd]);
      // A board root has no PRODUCES parent, so a parent selection keeps none.
      expect(
        (await readBoardRoots(fixture, { parentIds: [roots.issue] })).rootIds
      ).toEqual([]);
    });
  });

  it("matches custom fields by the list's labels and keeps a missing value in range", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      try {
        {
          const roots = await seedKinds(fixture);
          const field = (name: string, fieldType: CustomFieldType) =>
            withDb((db) =>
              db.customField.create({
                data: {
                  fieldType,
                  name,
                  organizationId: fixture.organizationId,
                },
                select: { id: true },
              })
            );
          const value = (
            customFieldId: string,
            entityId: string,
            data: Record<string, unknown>
          ) =>
            withDb((db) =>
              db.customFieldValue.create({
                data: {
                  customFieldId,
                  entityId,
                  entityType: CustomFieldEntityType.Document,
                  multiEnumValueIds: [],
                  organizationId: fixture.organizationId,
                  peopleValueIds: [],
                  ...data,
                },
                select: { id: true },
              })
            );
          const stage = await field("Stage", CustomFieldType.Enum);
          const beta = await withDb((db) =>
            db.customFieldEnumOption.create({
              data: { customFieldId: stage.id, name: "Beta" },
              select: { id: true },
            })
          );
          await value(stage.id, roots.prd, { enumValueId: beta.id });
          const owner = await field("Reviewer", CustomFieldType.People);
          await value(owner.id, roots.issue, {
            peopleValueIds: [fixture.otherUserId],
          });
          const other = await withDb((db) =>
            db.user.findUniqueOrThrow({
              where: { id: fixture.otherUserId },
              select: { email: true, firstName: true, lastName: true },
            })
          );
          const reference = await field("Blocks", CustomFieldType.Reference);
          const referenceValue = await value(reference.id, roots.issue, {});
          await withDb((db) =>
            db.customFieldValueReference.create({
              data: {
                customFieldValueId: referenceValue.id,
                targetArtifactId: roots.prd,
              },
            })
          );
          const estimate = await field("Estimate", CustomFieldType.Number);
          await value(estimate.id, roots.issue, {
            displayValue: "8",
            numberValue: 8,
          });
          await value(estimate.id, roots.prd, {
            displayValue: "2",
            numberValue: 2,
          });

          const labelled = (fieldId: string, labels: string[]) =>
            readBoardRoots(fixture, {
              customFieldValues: [{ fieldId, labels }],
            });
          expect((await labelled(stage.id, ["Beta"])).rootIds).toEqual([
            roots.prd,
          ]);
          const otherName =
            `${other.firstName ?? ""} ${other.lastName ?? ""}`.trim() ||
            other.email;
          expect((await labelled(owner.id, [otherName])).rootIds).toEqual([
            roots.issue,
          ]);
          expect((await labelled(reference.id, ["PRD root"])).rootIds).toEqual([
            roots.issue,
          ]);
          expect((await labelled(estimate.id, ["2"])).rootIds).toEqual([
            roots.prd,
          ]);
          // In range: the 8 is dropped, the 2 kept, and every artifact without
          // an estimate stays, as the list's NaN comparison keeps it.
          expect(
            (
              await readBoardRoots(fixture, {
                customFieldRanges: [{ fieldId: estimate.id, max: 5 }],
              })
            ).rootIds
          ).toEqual([
            roots.issueOffVocabulary,
            roots.prd,
            roots.branch,
            roots.session,
            roots.deployment,
          ]);
        }
      } finally {
        // The committed-organization cleanup does not reach custom fields.
        await withDb((db) =>
          db.customField.deleteMany({
            where: { organizationId: fixture.organizationId },
          })
        );
      }
    });
  });
});
