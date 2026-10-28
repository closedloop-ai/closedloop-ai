import { CustomFieldFilterOperator } from "@repo/api/src/types/custom-field-list-query";
import { Result } from "@repo/api/src/types/result";
import { ArtifactType } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9579 — the deselected ids narrow the selection ON TOP OF a resolved
 * custom-field facet, rather than replacing it.
 *
 * `buildDocumentListWhere` emits its own `id` clause when the facets resolve to
 * an entity-id constraint, so folding `excludedIds` in with a spread would
 * overwrite it and silently WIDEN the write to rows the reader's filter had
 * excluded. The whole population is seeded here and the facet admits half of
 * it, so a clobber returns rows this assertion names as absent.
 */

const ORGANIZATION_ID = "org-1";
const USER_ID = "11111111-1111-4111-8111-111111111111";
// UUIDs, because `excludedIds` crosses the wire as `z.array(z.uuid())`.
const FACETED_IDS = [
  "00000000-0000-4000-8000-00000000fa01",
  "00000000-0000-4000-8000-00000000fa02",
  "00000000-0000-4000-8000-00000000fa03",
];
const EXCLUDED_ID = FACETED_IDS[2];
const OUTSIDE_IDS = [
  "00000000-0000-4000-8000-00000000c001",
  "00000000-0000-4000-8000-00000000c002",
];

type SeededArtifact = {
  id: string;
  organizationId: string;
  type: string;
  assigneeId: string | null;
};

const SEEDED: readonly SeededArtifact[] = [...FACETED_IDS, ...OUTSIDE_IDS].map(
  (id) => ({
    id,
    organizationId: ORGANIZATION_ID,
    type: ArtifactType.DOCUMENT,
    assigneeId: USER_ID,
  })
);

function matchesWhere(
  artifact: SeededArtifact,
  where: Record<string, unknown>
): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") {
      return (condition as Record<string, unknown>[]).every((clause) =>
        matchesWhere(artifact, clause)
      );
    }
    if (key === "id") {
      const clause = condition as { in?: string[]; notIn?: string[] };
      if (clause.in && !clause.in.includes(artifact.id)) {
        return false;
      }
      return !clause.notIn?.includes(artifact.id);
    }
    return artifact[key as keyof SeededArtifact] === condition;
  });
}

const mockWithDb = vi.hoisted(() => vi.fn());
const mockWithDbTx = vi.hoisted(() => vi.fn());
const mockResolveContext = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }) };
});
vi.mock("../custom-field-route-helpers", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCustomFieldQueryContext: (...args: unknown[]) =>
    mockResolveContext(...args),
}));

import { resolveBatchSelection } from "../batch-selection-resolver";
import { batchDeleteValidator } from "../validators";

beforeEach(() => {
  vi.clearAllMocks();
  mockWithDbTx.mockImplementation(async (callback: () => Promise<unknown>) =>
    callback()
  );
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
          findMany: ({ where, take }) =>
            Promise.resolve(
              SEEDED.filter((artifact) => matchesWhere(artifact, where))
                .slice(0, take)
                .map((artifact) => ({ id: artifact.id }))
            ),
          count: ({ where }) =>
            Promise.resolve(
              SEEDED.filter((artifact) => matchesWhere(artifact, where)).length
            ),
        },
      })
  );
  // What `readDocumentListInSnapshot` hands its reader once the facets resolve.
  mockResolveContext.mockResolvedValue(
    Result.ok({
      customFieldEntityIds: { include: [...FACETED_IDS], exclude: [] },
    })
  );
});

describe("a deselected row narrows a faceted selection instead of replacing it", () => {
  it("returns the facet's rows minus the deselected one", async () => {
    // Parsed through the REAL validator rather than handed the post-parse
    // shape: the resolver and the wire schema are the two halves of this path,
    // and a test that enters at the resolver cannot see a body the boundary
    // would have rejected.
    const body = batchDeleteValidator.parse({
      selection: {
        query: {
          assigneeId: USER_ID,
          customFieldFilters: [
            {
              fieldId: "00000000-0000-4000-8000-000000000001",
              operator: CustomFieldFilterOperator.IsAnyOf,
              values: ["x"],
            },
          ],
        },
        excludedIds: [EXCLUDED_ID],
      },
    });

    const resolved = await resolveBatchSelection(body, ORGANIZATION_ID);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect([...resolved.value.documentIds].sort()).toEqual(
      [FACETED_IDS[0], FACETED_IDS[1]].sort()
    );
    expect(resolved.value.documentIds).not.toContain(OUTSIDE_IDS[0]);
  });
});
