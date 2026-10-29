/**
 * ISS-10471: every anchor facet, executed against a real Postgres.
 *
 * The seven facets each have a unit suite that reads the EMITTED `Prisma.sql`
 * back out of a mocked client. That proves the service builds the predicate it
 * meant to build; it cannot prove Postgres accepts the predicate or selects the
 * rows the browser's own filter would (marisolashgrove, PR #8897). Three of them
 * are not decidable from the SQL text at all:
 *
 * - `dateWindow` binds a JS `Date` against `timestamp(3) without time zone`, so
 *   an offset in the binding moves both ends of a window the chip presents as
 *   inclusive. The two cases below put rows EXACTLY on `from` and on `to`, and
 *   assert the `created_at` and `updated_at` windows return DIFFERENT sets, so
 *   the column switch cannot be satisfied by one column answering for both.
 * - `hideCompletedItems` is a `NOT (CASE ...)`. A NULL `subtype` makes the first
 *   `WHEN` NULL rather than false, and SQL three-valued logic decides which arm
 *   a null-subtype DOCUMENT lands on — a JS-object fake models that only if
 *   whoever wrote it already knew the answer.
 * - `priority` compares the enum column against INLINED enum literals, and the
 *   arm for an unset priority cannot ride along in the `IN`. The 2026-10-19
 *   note here was right that no row set can falsify a claim about the PLAN, and
 *   wrong about which way that claim ran: it concluded the `a.priority::text`
 *   cast earned its place. Measured 2026-10-21 (ISS-12657) it does not — a cast
 *   on the COLUMN cannot be indexed at all, because the enum-to-text cast is
 *   STABLE rather than IMMUTABLE and Postgres refuses the expression index. On
 *   a 250k-row assignee the cast produced a parallel sequential scan. What this
 *   case still settles is the row set: that the predicate compares a real enum
 *   column and that the two arms OR.
 *
 * Why it matters past this slice: no client sends a facet yet, so the first real
 * request will come from the ISS-10472 PR rather than this one, and a typo in
 * any predicate surfaces there as a 500 rather than here as a red test.
 *
 * Read-only cases over ONE committed fixture. `resolveTreeAnchors` runs its own
 * `withDb`, so the rows have to be committed rather than held in a rolled-back
 * transaction, which is also why the fixture is torn down explicitly.
 */

import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { ArtifactSubtype, ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveTreeAnchors,
  type TreeAnchorFilters,
} from "@/app/artifacts/assigned-artifact-tree-anchors";
import { generateSlug } from "@/app/documents/document-utils";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const organizations = createCommittedTestOrganizationTracker();

/**
 * The window both date cases ask for, and the four instants around it. `AT_FROM`
 * and `AT_TO` are the window's own ends, so a binding that shifted by any
 * nonzero offset drops at least one of them out of an inclusive window.
 */
const WINDOW_FROM = new Date("2026-03-10T00:00:00.000Z");
const WINDOW_TO = new Date("2026-03-20T23:59:59.999Z");
const BEFORE_WINDOW = new Date("2026-03-09T23:59:59.999Z");
const AFTER_WINDOW = new Date("2026-03-21T00:00:00.000Z");

/**
 * Explicit ids so each assertion names the row it is about. Canonical lowercase
 * with hyphens at the four standard positions, the only shape a `uuid` column
 * holds.
 */
const ID = {
  prdDraft: "beef0000-0000-7000-8000-000000000001",
  prdExecuted: "beef0000-0000-7000-8000-000000000002",
  prdApproved: "beef0000-0000-7000-8000-000000000003",
  issueTodo: "beef0000-0000-7000-8000-000000000004",
  issueDone: "beef0000-0000-7000-8000-000000000005",
  nullSubtypeExecuted: "beef0000-0000-7000-8000-000000000006",
  nullSubtypeDraft: "beef0000-0000-7000-8000-000000000007",
  otherAssignee: "beef0000-0000-7000-8000-000000000008",
} as const;

type SeedRow = {
  id: string;
  subtype: ArtifactSubtype | null;
  status: string;
  priority: Priority | null;
  project: "a" | "b";
  createdAt: Date;
  /** Pinned with a raw `UPDATE`: Prisma's `@updatedAt` overwrites it on create. */
  updatedAt: Date;
  ofOtherAssignee?: true;
};

