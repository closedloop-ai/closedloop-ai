import { LinkType } from "@repo/api/src/types/artifact";
import type { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType } from "@repo/database";
import { type Mock, vi } from "vitest";
import { mockWithDbCall } from "../../utils/db-helpers";
import {
  ASSIGNEE_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
} from "./assigned-artifact-tree.ids";
import {
  anchorDateWindow,
  anchorFavoritesPredicate,
  anchorHideCompleted,
  anchorOrderBy,
  anchorPriorityFilter,
  anchorProjectFilter,
  anchorStatusFilter,
  anchorTagPredicate,
  type EmittedHideCompleted,
  type EmittedPriorityFilter,
  flattenSqlValues,
  sqlText,
  typeComparisons,
} from "./assigned-artifact-tree.sql-readers";

/**
 * The fixture graph and the `$queryRaw` fake for the assignee-scoped tree.
 *
 * Two spec files read it; a second copy of `seedGraph` would let them disagree
 * about what the production query may return. The fake decides which rows come
 * back by reading the emitted SQL through `./assigned-artifact-tree.sql-readers`
 * rather than from the arguments a caller passed.
 */

export type TestArtifact = {
  id: string;
  organizationId: string;
  projectId: string | null;
  assigneeId: string | null;
  type: ArtifactType;
  /** Widened from `null` by ISS-10471: the hide-completed CASE dispatches on it. */
  subtype: string | null;
  /** Added by ISS-10471's date facet; `createdAt` above is the sibling. */
  updatedAt: Date;
  name: string;
  sortOrder: number | null;
  createdAt: Date;
  assignee: null;
  status: string;
  priority: Priority | null;
  tagIds: string[];
  /** User ids that have favorited this row. */
  favoritedBy: string[];
};

export type TestLink = {
  organizationId: string;
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  sortOrder: number | null;
  metadata: null;
  createdAt: Date;
};

type ArtifactWhere = {
  organizationId: string;
  id?: { in: string[] };
};

type LinkWhere = {
  organizationId: string;
  linkType: LinkType;
  targetId?: { in: string[] };
  sourceId?: { in: string[] };
};

/**
 * One suite's mocked database plus every accessor that reads the anchor query
 * back out of it.
 *
 * A FACTORY rather than module state: `mockReset: true` clears implementations
 * between cases, so each `beforeEach` builds a fresh harness and routes `withDb`
 * at it. Sharing one instance across cases would leak a primed `$queryRaw`
 * implementation into the next test.
 */
export type AssignedTreeHarness = {
  mockDb: MockDb;
  seedGraph: (artifacts: TestArtifact[], links: TestLink[]) => void;
  /** The anchor `$queryRaw` call at `index`, defaulting to the first. */
  anchorCall: (index?: number) => unknown;
  anchorQueryText: () => string;
  anchorQueryValues: () => unknown[];
  anchorTypeComparisons: () => {
    excluded: string[];
    required: string[];
  };
};

export function createAssignedTreeHarness(): AssignedTreeHarness {
  const mockDb = createMockDb();
  mockWithDbCall(mockDb);
  return {
    mockDb,
    seedGraph: (artifacts, links) => seedGraph(mockDb, artifacts, links),
    anchorCall: (index = 0) => mockDb.$queryRaw.mock.calls[index]?.[0],
    anchorQueryText: () => anchorQueryText(mockDb),
    anchorQueryValues: () => anchorQueryValues(mockDb),
    anchorTypeComparisons: () => anchorTypeComparisons(mockDb),
  };
}

/**
 * Annotated rather than inferred: `vi.fn()`'s own type is not nameable from
 * outside the vitest package, so an inferred shape here cannot be referenced by
 * the exported {@link AssignedTreeHarness} (TS2883).
 */
export type MockDb = {
  artifact: { findMany: Mock };
  artifactLink: { findMany: Mock };
  $queryRaw: Mock;
};

function createMockDb(): MockDb {
  return {
    artifact: { findMany: vi.fn() },
    artifactLink: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  };
}

/**
 * The anchor `$queryRaw`'s SQL TEXT, with any nested `Prisma.Sql` fragment
 * inlined. `anchorQueryValues` alone cannot see the contributor arm: that arm's
 * distinguishing part is the correlated `EXISTS (...)` clause itself, and a
 * predicate can be dropped while every bound value it happened to share with
 * the surviving arm is still bound.
 */
function anchorQueryText(db: MockDb): string {
  return db.$queryRaw.mock.calls.map((call) => sqlText(call[0])).join("\n");
}

function anchorTypeComparisons(db: MockDb): {
  excluded: string[];
  required: string[];
} {
  const all = db.$queryRaw.mock.calls.map((call) => typeComparisons(call[0]));
  return {
    excluded: all.flatMap((entry) => entry.excluded),
    required: all.flatMap((entry) => entry.required),
  };
}

