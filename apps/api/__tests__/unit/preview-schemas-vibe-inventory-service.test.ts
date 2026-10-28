/**
 * ISS-12216: the reads behind `/preview-schemas/vibe-inventory`. `withDb` is
 * mocked; the assertions read the bound values and the row mapping, which is
 * what decides whether a deleted vibe branch's pins are released.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDb } = vi.hoisted(() => ({ mockWithDb: vi.fn() }));

vi.mock("@repo/database", () => ({
  withDb: mockWithDb,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { vibeInventoryService } from "@/app/preview-schemas/vibe-inventory/service";
import { readSqlText } from "./preview-schemas-mocks";

const BRANCH = "vibe/bulk-tags";
const WRITE_STATEMENT = /\b(DELETE|DROP|UPDATE|INSERT|TRUNCATE|ALTER)\b/i;

function answerOnce(rows: unknown[]) {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({ $queryRaw: queryRaw })
  );
  return queryRaw;
}

describe("vibeInventoryService.readSchemaPresence", () => {
  beforeEach(() => {
    mockWithDb.mockReset();
  });

  it("looks up the schema normalizePreviewSchemaName gives the branch", async () => {
    const schemaName = normalizePreviewSchemaName(BRANCH);
    const queryRaw = answerOnce([{ nspname: schemaName }]);

    expect(await vibeInventoryService.readSchemaPresence(BRANCH)).toEqual({
      branch: BRANCH,
      schemaName,
      exists: true,
    });
    const [query] = queryRaw.mock.calls[0] ?? [];
    expect(readSqlText(query)).toContain("pg_namespace");
    expect(query.values).toEqual([schemaName]);
  });

  // ISS-12216 security review: the pin aliases of `vibe/Bulk-Tags` and
  // `vibe/bulk-tags` share a name, but their schemas must not, or one branch's
  // answer would stand in for the other's.
  it("answers for a case variant of a branch with that variant's own schema", async () => {
    const queryRaw = answerOnce([]);

    const presence =
      await vibeInventoryService.readSchemaPresence("vibe/Bulk-Tags");

    expect(presence.schemaName).not.toBe(normalizePreviewSchemaName(BRANCH));
    expect(queryRaw.mock.calls[0]?.[0].values).toEqual([presence.schemaName]);
  });

  it("reports a dropped schema as absent", async () => {
    answerOnce([]);

    expect((await vibeInventoryService.readSchemaPresence(BRANCH)).exists).toBe(
      false
    );
  });
});

describe("vibeInventoryService.listEnvironments", () => {
  beforeEach(() => {
    mockWithDb.mockReset();
  });

  it("reads only vibe/, prototype/ and functional-prototype/ registry rows and keeps dropped ones with no size", async () => {
    const queryRaw = answerOnce([
      {
        branch: BRANCH,
        schema_name: "preview_live",
        created_at: new Date("2026-10-02T07:17:00Z"),
        schema_exists: true,
        size_bytes: BigInt(5_242_880),
      },
      {
        branch: "vibe/discarded",
        schema_name: "preview_gone",
        created_at: new Date("2026-10-03T07:17:00Z"),
        schema_exists: false,
        size_bytes: BigInt(0),
      },
    ]);

    expect(await vibeInventoryService.listEnvironments()).toEqual([
      {
        branch: BRANCH,
        schemaName: "preview_live",
        createdAt: "2026-10-02T07:17:00.000Z",
        schemaExists: true,
        sizeBytes: 5_242_880,
      },
      {
        branch: "vibe/discarded",
        schemaName: "preview_gone",
        createdAt: "2026-10-03T07:17:00.000Z",
        schemaExists: false,
        sizeBytes: null,
      },
    ]);
    const [query] = queryRaw.mock.calls[0] ?? [];
    expect(readSqlText(query)).toContain("public.preview_schemas");
    expect(query.values).toEqual([
      ["vibe/%", "prototype/%", "functional-prototype/%"],
    ]);
  });

  // ISS-12414 AC2: listing more prefixes must stay a read.
  it("only reads: the listing query holds no write or drop statement", async () => {
    const queryRaw = answerOnce([]);

    await vibeInventoryService.listEnvironments();

    const [query] = queryRaw.mock.calls[0] ?? [];
    expect(readSqlText(query)).not.toMatch(WRITE_STATEMENT);
  });
});