const SEED_ROWS: readonly SeedRow[] = [
  {
    id: ID.prdDraft,
    subtype: ArtifactSubtype.PRD,
    status: DocumentStatus.Draft,
    priority: Priority.High,
    project: "a",
    createdAt: WINDOW_FROM,
    updatedAt: WINDOW_FROM,
  },
  {
    id: ID.prdExecuted,
    subtype: ArtifactSubtype.PRD,
    status: DocumentStatus.Executed,
    priority: null,
    project: "a",
    createdAt: WINDOW_TO,
    updatedAt: WINDOW_TO,
  },
  // APPROVED is the asymmetry hide-completed exists to preserve: it is terminal
  // for a blocker check and NOT completed for this filter.
  {
    id: ID.prdApproved,
    subtype: ArtifactSubtype.PRD,
    status: DocumentStatus.Approved,
    priority: Priority.Low,
    project: "a",
    createdAt: BEFORE_WINDOW,
    updatedAt: AFTER_WINDOW,
  },
  {
    id: ID.issueTodo,
    subtype: ArtifactSubtype.ISSUE,
    status: IssueStatus.Todo,
    priority: Priority.Medium,
    project: "b",
    createdAt: AFTER_WINDOW,
    updatedAt: AFTER_WINDOW,
  },
  {
    id: ID.issueDone,
    subtype: ArtifactSubtype.ISSUE,
    status: IssueStatus.Done,
    priority: Priority.Urgent,
    project: "b",
    createdAt: AFTER_WINDOW,
    updatedAt: AFTER_WINDOW,
  },
  // The two null-subtype rows: same missing subtype, opposite expected outcome,
  // so the arm they land on is observable rather than inferred.
  {
    id: ID.nullSubtypeExecuted,
    subtype: null,
    status: DocumentStatus.Executed,
    priority: null,
    project: "a",
    createdAt: BEFORE_WINDOW,
    updatedAt: AFTER_WINDOW,
  },
  {
    id: ID.nullSubtypeDraft,
    subtype: null,
    status: DocumentStatus.Draft,
    priority: Priority.High,
    project: "b",
    createdAt: WINDOW_FROM,
    updatedAt: AFTER_WINDOW,
  },
  // Never an anchor of the assignee under test, on any facet. Present so a
  // predicate that lost its assignee scoping fails here instead of in ISS-10472.
  {
    id: ID.otherAssignee,
    subtype: ArtifactSubtype.PRD,
    status: DocumentStatus.Draft,
    priority: Priority.High,
    project: "a",
    createdAt: WINDOW_FROM,
    updatedAt: WINDOW_FROM,
    ofOtherAssignee: true,
  },
];

type Fixture = {
  organizationId: string;
  assigneeId: string;
  /** The READER, deliberately not the assignee: the favorites facet is viewer-scoped. */
  viewerUserId: string;
  projectAId: string;
  projectBId: string;
  /** Two tags, because one cannot tell ANY-of semantics from ALL-of. */
  sharedTagId: string;
  issueOnlyTagId: string;
};

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const organizationId = await organizations.create();
  const assignee = await createTestUser(organizationId);
  const viewer = await createTestUser(organizationId);
  const otherAssignee = await createTestUser(organizationId);
  const projectAId = await createTestProject(organizationId, assignee.id, {
    name: "Facet Project A",
  });
  const projectBId = await createTestProject(organizationId, assignee.id, {
    name: "Facet Project B",
  });

  for (const row of SEED_ROWS) {
    await withDb((db) =>
      db.artifact.create({
        data: {
          id: row.id,
          name: `facet-${row.id.slice(-2)}`,
          slug: generateSlug(),
          type: ArtifactType.DOCUMENT,
          subtype: row.subtype,
          status: row.status,
          priority: row.priority,
          organizationId,
          createdById: assignee.id,
          assigneeId: row.ofOtherAssignee ? otherAssignee.id : assignee.id,
          projectId: row.project === "a" ? projectAId : projectBId,
          createdAt: row.createdAt,
        },
        select: { id: true },
      })
    );
    await withDb((db) =>
      db.$executeRaw(
        Prisma.sql`UPDATE artifacts SET updated_at = ${row.updatedAt} WHERE id = ${row.id}::uuid`
      )
    );
  }

  const sharedTag = await withDb((db) =>
    db.tag.create({
      data: {
        organizationId,
        name: "facet-tag-shared",
        color: "#123456",
        createdById: assignee.id,
        tagArtifacts: {
          create: [{ artifactId: ID.prdDraft }, { artifactId: ID.issueTodo }],
        },
      },
      select: { id: true },
    })
  );
  // Disjoint from `sharedTag`, so selecting both tags has a union that differs
  // from either tag alone AND from their (empty) intersection.
  const issueOnlyTag = await withDb((db) =>
    db.tag.create({
      data: {
        organizationId,
        name: "facet-tag-issue-only",
        color: "#654321",
        createdById: assignee.id,
        tagArtifacts: { create: [{ artifactId: ID.issueDone }] },
      },
      select: { id: true },
    })
  );

  // One favorite per user, on DIFFERENT rows: a viewer-scoped facet and an
  // assignee-scoped one cannot both be satisfied by the same answer.
  await withDb((db) =>
    db.favoriteArtifact.createMany({
      data: [
        { userId: viewer.id, artifactId: ID.prdApproved },
        { userId: assignee.id, artifactId: ID.issueTodo },
      ],
    })
  );

  return {
    organizationId,
    assigneeId: assignee.id,
    viewerUserId: viewer.id,
    projectAId,
    projectBId,
    sharedTagId: sharedTag.id,
    issueOnlyTagId: issueOnlyTag.id,
  };
}