/** Every bound value the anchor `$queryRaw` carried, flattened. */
function anchorQueryValues(db: MockDb): unknown[] {
  return db.$queryRaw.mock.calls.flatMap((call) => flattenSqlValues(call[0]));
}

/**
 * Back the mocked Prisma delegates with an in-memory graph that enforces the
 * SAME org scoping a real `where` clause would. A cross-organization row placed
 * in this fixture is therefore excluded by the query, not by the assertion —
 * which is what makes the cross-org test a real security assertion.
 *
 * The anchor read goes through `$queryRaw`, so the fixture reads the bound
 * values: a production query that stopped binding the organization or the
 * assignee returns nothing here and fails the test rather than passing on an
 * assertion-side filter.
 */
function seedGraph(
  mockDb: MockDb,
  artifacts: TestArtifact[],
  links: TestLink[]
): void {
  mockDb.$queryRaw.mockImplementation((sql: unknown) => {
    const values = flattenSqlValues(sql);
    if (!(values.includes(ORGANIZATION_ID) && values.includes(ASSIGNEE_ID))) {
      return Promise.resolve([]);
    }
    const limit = values.find(
      (value): value is number => typeof value === "number"
    );
    const { excluded, required } = typeComparisons(sql);
    const statuses = anchorStatusFilter(sql);
    const priorities = anchorPriorityFilter(sql);
    const tagPredicate = anchorTagPredicate(sql);
    const projects = anchorProjectFilter(sql);
    const favorites = anchorFavoritesPredicate(sql);
    const hideCompleted = anchorHideCompleted(sql);
    const dateWindow = anchorDateWindow(sql);
    const order = anchorOrderBy(sql);
    const matched = artifacts
      .filter((row) => {
        if (
          row.organizationId !== ORGANIZATION_ID ||
          excluded.includes(row.type)
        ) {
          return false;
        }
        if (statuses !== null && !statuses.includes(row.status)) {
          return false;
        }
        if (priorities !== null && !matchesEmittedPriority(row, priorities)) {
          return false;
        }
        if (tagPredicate !== null && !matchesEmittedTags(row, tagPredicate)) {
          return false;
        }
        if (
          projects !== null &&
          (row.projectId === null || !projects.includes(row.projectId))
        ) {
          return false;
        }
        // Scoped by the id the SQL actually bound, so pointing the predicate at
        // the assignee instead of the viewer changes which rows come back here.
        // Polarity and operator come from the SQL for the same reason: both
        // bind the identical viewer id.
        if (favorites !== null && !matchesEmittedFavorites(row, favorites)) {
          return false;
        }
        if (dateWindow !== null && !withinEmittedWindow(row, dateWindow)) {
          return false;
        }
        if (hideCompleted !== null) {
          const completed = isEmittedCompleted(row, hideCompleted);
          // `negated` decides which side survives. Dropping the `NOT` in
          // production inverts the facet, and this is what makes that visible.
          if (hideCompleted.negated ? completed : !completed) {
            return false;
          }
        }
        // ISS-12463 left one arm, so the admission rule is the assignee alone.
        return (
          row.assigneeId === ASSIGNEE_ID &&
          (required.length === 0 || required.includes(row.type))
        );
      })
      .sort((a, b) => compareByEmittedOrder(a, b, order))
      .slice(0, limit ?? artifacts.length);
    return Promise.resolve(matched.map((row) => ({ id: row.id })));
  });

  mockDb.artifact.findMany.mockImplementation(
    ({ where }: { where: ArtifactWhere }) => {
      const scoped = artifacts.filter(
        (row) => row.organizationId === where.organizationId
      );
      const ids = where.id?.in ?? [];
      return Promise.resolve(scoped.filter((row) => ids.includes(row.id)));
    }
  );

  mockDb.artifactLink.findMany.mockImplementation(
    ({ where }: { where: LinkWhere }) =>
      Promise.resolve(
        links
          .filter(
            (row) =>
              row.organizationId === where.organizationId &&
              row.linkType === where.linkType &&
              (where.targetId
                ? where.targetId.in.includes(row.targetId)
                : (where.sourceId?.in.includes(row.sourceId) ?? false))
          )
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.sourceId.localeCompare(b.sourceId)
          )
      )
  );
}

export function artifact(
  id: string,
  overrides: Partial<TestArtifact> = {}
): TestArtifact {
  return {
    id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    assigneeId: null,
    type: ArtifactType.DOCUMENT,
    subtype: ArtifactSubtype.PRD,
    name: id,
    sortOrder: null,
    createdAt: new Date("2026-07-03T00:00:00.000Z"),
    updatedAt: new Date("2026-07-03T00:00:00.000Z"),
    assignee: null,
    status: IssueStatus.Todo,
    priority: null,
    tagIds: [],
    favoritedBy: [],
    ...overrides,
  };
}

