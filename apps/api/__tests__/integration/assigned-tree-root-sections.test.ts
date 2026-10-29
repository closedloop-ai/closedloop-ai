/**
 * ISS-10472: a GROUPED board's page of root groups, against real Postgres.
 *
 * Every property here belongs to the QUERY or to its handoff to the shared
 * packer, and none is decidable against a fake: which section a root lands in
 * after the section value is computed in SQL, the order the database applies to
 * sections, a nullable section value surviving the round trip through the
 * packer's string key, and `count(*)` arriving as something the packer accepts.
 */

import {
  ArtifactGroupByMode,
  ArtifactSectionOrdering,
} from "@repo/api/src/types/artifact-group-by-mode";
import {
  type AssignedTreeSort,
  AssignedTreeSortDirection,
  AssignedTreeSortKey,
} from "@repo/api/src/types/assigned-tree-sort";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ArtifactSubtype,
  ArtifactType,
  Priority,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { assignedArtifactTreeService } from "@/app/artifacts/assigned-artifact-tree-service";
import { resolveRootSectionPage } from "@/app/artifacts/assigned-tree-root-sections";
import { generateSlug } from "@/app/documents/document-utils";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;
const organizations = createCommittedTestOrganizationTracker();

async function seedRoot(input: {
  organizationId: string;
  assigneeId: string;
  projectId: string;
  name: string;
  status?: string;
  priority?: Priority | null;
  sortOrder: number;
}): Promise<string> {
  const row = await withDb((db) =>
    db.artifact.create({
      data: {
        assigneeId: input.assigneeId,
        createdById: input.assigneeId,
        name: input.name,
        organizationId: input.organizationId,
        priority: input.priority ?? null,
        projectId: input.projectId,
        slug: generateSlug(),
        sortOrder: input.sortOrder,
        status: input.status ?? IssueStatus.Todo,
        subtype: ArtifactSubtype.ISSUE,
        type: ArtifactType.DOCUMENT,
      },
      select: { id: true },
    })
  );
  return row.id;
}

type Scope = {
  organizationId: string;
  assigneeId: string;
  viewerUserId: string;
  projectId: string;
};

async function scope(): Promise<Scope> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id, {
    name: "Root Sections",
  });
  return {
    assigneeId: user.id,
    organizationId,
    projectId,
    viewerUserId: user.id,
  };
}

function pageOf(s: Scope, pageIndex: number, pageSize: number) {
  return resolveRootSectionPage({
    assigneeId: s.assigneeId,
    groupBy: ArtifactGroupByMode.Status,
    ordering: ArtifactSectionOrdering.Vocabulary,
    organizationId: s.organizationId,
    pageIndex,
    pageSize,
    viewerUserId: s.viewerUserId,
  });
}

