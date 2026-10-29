import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import {
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER,
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardGroup,
  ProjectArtifactBoardPageError,
} from "@repo/api/src/types/project-artifact-board-page";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  readBoardRoots,
  seedBoardRoot,
  withBoardFixture,
} from "@/__tests__/support/artifacts/project-artifact-board.test-db";
import { projectArtifactBoardPageService } from "@/app/artifacts/project-artifact-board-page-service";
import { BoardStatusEvidence } from "@/app/artifacts/project-artifact-board-roots";
import { createCommittedTestOrganizationTracker } from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// The board read opens its own RepeatableRead transaction, so its rows must be
// committed rather than held in an ambient rollback transaction.
const organizations = createCommittedTestOrganizationTracker();

/**
 * ISS-12929 (724-F5): the board filters and pages in the database, inside one
 * snapshot, so a filter never needs the browser to drain every page. Each
 * facet keeps the browser predicate's per-kind meaning.
 */
describe.skipIf(!hasDatabase)("Project artifact board server filters", () => {
  afterEach(() => organizations.cleanup());

  it("pages a filtered population without duplicates, with filtered lane counts", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      const kept: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        kept.push(
          await seedBoardRoot(fixture, {
            name: `Apollo ${index}`,
            sortOrder: index * 2,
            status: index % 2 === 0 ? IssueStatus.Todo : IssueStatus.Done,
          })
        );
        await seedBoardRoot(fixture, {
          name: `Gemini ${index}`,
          sortOrder: index * 2 + 1,
          status: IssueStatus.Todo,
        });
      }

      const { pages, rootIds, counts } = await readBoardRoots(
        fixture,
        { search: "apollo" },
        2
      );

      expect(rootIds).toEqual(kept);
      expect(pages).toHaveLength(3);
      expect(counts).toEqual({
        [IssueStatus.Todo]: 3,
        [IssueStatus.Done]: 2,
      });
      expect(pages[0]?.lanes).toEqual([
        expect.objectContaining({ id: IssueStatus.Todo, complete: false }),
        expect.objectContaining({ id: IssueStatus.Done, complete: false }),
      ]);
      expect(pages.at(-1)?.lanes.every((lane) => lane.complete)).toBe(true);
    });
  });

  it("refuses a cursor minted under another filter", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      for (let index = 0; index < 3; index += 1) {
        await seedBoardRoot(fixture, {
          name: `Apollo ${index}`,
          sortOrder: index,
          status: IssueStatus.Todo,
        });
      }
      const first = await projectArtifactBoardPageService.read(
        fixture.projectId,
        fixture.organizationId,
        {
          groupBy: ProjectArtifactBoardGroup.Status,
          pageSize: 1,
          filters: { search: "apollo" },
        },
        {
          statusEvidence: BoardStatusEvidence.Stored,
          statusOrdering: ArtifactSectionOrdering.Vocabulary,
          userId: fixture.userId,
        }
      );
      if (!(first.ok && first.value.nextCursor)) {
        throw new Error("expected a second page");
      }
      const crossed = await projectArtifactBoardPageService.read(
        fixture.projectId,
        fixture.organizationId,
        {
          cursor: first.value.nextCursor,
          groupBy: ProjectArtifactBoardGroup.Status,
          pageSize: 1,
          filters: { search: "apollo 1" },
        },
        {
          statusEvidence: BoardStatusEvidence.Stored,
          statusOrdering: ArtifactSectionOrdering.Vocabulary,
          userId: fixture.userId,
        }
      );
      expect(crossed).toMatchObject({
        ok: false,
        error: { code: ProjectArtifactBoardPageError.StaleRevision },
      });
    });
  });

  it("keeps a title-only edit outside the revision and a status change inside it", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      const id = await seedBoardRoot(fixture, {
        name: "Apollo",
        sortOrder: 0,
        status: IssueStatus.Todo,
      });
      await seedBoardRoot(fixture, {
        name: "Gemini",
        sortOrder: 1,
        status: IssueStatus.Todo,
      });
      const before = (await readBoardRoots(fixture)).pages[0]
        ?.populationRevision;
      await withDb((db) =>
        db.artifact.update({ where: { id }, data: { name: "Apollo 2" } })
      );
      const afterTitle = (await readBoardRoots(fixture)).pages[0]
        ?.populationRevision;
      await withDb((db) =>
        db.artifact.update({
          where: { id },
          data: { status: IssueStatus.Done },
        })
      );
      const afterStatus = (await readBoardRoots(fixture)).pages[0]
        ?.populationRevision;
      expect(afterTitle).toBe(before);
      expect(afterStatus).not.toBe(before);
    });
  });

  it("narrows documents only by status, priority and tag, as the browser predicate does", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      const todoHigh = await seedBoardRoot(fixture, {
        name: "Todo high",
        sortOrder: 0,
        status: IssueStatus.Todo,
        priority: Priority.High,
      });
      const doneUnset = await seedBoardRoot(fixture, {
        name: "Done unset",
        sortOrder: 1,
        status: IssueStatus.Done,
      });
      const offVocabulary = await seedBoardRoot(fixture, {
        name: "Off vocabulary",
        sortOrder: 2,
        status: DocumentStatus.Draft,
      });
      const branch = await seedBoardRoot(fixture, {
        name: "Branch",
        sortOrder: 3,
        status: "open",
        type: ArtifactType.Branch,
      });

      const prdStoredTodo = await seedBoardRoot(fixture, {
        name: "PRD stored as Todo",
        sortOrder: 4,
        status: IssueStatus.Todo,
        subtype: ArtifactSubtype.Prd,
      });
      const projected = (filters: ProjectArtifactBoardFilters) =>
        readBoardRoots(fixture, filters, 50, BoardStatusEvidence.Projected);

      // Flag off: a status matches inside its own vocabulary, and an
      // off-vocabulary issue reads as Backlog, as the table folds it.
      expect(
        (await readBoardRoots(fixture, { statuses: [IssueStatus.Todo] }))
          .rootIds
      ).toEqual([todoHigh, branch]);
      expect(
        (await readBoardRoots(fixture, { statuses: [IssueStatus.Backlog] }))
          .rootIds
      ).toEqual([offVocabulary, branch]);
      expect(
        (await readBoardRoots(fixture, { statuses: [DocumentStatus.Draft] }))
          .rootIds
      ).toEqual([branch, prdStoredTodo]);
      // Flag on: off-vocabulary statuses are the Unknown facet instead.
      expect(
        (await projected({ statuses: [IssueStatus.Backlog] })).rootIds
      ).toEqual([branch]);
      expect(
        (await projected({ statuses: [DISPLAYED_ARTIFACT_STATUS.Unknown] }))
          .rootIds
      ).toEqual([offVocabulary, branch, prdStoredTodo]);
      expect(
        (await projected({ statuses: [IssueStatus.Todo] })).rootIds
      ).toEqual([todoHigh, branch]);
      expect(
        (await readBoardRoots(fixture, { priorities: [PRIORITY_UNSET_VALUE] }))
          .rootIds
      ).toEqual([doneUnset, offVocabulary, branch, prdStoredTodo]);
      expect(
        (await readBoardRoots(fixture, { priorities: [Priority.High] })).rootIds
      ).toEqual([todoHigh, branch]);

      const tag = await withDb((db) =>
        db.tag.create({
          data: {
            organizationId: fixture.organizationId,
            name: "Launch",
            color: "blue",
            createdById: fixture.userId,
          },
          select: { id: true },
        })
      );
      await withDb((db) =>
        db.tagArtifact.create({
          data: { tagId: tag.id, artifactId: doneUnset },
        })
      );
      expect(
        (await readBoardRoots(fixture, { tagIds: [tag.id] })).rootIds
      ).toEqual([doneUnset, branch]);
    });
  });

  it("hides completed roots per kind and keeps a deployment", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      const openIssue = await seedBoardRoot(fixture, {
        name: "Open issue",
        sortOrder: 0,
        status: IssueStatus.InProgress,
      });
      await seedBoardRoot(fixture, {
        name: "Done issue",
        sortOrder: 1,
        status: IssueStatus.Done,
      });
      const approvedPrd = await seedBoardRoot(fixture, {
        name: "Approved PRD",
        sortOrder: 2,
        status: DocumentStatus.Approved,
        subtype: ArtifactSubtype.Prd,
      });
      await seedBoardRoot(fixture, {
        name: "Executed PRD",
        sortOrder: 3,
        status: DocumentStatus.Executed,
        subtype: ArtifactSubtype.Prd,
      });
      await seedBoardRoot(fixture, {
        name: "Merged branch",
        sortOrder: 4,
        status: "merged",
        type: ArtifactType.Branch,
      });
      const openBranch = await seedBoardRoot(fixture, {
        name: "Open branch",
        sortOrder: 5,
        status: "open",
        type: ArtifactType.Branch,
      });
      await seedBoardRoot(fixture, {
        name: "Finished session",
        sortOrder: 6,
        status: SESSION_STATUS.INACTIVE,
        type: ArtifactType.Session,
      });
      const liveSession = await seedBoardRoot(fixture, {
        name: "Live session",
        sortOrder: 7,
        status: SESSION_STATUS.ACTIVE,
        type: ArtifactType.Session,
      });
      const deployment = await seedBoardRoot(fixture, {
        name: "Deployment",
        sortOrder: 8,
        status: "READY",
        type: ArtifactType.Deployment,
      });

      expect(
        (await readBoardRoots(fixture, { hideCompletedItems: true })).rootIds
      ).toEqual([openIssue, approvedPrd, openBranch, liveSession, deployment]);
    });
  });

  it("narrows every kind by assignee, date window, favorites and search", async () => {
    await withBoardFixture(organizations, async (fixture) => {
      const mine = await seedBoardRoot(fixture, {
        name: "Mine",
        sortOrder: 0,
        status: IssueStatus.Todo,
        assigneeId: fixture.userId,
        slug: "ISS-1",
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
      });
      const theirs = await seedBoardRoot(fixture, {
        name: "Theirs",
        sortOrder: 1,
        status: IssueStatus.Todo,
        assigneeId: fixture.otherUserId,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      });
      const unassignedSession = await seedBoardRoot(fixture, {
        name: "Session ISS-1 notes",
        sortOrder: 2,
        status: SESSION_STATUS.ACTIVE,
        type: ArtifactType.Session,
        slug: "SES-9",
        createdAt: new Date("2026-10-02T00:00:00.000Z"),
      });

      expect(
        (
          await readBoardRoots(fixture, {
            assigneeIds: [
              fixture.userId,
              PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER,
            ],
          })
        ).rootIds
      ).toEqual([mine, unassignedSession]);
      expect(
        (
          await readBoardRoots(fixture, {
            dateWindow: {
              field: ArtifactDateField.CreatedAt,
              from: new Date("2026-09-15T00:00:00.000Z"),
              to: new Date("2026-10-15T00:00:00.000Z"),
            },
          })
        ).rootIds
      ).toEqual([mine, unassignedSession]);

      await withDb((db) =>
        db.favoriteArtifact.createMany({
          data: [
            { userId: fixture.userId, artifactId: theirs },
            { userId: fixture.otherUserId, artifactId: mine },
          ],
        })
      );
      expect(
        (await readBoardRoots(fixture, { favoritesOnly: true })).rootIds
      ).toEqual([theirs]);

      // A document matches its slug; a session matches only its title.
      expect(
        (await readBoardRoots(fixture, { search: "iss-1" })).rootIds
      ).toEqual([mine, unassignedSession]);
      expect(
        (await readBoardRoots(fixture, { search: "SES-9" })).rootIds
      ).toEqual([]);
    });
  });
});
