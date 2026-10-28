/**
 * ISS-12600 review (davetho, P2): a scoped cost read resolves its custom-field
 * facets and the population they select in ONE snapshot. The fake serves every
 * read inside `withDb.tx` from a copy of the store taken when the transaction
 * opens, and lands a concurrent write on the live store between the two facet
 * reads, so a resolution that leaves the snapshot sees a document flip from
 * `A=high, B=low` to `A=low, B=high` and wrongly admits it to `A AND B`.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { CustomFieldFilterOperator } from "@repo/api/src/types/custom-field-list-query";
import { DocumentType } from "@repo/api/src/types/document";
import { Prisma } from "@repo/database";
import { beforeEach, expect, it, vi } from "vitest";
import {
  type FixtureRow,
  findManyRows,
  matchesWhere,
} from "@/__tests__/support/documents/prisma-where.test-db";

type Store = {
  artifacts: Record<string, unknown>[];
  fields: Record<string, unknown>[];
  values: Record<string, unknown>[];
};

const harness = vi.hoisted(() => ({
  live: { artifacts: [], fields: [], values: [] } as Store,
  snapshot: null as Store | null,
  isolationLevels: [] as unknown[],
  valueReads: 0,
  interleave: (): void => undefined,
  costedArtifactIds: new Set<string>(),
}));

vi.mock("@repo/database", async (importActual) => {
  const actual = await importActual<typeof import("@repo/database")>();
  const view = () => harness.snapshot ?? harness.live;
  const db = {
    artifact: {
      count: async (args: { where?: unknown }) =>
        view().artifacts.filter((row) => matchesWhere(row, args.where)).length,
      findMany: async (args: unknown) => findManyRows(view().artifacts, args),
    },
    customField: {
      findFirst: async (args: { where?: unknown }) =>
        view().fields.find((row) => matchesWhere(row, args.where)) ?? null,
    },
    customFieldValue: {
      findMany: async (args: unknown) => {
        const rows = findManyRows(view().values, args);
        harness.valueReads += 1;
        if (harness.valueReads === 1) {
          harness.interleave();
        }
        return await rows;
      },
    },
    artifactLink: {
      findMany: (args: { where: { targetId: { in: string[] } } }) => {
        for (const id of args.where.targetId.in) {
          harness.costedArtifactIds.add(id);
        }
        return Promise.resolve([]);
      },
    },
  };
  const withDb = Object.assign(
    async (run: (client: typeof db) => unknown) => await run(db),
    {
      tx: async (
        run: () => unknown,
        options?: { isolationLevel?: unknown }
      ) => {
        harness.isolationLevels.push(options?.isolationLevel);
        harness.snapshot = structuredClone(harness.live);
        try {
          return await run();
        } finally {
          harness.snapshot = null;
        }
      },
    }
  );
  return { ...actual, withDb };
});

import { documentCostScopeService } from "../document-cost-scope-service";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const USER = "00000000-0000-4000-8000-0000000000c0";
const FIELD_A = "00000000-0000-4000-8000-0000000000f1";
const FIELD_B = "00000000-0000-4000-8000-0000000000f4";
const HIGH = "00000000-0000-4000-8000-0000000000f2";
const LOW = "00000000-0000-4000-8000-0000000000f3";
const FLIPPED = "00000000-0000-4000-8000-000000000101";
const BOTH = "00000000-0000-4000-8000-000000000102";

beforeEach(() => {
  harness.snapshot = null;
  harness.isolationLevels = [];
  harness.valueReads = 0;
  harness.costedArtifactIds.clear();
  harness.live = {
    artifacts: [row(FLIPPED), row(BOTH)],
    fields: [field(FIELD_A), field(FIELD_B)],
    values: [
      value(FLIPPED, FIELD_A, HIGH),
      value(FLIPPED, FIELD_B, LOW),
      value(BOTH, FIELD_A, HIGH),
      value(BOTH, FIELD_B, HIGH),
    ],
  };
  // One atomic update to the live store: A high→low and B low→high together.
  harness.interleave = () => {
    for (const entry of harness.live.values) {
      if (entry.entityId === FLIPPED) {
        entry.enumValueId = entry.customFieldId === FIELD_A ? LOW : HIGH;
      }
    }
  };
});

it("costs only documents that matched every facet in one snapshot", async () => {
  const result = await documentCostScopeService.read(ORG, USER, {
    artifactIds: [],
    scope: {
      types: [DocumentType.Prd],
      customFieldFilters: [
        {
          fieldId: FIELD_A,
          operator: CustomFieldFilterOperator.IsAnyOf,
          values: [HIGH],
        },
        {
          fieldId: FIELD_B,
          operator: CustomFieldFilterOperator.IsAnyOf,
          values: [HIGH],
        },
      ],
    },
  });

  expect(result.ok).toBe(true);
  expect(harness.valueReads).toBeGreaterThanOrEqual(2);
  expect(harness.isolationLevels).toEqual([
    Prisma.TransactionIsolationLevel.RepeatableRead,
  ]);
  expect([...harness.costedArtifactIds]).toEqual([BOTH]);
});

function row(id: string): FixtureRow {
  return {
    id,
    organizationId: ORG,
    type: ArtifactType.Document,
    subtype: DocumentType.Prd,
    assigneeId: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    tagArtifacts: [],
    favoritedBy: [],
    targetLinks: [],
    document: { latestVersion: 2 },
  };
}

function field(id: string) {
  return {
    id,
    organizationId: ORG,
    fieldType: CustomFieldType.Enum,
    isSortable: true,
    isSearchable: true,
    entityTypes: [CustomFieldEntityType.Document],
  };
}

function value(entityId: string, customFieldId: string, enumValueId: string) {
  return {
    id: `value-${entityId}-${customFieldId}`,
    organizationId: ORG,
    entityType: CustomFieldEntityType.Document,
    customFieldId,
    entityId,
    enumValueId,
  };
}