/** An id of the right shape that names no row, for probing a joined `IN` list. */
const ABSENT_ID = "beef0000-0000-7000-8000-0000000000ff";

/**
 * Does the row's stored `created_at` equal the wall clock `WINDOW_FROM` names,
 * judged by a SQL LITERAL rather than by a bound `Date`?
 *
 * The window assertions alone cannot answer this. They bind a `Date` on the way
 * in (the fixture) and another on the way out (the facet), so an offset applied
 * on both paths cancels and the boundary rows still land inside the window. A
 * literal is the independent oracle: `timestamp without time zone` takes it at
 * face value, so it disagrees with a stored local-time wall clock.
 */
function storesWindowFromAtFaceValue(): Promise<boolean> {
  return withDb(async (db) => {
    const rows = await db.$queryRaw<Array<{ exact: boolean }>>(
      Prisma.sql`
        SELECT (a.created_at = TIMESTAMP '2026-03-10 00:00:00.000') AS exact
        FROM artifacts a
        WHERE a.id = ${ID.prdDraft}::uuid
      `
    );
    return rows[0]?.exact === true;
  });
}

/** The ids the production anchor query selects, as a set, for one facet choice. */
async function anchorIds(filters: TreeAnchorFilters): Promise<string[]> {
  const { ids } = await resolveTreeAnchors(
    fixture.assigneeId,
    fixture.organizationId,
    fixture.viewerUserId,
    filters
  );
  return [...ids].sort();
}

function sorted(...ids: string[]): string[] {
  return [...ids].sort();
}

