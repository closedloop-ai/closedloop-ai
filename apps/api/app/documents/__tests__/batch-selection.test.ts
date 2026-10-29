import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import { BatchQuerySelectionErrorCode } from "@repo/api/src/types/batch-query-selection";
import { CustomFieldFilterOperator } from "@repo/api/src/types/custom-field-list-query";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactType } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchDeleteValidator,
  batchUpdateStatusValidator,
} from "../validators";

/**
 * ISS-9579 — an action applied to "all results" operates on a set the SERVER
 * resolved from the reader's predicate, never on a list the client sent.
 *
 * The corpus below is deliberately larger than, and disjoint from, anything the
 * request carries: a query selection names zero artifact ids on the wire and
 * `excludedIds` names two, one of which is not even in the population. A
 * resolver that handed back any list it was given cannot produce the expected
 * answer, which is what makes these behavioural rather than shape assertions.
 *
 * The same in-memory-table construction `document-list-recency-bound.test.ts`
 * uses: the REAL `buildDocumentListWhere` runs against seeded rows, so the ids
 * asserted are the ids the endpoint would actually write to.
 */

const ORGANIZATION_ID = "org-1";
const FACET_FIELD_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "org-2";
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";

type SeededArtifact = {
  id: string;
  organizationId: string;
  type: string;
  assigneeId: string | null;
  projectId: string | null;
  updatedAt: Date;
};

/**
 * Evaluate the subset of Prisma `where` operators this path emits, and nothing
 * else — an unrecognized key throws rather than silently matching, so a
 * predicate clause the resolver starts producing cannot pass unnoticed.
 */
function matchesWhere(
  artifact: SeededArtifact,
  where: Record<string, unknown>
): boolean {
  return Object.entries(where).every(([key, condition]) =>
    matchesClause(artifact, key, condition)
  );
}

function matchesClause(
  artifact: SeededArtifact,
  key: string,
  condition: unknown
): boolean {
  if (key === "AND") {
    const clauses = condition as Record<string, unknown>[];
    return clauses.every((clause) => matchesWhere(artifact, clause));
  }
  if (key === "id") {
    return matchesIdClause(artifact, condition as IdClause);
  }
  if (key === "organizationId" || key === "type" || key === "assigneeId") {
    return artifact[key as keyof SeededArtifact] === condition;
  }
  throw new Error(`unhandled where clause: ${key}`);
}

type IdClause = string | { in?: string[]; notIn?: string[] };

function matchesIdClause(artifact: SeededArtifact, clause: IdClause): boolean {
  if (typeof clause === "string") {
    return artifact.id === clause;
  }
  if (clause.in && !clause.in.includes(artifact.id)) {
    return false;
  }
  return !clause.notIn?.includes(artifact.id);
}

function seedArtifact(
  id: string,
  overrides: Partial<SeededArtifact> = {}
): SeededArtifact {
  return {
    id,
    organizationId: ORGANIZATION_ID,
    type: ArtifactType.DOCUMENT,
    assigneeId: USER_ID,
    projectId: null,
    updatedAt: new Date("2026-09-20T00:00:00.000Z"),
    ...overrides,
  };
}

const mockWithDb = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, withDb: Object.assign(mockWithDb, { tx: vi.fn() }) };
});

import {
  BatchSelectionArm,
  resolveBatchSelection,
} from "../batch-selection-resolver";

let seeded: SeededArtifact[];
let findManyArgs: Record<string, unknown>[];

function matching(where: Record<string, unknown>): SeededArtifact[] {
  return seeded.filter((artifact) => matchesWhere(artifact, where));
}