describe.skipIf(!hasDatabase)(
  "ISS-10472 grouped root sections (Postgres)",
  () => {
    it("reports a page INDEX on the response and no row offset", async () => {
      // `offset` means a row offset and only that. It used to carry the page
      // index on this read, distinguishable only by whether `sections` happened
      // to be present, so anything reading it generically got the wrong number
      // (marisolashgrove, PR #9026).
      const s = await scope();
      for (let index = 0; index < 4; index++) {
        await seedRoot({
          assigneeId: s.assigneeId,
          name: `indexed-${index}`,
          organizationId: s.organizationId,
          projectId: s.projectId,
          sortOrder: index,
          status: index < 2 ? IssueStatus.Todo : IssueStatus.Done,
        });
      }

      const response =
        await assignedArtifactTreeService.getAssignedArtifactTreeSectionPage(
          s.assigneeId,
          s.organizationId,
          s.viewerUserId,
          {
            groupBy: ArtifactGroupByMode.Status,
            ordering: ArtifactSectionOrdering.Vocabulary,
            pageIndex: 1,
            pageSize: 2,
          }
        );

      expect(response.page?.pageIndex).toBe(1);
      expect(response.page?.offset).toBeUndefined();
      // And the fields a section-paged read owes a footer are still there, so
      // this case cannot pass on a response that simply dropped them.
      expect(response.page?.rowsBefore).toBe(2);
      expect(response.page?.totalPages).toBe(2);
    });

    it("states each section's WHOLE size, not the slice this page took", async () => {
      const s = await scope();
      // One section larger than the page, so its first page holds a strict subset.
      for (let index = 0; index < 7; index++) {
        await seedRoot({
          ...s,
          name: `todo ${index}`,
          sortOrder: index,
          status: IssueStatus.Todo,
        });
      }

      const page = await pageOf(s, 0, 3);

      expect(page.sections).toHaveLength(1);
      expect(page.sections[0].ids).toHaveLength(3);
      // The size is the population a header claims, so it must be 7 and not 3.
      expect(page.sections[0].total).toBe(7);
      expect(page.total).toBe(7);
      expect(page.totalPages).toBe(3);
    });

    it("marks a spill page continued and never repeats or drops a root", async () => {
      const s = await scope();
      const seeded: string[] = [];
      for (let index = 0; index < 7; index++) {
        seeded.push(
          await seedRoot({
            ...s,
            name: `todo ${index}`,
            sortOrder: index,
            status: IssueStatus.Todo,
          })
        );
      }

      const pages = [
        await pageOf(s, 0, 3),
        await pageOf(s, 1, 3),
        await pageOf(s, 2, 3),
      ];

      // Only a section larger than a page spills, and every spill says so.
      expect(pages.map((page) => page.sections[0].continued)).toEqual([
        false,
        true,
        true,
      ]);
      // The footer's range anchors on this, and a variable-height page makes
      // `pageIndex * pageSize` a window nothing returned. Here the pages happen
      // to be even, so the discriminating case is the LAST page: 6 rows before
      // it, holding 1.
      expect(pages.map((page) => page.rowsBefore)).toEqual([0, 3, 6]);
      expect(pages.map((page) => page.ids.length)).toEqual([3, 3, 1]);
      // The partition proof: each root on exactly one page, none invented.
      const walked = pages.flatMap((page) => page.ids);
      expect(walked).toHaveLength(seeded.length);
      expect(new Set(walked)).toEqual(new Set(seeded));
    });

    it("keeps a section that exactly fills the remaining space on the page", async () => {
      const s = await scope();
      // Two sections of 2 against a page of 4: 2 + 2 is not MORE than 4, so both
      // belong on page one. A `>=` boundary in the packer splits them.
      for (let index = 0; index < 2; index++) {
        await seedRoot({
          ...s,
          name: `draft ${index}`,
          sortOrder: index,
          status: IssueStatus.Triage,
        });
        await seedRoot({
          ...s,
          name: `todo ${index}`,
          sortOrder: 10 + index,
          status: IssueStatus.Todo,
        });
      }

      const page = await pageOf(s, 0, 4);

      expect(page.totalPages).toBe(1);
      expect(page.sections).toHaveLength(2);
      expect(page.ids).toHaveLength(4);
    });

    it("orders sections by the surface's status order, not by insertion", async () => {
      const s = await scope();
      // Seeded newest-first so input order is the REVERSE of display order:
      // TRIAGE precedes TODO in STATUS_DISPLAY_ORDER.
      const todo = await seedRoot({
        ...s,
        name: "todo",
        sortOrder: 0,
        status: IssueStatus.Todo,
      });
      const triage = await seedRoot({
        ...s,
        name: "triage",
        sortOrder: 1,
        status: IssueStatus.Triage,
      });

      const page = await pageOf(s, 0, 10);

      expect(page.ids).toEqual([triage, todo]);
    });

    it("sections an OFF-VOCABULARY status by the COERCED value under `vocabulary`", async () => {
      const s = await scope();
      // `artifacts.status` is freeform, so a value in neither lifecycle is a
      // routine input. `parseStatusForSubtype` folds it to BACKLOG for an issue,
      // and the `vocabulary` ordering sections on that folded value — so this row
      // joins the real BACKLOG section rather than opening one of its own. This
      // is the ONLY case that distinguishes `vocabulary` from `retained`: for an
      // in-vocabulary status the coerced and raw values are the same string.
      await seedRoot({
        ...s,
        name: "off vocabulary",
        sortOrder: 0,
        status: "NOT_A_REAL_STATUS",
      });
      await seedRoot({
        ...s,
        name: "backlog",
        sortOrder: 1,
        status: IssueStatus.Backlog,
      });

      const vocabulary = await pageOf(s, 0, 10);
      expect(vocabulary.sections).toHaveLength(1);
      expect(vocabulary.sections[0].total).toBe(2);

      const retained = await resolveRootSectionPage({
        assigneeId: s.assigneeId,
        groupBy: ArtifactGroupByMode.Status,
        ordering: ArtifactSectionOrdering.Retained,
        organizationId: s.organizationId,
        pageIndex: 0,
        pageSize: 10,
        viewerUserId: s.viewerUserId,
      });
      // Retained keys on the RAW column, so the unrecognized value is its own
      // section and ranks after every named status.
      expect(retained.sections).toHaveLength(2);
      expect(retained.sections.map((section) => section.total)).toEqual([1, 1]);
    });

    it("ranks an all-off-vocabulary section by its COERCED status, not its raw one", async () => {
      const s = await scope();
      // The section ORDER is a separate question from the section KEY, and this
      // is the only shape that separates them. A section holding ONLY
      // unrecognized statuses coerces to BACKLOG (rank 2) while its raw values
      // rank last (after every named status), so ordering on the raw rank puts it
      // AFTER `DONE` instead of before. A section that also holds one real
      // BACKLOG row cannot tell the two apart: the min collapses to the same rank.
      const offVocabulary = await seedRoot({
        ...s,
        name: "off vocabulary only",
        sortOrder: 0,
        status: "NOT_A_REAL_STATUS",
      });
      const done = await seedRoot({
        ...s,
        name: "done",
        sortOrder: 1,
        status: IssueStatus.Done,
      });

      const page = await pageOf(s, 0, 10);

      expect(page.sections).toHaveLength(2);
      expect(page.ids).toEqual([offVocabulary, done]);
    });

    it("returns the rows of an UNSET-priority section, not just its size", async () => {
      const s = await scope();
      // `=` on a nullable section value yields unknown, so the unset section
      // would report a size and hand back no rows — a header over an empty slot.
      const unset = await seedRoot({
        ...s,
        name: "no priority",
        priority: null,
        sortOrder: 0,
      });
      const urgent = await seedRoot({
        ...s,
        name: "urgent",
        priority: Priority.URGENT,
        sortOrder: 1,
      });

      const page = await resolveRootSectionPage({
        assigneeId: s.assigneeId,
        groupBy: ArtifactGroupByMode.Priority,
        ordering: ArtifactSectionOrdering.Vocabulary,
        organizationId: s.organizationId,
        pageIndex: 0,
        pageSize: 10,
        viewerUserId: s.viewerUserId,
      });

      expect(page.total).toBe(2);
      expect(new Set(page.ids)).toEqual(new Set([unset, urgent]));
      // Urgent first, unset last: the unset arm sorts after every real value.
      expect(page.ids).toEqual([urgent, unset]);
      expect(page.sections.map((section) => section.total)).toEqual([1, 1]);
    });

    describe("ISS-12636 root sort inside a grouped page", () => {
      /**
       * The grouped read composes the sort into TWO window functions
       * (`row_ord` and `in_section`), and `in_section` is what picks the slice —
       * so a revert there serves the wrong roots while every SQL-text and
       * ungrouped assertion stays green. Nothing else executes this statement
       * with a sort.
       */
      async function sortedSections(
        s: Scope,
        sort: AssignedTreeSort,
        groupBy:
          | typeof ArtifactGroupByMode.Status
          | typeof ArtifactGroupByMode.Assignee,
        pageSize = 10
      ) {
        return await resolveRootSectionPage({
          assigneeId: s.assigneeId,
          groupBy,
          ordering: ArtifactSectionOrdering.Vocabulary,
          organizationId: s.organizationId,
          pageIndex: 0,
          pageSize,
          sort,
          viewerUserId: s.viewerUserId,
        });
      }

      it("orders roots WITHIN a section by the requested column", async () => {
        const s = await scope();
        // Two sections, three roots each, titles disagreeing with stack rank so a
        // read that ignored the sort returns the reverse.
        const ids: Record<string, string> = {};
        for (const [index, name] of ["ccc", "bbb", "aaa"].entries()) {
          ids[`todo-${name}`] = await seedRoot({
            assigneeId: s.assigneeId,
            name: `todo-${name}`,
            organizationId: s.organizationId,
            projectId: s.projectId,
            sortOrder: index,
            status: IssueStatus.Todo,
          });
          ids[`prog-${name}`] = await seedRoot({
            assigneeId: s.assigneeId,
            name: `prog-${name}`,
            organizationId: s.organizationId,
            projectId: s.projectId,
            sortOrder: index,
            status: IssueStatus.InProgress,
          });
        }

        const page = await sortedSections(
          s,
          {
            direction: AssignedTreeSortDirection.Asc,
            key: AssignedTreeSortKey.Title,
          },
          ArtifactGroupByMode.Status
        );

        // Each section's own rows follow the title order, not the seeded rank.
        for (const section of page.sections) {
          const names = section.ids.map(
            (id) => Object.entries(ids).find(([, value]) => value === id)?.[0]
          );
          expect(names).toEqual([...names].sort());
        }
        expect(page.total).toBe(6);
      });

      it("slices a spilled section by the SORTED order, not the stack-ranked one", async () => {
        const s = await scope();
        const byName = new Map<string, string>();
        for (const [index, name] of ["ddd", "ccc", "bbb", "aaa"].entries()) {
          byName.set(
            name,
            await seedRoot({
              assigneeId: s.assigneeId,
              name,
              organizationId: s.organizationId,
              projectId: s.projectId,
              sortOrder: index,
              status: IssueStatus.Todo,
            })
          );
        }

        // One section of four, a page that holds two: `in_section` decides which
        // two, so reverting that window puts ddd/ccc here instead.
        const first = await sortedSections(
          s,
          {
            direction: AssignedTreeSortDirection.Asc,
            key: AssignedTreeSortKey.Title,
          },
          ArtifactGroupByMode.Status,
          2
        );

        expect(first.ids).toEqual([byName.get("aaa"), byName.get("bbb")]);
      });

      it("emits exactly one users join when grouping AND sorting by assignee", async () => {
        // The combination the join ternary exists for. A duplicate alias or a
        // missing one is a Postgres error, so this case throws rather than
        // returning a wrong order.
        const s = await scope();
        await seedRoot({
          assigneeId: s.assigneeId,
          name: "assignee-grouped-and-sorted",
          organizationId: s.organizationId,
          projectId: s.projectId,
          sortOrder: 1,
        });

        const grouped = await sortedSections(
          s,
          {
            direction: AssignedTreeSortDirection.Asc,
            key: AssignedTreeSortKey.Assignee,
          },
          ArtifactGroupByMode.Assignee
        );

        expect(grouped.total).toBe(1);
      });

      it("emits the users join when sorting by assignee WITHOUT grouping by it", async () => {
        // The other side of the ternary: the grouping arm does not supply the
        // join here, so the sort's own arm must.
        const s = await scope();
        await seedRoot({
          assigneeId: s.assigneeId,
          name: "status-grouped-assignee-sorted",
          organizationId: s.organizationId,
          projectId: s.projectId,
          sortOrder: 1,
        });

        const grouped = await sortedSections(
          s,
          {
            direction: AssignedTreeSortDirection.Asc,
            key: AssignedTreeSortKey.Assignee,
          },
          ArtifactGroupByMode.Status
        );

        expect(grouped.total).toBe(1);
      });
    });
  }
);