describe.skipIf(!hasDatabase)("assigned-tree anchor facets (Postgres)", () => {
  beforeAll(async () => {
    fixture = await seedFixture();
  });

  // `createCommittedTestOrganizationTracker` commits its fixture and does NOT
  // tear it down for you, so without this every run leaves one behind.
  afterAll(async () => {
    await organizations.cleanup();
  });

  it("admits every row of the assignee and none of another's with no facet", async () => {
    // The control the seven cases below are narrowings OF. Without it a
    // predicate that matched nothing would satisfy any exclusion assertion.
    await expect(anchorIds({})).resolves.toEqual(
      sorted(
        ID.prdDraft,
        ID.prdExecuted,
        ID.prdApproved,
        ID.issueTodo,
        ID.issueDone,
        ID.nullSubtypeExecuted,
        ID.nullSubtypeDraft
      )
    );
  });

  it("narrows on status, across both lifecycle vocabularies", async () => {
    await expect(
      anchorIds({ status: [DocumentStatus.Approved, IssueStatus.Done] })
    ).resolves.toEqual(sorted(ID.prdApproved, ID.issueDone));
  });

  it("narrows on priority against the enum column, unset as its own arm", async () => {
    // Members only.
    await expect(
      anchorIds({ priority: [Priority.High, Priority.Urgent] })
    ).resolves.toEqual(sorted(ID.prdDraft, ID.nullSubtypeDraft, ID.issueDone));

    // Unset only. No value list matches NULL, so this arm cannot ride along
    // in the `IN` and is asserted separately.
    await expect(
      anchorIds({ priority: [PRIORITY_UNSET_VALUE] })
    ).resolves.toEqual(sorted(ID.prdExecuted, ID.nullSubtypeExecuted));

    // Both arms ORed. Strictly more than either alone, which a single `IN`
    // carrying a bogus "NONE" member could not produce.
    await expect(
      anchorIds({ priority: [Priority.Urgent, PRIORITY_UNSET_VALUE] })
    ).resolves.toEqual(
      sorted(ID.issueDone, ID.prdExecuted, ID.nullSubtypeExecuted)
    );
  });

  it("narrows on tag membership, ANY of the selected tags", async () => {
    await expect(anchorIds({ tagIds: [fixture.sharedTagId] })).resolves.toEqual(
      sorted(ID.prdDraft, ID.issueTodo)
    );
    await expect(
      anchorIds({ tagIds: [fixture.issueOnlyTagId] })
    ).resolves.toEqual([ID.issueDone]);

    // The two tags share no artifact, so ANY returns the UNION where ALL
    // would return nothing. One tag cannot tell those apart, and the browser
    // predicate this must agree with (`matchesTagFilter`) is ANY.
    await expect(
      anchorIds({ tagIds: [fixture.sharedTagId, fixture.issueOnlyTagId] })
    ).resolves.toEqual(sorted(ID.prdDraft, ID.issueTodo, ID.issueDone));
  });

  it("narrows on project", async () => {
    await expect(
      anchorIds({ projectIds: [fixture.projectBId] })
    ).resolves.toEqual(sorted(ID.issueTodo, ID.issueDone, ID.nullSubtypeDraft));

    // The matching id goes SECOND. A joined `IN` list that reached Postgres
    // carrying only its first element would return nothing here, while the
    // union of both real projects would be indistinguishable from no
    // predicate at all.
    await expect(
      anchorIds({ projectIds: [ABSENT_ID, fixture.projectAId] })
    ).resolves.toEqual(
      sorted(
        ID.prdDraft,
        ID.prdExecuted,
        ID.prdApproved,
        ID.nullSubtypeExecuted
      )
    );
  });

  it("narrows on the VIEWER's favorites, never the assignee's", async () => {
    // The assignee favorited `issueTodo` and the viewer favorited
    // `prdApproved`. Resolving the facet against the subject instead of the
    // reader would return the other row, so this case distinguishes them.
    await expect(anchorIds({ favoritesOnly: true })).resolves.toEqual([
      ID.prdApproved,
    ]);

    // `false` narrows nothing, which is the facet's stated polarity and not a
    // default waiting to be chosen.
    await expect(anchorIds({ favoritesOnly: false })).resolves.toEqual(
      await anchorIds({})
    );
  });

  it("hides completed per vocabulary, judging a null subtype by the document arm", async () => {
    const visible = await anchorIds({ hideCompletedItems: true });

    // EXECUTED hides on the document arm and DONE on the issue arm; APPROVED
    // stays because an approved document still awaits execution.
    expect(visible).toEqual(
      sorted(ID.prdDraft, ID.prdApproved, ID.issueTodo, ID.nullSubtypeDraft)
    );

    // The three-valued-logic case Marisol named. A NULL subtype makes the first
    // `WHEN` NULL rather than false, so the row falls through to the document
    // arm — asserted on BOTH null-subtype rows, because a predicate that
    // dropped every null subtype would also satisfy the EXECUTED half alone.
    expect(visible).toContain(ID.nullSubtypeDraft);
    expect(visible).not.toContain(ID.nullSubtypeExecuted);
  });

  it("bounds a created_at window inclusively at both ends", async () => {
    // Checked first, against a SQL literal: without it the two bound `Date`s
    // below could share one offset and still agree with each other.
    await expect(storesWindowFromAtFaceValue()).resolves.toBe(true);

    // `prdDraft` sits exactly on `from` and `prdExecuted` exactly on `to`, so
    // an offset in the bound `Date` drops one of them.
    await expect(
      anchorIds({
        dateWindow: {
          field: ArtifactDateField.CreatedAt,
          from: WINDOW_FROM,
          to: WINDOW_TO,
        },
      })
    ).resolves.toEqual(
      sorted(ID.prdDraft, ID.prdExecuted, ID.nullSubtypeDraft)
    );
  });

  it("reads updated_at when asked for it, not created_at", async () => {
    // Deliberately a DIFFERENT set from the created_at case above:
    // `nullSubtypeDraft` is inside the created_at window and outside this
    // one, so one column cannot answer for both.
    await expect(
      anchorIds({
        dateWindow: {
          field: ArtifactDateField.UpdatedAt,
          from: WINDOW_FROM,
          to: WINDOW_TO,
        },
      })
    ).resolves.toEqual(sorted(ID.prdDraft, ID.prdExecuted));
  });
});