beforeEach(() => {
  seeded = [];
  findManyArgs = [];
  mockWithDb.mockImplementation(
    async (
      callback: (db: {
        artifact: {
          findMany: (args: {
            where: Record<string, unknown>;
            take?: number;
          }) => Promise<{ id: string }[]>;
          count: (args: { where: Record<string, unknown> }) => Promise<number>;
        };
      }) => Promise<unknown>
    ) =>
      await callback({
        artifact: {
          findMany: (args) => {
            findManyArgs.push(args);
            const { where, take } = args;
            return Promise.resolve(
              matching(where)
                .slice(0, take)
                .map((artifact) => ({ id: artifact.id }))
            );
          },
          count: ({ where }) => Promise.resolve(matching(where).length),
        },
      })
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveBatchSelection: the set is the server's, not the caller's", () => {
  it("returns the rows the predicate matches, minus the rows the reader turned off", async () => {
    seeded = [
      seedArtifact("in-1"),
      seedArtifact("in-2"),
      seedArtifact("in-3"),
      seedArtifact("in-4"),
      seedArtifact("deselected"),
      seedArtifact("other-assignee", { assigneeId: OTHER_USER_ID }),
      seedArtifact("other-org", { organizationId: OTHER_ORGANIZATION_ID }),
      seedArtifact("not-a-document", { type: ArtifactType.BRANCH }),
    ];

    const resolved = await resolveBatchSelection(
      {
        selection: {
          query: { assigneeId: USER_ID },
          // "deselected" is in the population; "never-in-the-set" is not. The
          // request therefore names two ids and neither is an answer.
          excludedIds: ["deselected", "never-in-the-set"],
        },
      },
      ORGANIZATION_ID
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.arm).toBe(BatchSelectionArm.Query);
    expect([...resolved.value.documentIds].sort()).toEqual([
      "in-1",
      "in-2",
      "in-3",
      "in-4",
    ]);
  });

  it("reads the set in the order GET /documents publishes, because the move ranks by it", async () => {
    seeded = [seedArtifact("in-1")];

    await resolveBatchSelection(
      { selection: { query: { assigneeId: USER_ID } } },
      ORGANIZATION_ID
    );

    // Not cosmetic: `applyMove` assigns destination stack ranks from this
    // array's order, so an unordered read would let PostgreSQL's physical row
    // order decide where a reader's rows land (whitlockk on ISS-9579).
    expect(findManyArgs).toHaveLength(1);
    expect(findManyArgs[0].orderBy).toEqual([
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("passes an explicit id list straight through without reading the table", async () => {
    seeded = [seedArtifact("unrelated")];

    const resolved = await resolveBatchSelection(
      { documentIds: ["caller-1", "caller-2"] },
      ORGANIZATION_ID
    );

    expect(resolved).toEqual({
      ok: true,
      value: {
        arm: BatchSelectionArm.Ids,
        documentIds: ["caller-1", "caller-2"],
      },
    });
    expect(mockWithDb).not.toHaveBeenCalled();
  });
});

describe("resolveBatchSelection: the ceiling refuses, it never truncates", () => {
  function seedCount(total: number): void {
    seeded = Array.from({ length: total }, (_unused, index) =>
      seedArtifact(`artifact-${index}`)
    );
  }

  it("resolves a selection sitting exactly ON the ceiling", async () => {
    seedCount(BATCH_MUTATION_ENTITY_LIMIT);

    const resolved = await resolveBatchSelection(
      { selection: { query: { assigneeId: USER_ID } } },
      ORGANIZATION_ID
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.documentIds).toHaveLength(
      BATCH_MUTATION_ENTITY_LIMIT
    );
  });

  it("refuses one past the ceiling and hands back no ids at all", async () => {
    seedCount(BATCH_MUTATION_ENTITY_LIMIT + 1);

    const resolved = await resolveBatchSelection(
      { selection: { query: { assigneeId: USER_ID } } },
      ORGANIZATION_ID
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.error.code).toBe(
      BatchQuerySelectionErrorCode.SelectionTooLarge
    );
    expect(resolved.error.status).toBe(400);
    // The refusal states the measured size and the bound, so a surface can act
    // on numbers rather than parse a sentence. Both are literals here on
    // purpose: a fixture built from the constant it polices agrees with its own
    // mistake.
    expect(resolved.error.details).toEqual({ limit: 500, resolvedTotal: 501 });
  });

  it("refuses a predicate that matches nothing rather than applying an empty batch", async () => {
    seeded = [seedArtifact("other-assignee", { assigneeId: OTHER_USER_ID })];

    const resolved = await resolveBatchSelection(
      { selection: { query: { assigneeId: USER_ID } } },
      ORGANIZATION_ID
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.error.code).toBe(
      BatchQuerySelectionErrorCode.SelectionEmpty
    );
  });
});

describe("batch bodies name their set exactly one way", () => {
  it("accepts a query selection with no documentIds", () => {
    const parsed = batchUpdateStatusValidator.safeParse({
      selection: { query: { assigneeId: crypto.randomUUID() } },
      status: DocumentStatus.InReview,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a body carrying both arms", () => {
    const parsed = batchUpdateStatusValidator.safeParse({
      documentIds: [crypto.randomUUID()],
      selection: { query: {} },
      status: DocumentStatus.InReview,
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a body carrying neither arm", () => {
    const parsed = batchDeleteValidator.safeParse({});

    expect(parsed.success).toBe(false);
  });

  it("rejects paging keys, so a page can never be submitted as all-results", () => {
    const parsed = batchDeleteValidator.safeParse({
      selection: { query: { limit: 25 } },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an optimistic precondition alongside a query selection", () => {
    const documentId = crypto.randomUUID();
    const parsed = batchUpdateStatusValidator.safeParse({
      selection: { query: {} },
      expectedStatusById: { [documentId]: DocumentStatus.Draft },
      status: DocumentStatus.InReview,
    });

    expect(parsed.success).toBe(false);
  });

  // The selection travels in a JSON POST body, not a query string, so the
  // natural spelling of these three fields is the native JSON type — and it is
  // what this schema's own inferred type exposes. Four reviewers found the
  // derived shape rejecting it; these pin both spellings.
  it("accepts a native JSON array for customFieldFilters", () => {
    const parsed = batchDeleteValidator.safeParse({
      selection: {
        query: {
          customFieldFilters: [
            {
              fieldId: FACET_FIELD_ID,
              operator: CustomFieldFilterOperator.IsAnyOf,
              values: ["x"],
            },
          ],
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("still accepts the query-string spelling of customFieldFilters", () => {
    const parsed = batchDeleteValidator.safeParse({
      selection: {
        query: {
          customFieldFilters: JSON.stringify([
            {
              fieldId: FACET_FIELD_ID,
              operator: CustomFieldFilterOperator.IsAnyOf,
              values: ["x"],
            },
          ]),
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts native JSON booleans as well as the query-string strings", () => {
    const native = batchDeleteValidator.safeParse({
      selection: {
        query: { unassignedProject: true, includeArchivedProjects: false },
      },
    });
    const queryString = batchDeleteValidator.safeParse({
      selection: {
        query: { unassignedProject: "true", includeArchivedProjects: "false" },
      },
    });

    expect(native.success).toBe(true);
    expect(queryString.success).toBe(true);
    // Both spellings must land on the SAME parsed value, or one transport
    // silently selects a different population than the other.
    expect(native.success && native.data.selection?.query).toEqual(
      queryString.success && queryString.data.selection?.query
    );
  });

  it("reports the precondition conflict once, not once per guarded id", () => {
    const parsed = batchUpdateStatusValidator.safeParse({
      selection: { query: {} },
      expectedStatusById: Object.fromEntries(
        Array.from({ length: 20 }, () => [
          crypto.randomUUID(),
          DocumentStatus.Draft,
        ])
      ),
      status: DocumentStatus.InReview,
    });

    expect(parsed.success).toBe(false);
    const conflicts = parsed.success
      ? []
      : parsed.error.issues.filter((issue) =>
          issue.path.includes("expectedStatusById")
        );
    expect(conflicts).toHaveLength(1);
  });

  it("bounds the deselected id list by the same ceiling the id arm has", () => {
    const parsed = batchDeleteValidator.safeParse({
      selection: {
        query: {},
        excludedIds: Array.from(
          { length: BATCH_MUTATION_ENTITY_LIMIT + 1 },
          () => crypto.randomUUID()
        ),
      },
    });

    expect(parsed.success).toBe(false);
  });
});