export function link(
  sourceId: string,
  targetId: string,
  overrides: Partial<TestLink> = {}
): TestLink {
  return {
    organizationId: ORGANIZATION_ID,
    sourceId,
    targetId,
    linkType: LinkType.Produces,
    sortOrder: null,
    metadata: null,
    createdAt: new Date("2026-07-03T00:00:00.000Z"),
    ...overrides,
  };
}

export function collectArtifactIds(result: {
  nodes: { root: { id: string }; children: { id: string }[] }[];
  externalParents: { parent: { id: string } }[];
}): string[] {
  const ids: string[] = [];
  for (const node of result.nodes) {
    ids.push(node.root.id, ...node.children.map((child) => child.id));
  }
  for (const entry of result.externalParents) {
    ids.push(entry.parent.id);
  }
  return ids;
}

/**
 * Whether a fixture row satisfies the priority predicate AS EMITTED — the ORed
 * member and unset arms, not a convenience `includes`, so dropping either arm
 * in production changes which rows come back here.
 */
function matchesEmittedPriority(
  row: TestArtifact,
  emitted: EmittedPriorityFilter
): boolean {
  // Postgres would match nothing: no row is both a listed member and null. The
  // fake says so rather than quietly reading the arms as a union.
  if (emitted.combinator === "AND") {
    return false;
  }
  if (row.priority === null) {
    return emitted.includesUnset;
  }
  return emitted.members.includes(row.priority);
}

/**
 * Whether a fixture row is "completed" under the vocabularies the SQL actually
 * bound, dispatching the way the CASE does. Reading the lists out of the query
 * rather than importing them is what makes a wrong list on an arm visible here.
 */
function isEmittedCompleted(
  row: TestArtifact,
  emitted: EmittedHideCompleted
): boolean {
  if (row.type === ArtifactType.DOCUMENT) {
    // `emitted.issueSubtypes`, not the harness's own set: routing a row by what
    // we THINK belongs on the issue arm is how dropping `ISSUE` from the query
    // stayed green.
    return row.subtype !== null && emitted.issueSubtypes.includes(row.subtype)
      ? emitted.issue.includes(row.status)
      : emitted.document.includes(row.status);
  }
  // Every other type stays visible, as the CASE's `ELSE false` says. A BRANCH
  // lands here because ISS-12463 took branches out of the anchor set, so the
  // predicate never sees one.
  return false;
}

/**
 * Whether a fixture row falls inside the window AS EMITTED — the column the SQL
 * named and the inclusivity it asked for, so switching either changes which
 * rows come back here rather than only changing the query text.
 */
function withinEmittedWindow(
  row: TestArtifact,
  emitted: NonNullable<ReturnType<typeof anchorDateWindow>>
): boolean {
  const value = emitted.column === "created_at" ? row.createdAt : row.updatedAt;
  const afterFrom = emitted.fromInclusive
    ? value >= emitted.from
    : value > emitted.from;
  const beforeTo = emitted.toInclusive
    ? value <= emitted.to
    : value < emitted.to;
  return afterFrom && beforeTo;
}

function matchesEmittedTags(
  row: TestArtifact,
  emitted: { tagIds: string[]; negated: boolean; membership: string }
): boolean {
  // ANY, matching the `EXISTS` production emits: one shared tag admits the row.
  const anyShared =
    emitted.membership === "NOT IN"
      ? row.tagIds.some((id) => !emitted.tagIds.includes(id))
      : row.tagIds.some((id) => emitted.tagIds.includes(id));
  return emitted.negated ? !anyShared : anyShared;
}

function matchesEmittedFavorites(
  row: TestArtifact,
  emitted: { userId: string | null; negated: boolean; operator: string }
): boolean {
  if (emitted.userId === null) {
    return true;
  }
  const favorited =
    emitted.operator === "<>"
      ? row.favoritedBy.some((id) => id !== emitted.userId)
      : row.favoritedBy.includes(emitted.userId);
  return emitted.negated ? !favorited : favorited;
}

function compareByEmittedOrder(
  a: TestArtifact,
  b: TestArtifact,
  order: { createdAt: string; id: string } | null
): number {
  // A missing ORDER BY is Postgres returning rows in no defined order; the fake
  // must not invent one, so it reports the pair as tied and the cap then slices
  // an arbitrary set — which is what an anchor query with no sort would do.
  if (order === null) {
    return 0;
  }
  const created =
    order.createdAt === "DESC"
      ? b.createdAt.getTime() - a.createdAt.getTime()
      : a.createdAt.getTime() - b.createdAt.getTime();
  if (created !== 0) {
    return created;
  }
  return order.id === "ASC"
    ? a.id.localeCompare(b.id)
    : b.id.localeCompare(a.id);
}
