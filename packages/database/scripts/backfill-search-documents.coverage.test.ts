/**
 * ISS-11298 — coverage-recovery unit tests for the `search_document` backfill.
 *
 * Targets branches the existing per-corpus test files never reach:
 * `toSearchBackfillClient`'s raw-SQL delegates (`upsertRowsRaw`,
 * `removeStaleAgentComponentProjectionsRaw`), including the empty-rows
 * short-circuit and both sides of each nullable-foreign-key ternary. No
 * database is used — `tx.$executeRaw` is a plain mock standing in for the
 * tagged-template call, which is all these functions need to build and issue
 * their statement. Pins current behavior exactly; no source changes.
 */

import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../generated/client";
import type { TransactionClient } from "../index";
import { toSearchBackfillClient } from "./backfill-search-documents";
import type { ProjectionRow } from "./search-backfill-types";

const AT = new Date("2026-07-22T00:00:00.000Z");
const VALUES_CLAUSE = /VALUES (.*)\n/;
const FRESH_DOCUMENT_STATUS = (idParam: number) =>
  `COALESCE((SELECT a."status" FROM "artifacts" AS a WHERE a."id" = $${idParam}::uuid AND a."organization_id" = $${idParam + 1}::uuid), $${idParam + 2})`;

function fullRow(over: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    organizationId: "org-a",
    entityType: SearchEntityType.Document,
    entityId: "entity-1",
    title: "Title",
    body: "Body",
    projectId: "project-1",
    assigneeId: "assignee-1",
    status: "open",
    priority: "high",
    updatedAt: AT,
    slug: "slug-1",
    entitySubtype: "PRD",
    teamId: "team-1",
    anchorEntityId: "anchor-1",
    ...over,
  };
}

function nullForeignKeyRow(over: Partial<ProjectionRow> = {}): ProjectionRow {
  return fullRow({
    entityId: "entity-2",
    projectId: null,
    assigneeId: null,
    teamId: null,
    anchorEntityId: null,
    ...over,
  });
}

/**
 * A fake transaction whose `$executeRaw` is a plain mock standing in for the
 * tagged-template call — sufficient to drive `upsertRowsRaw` and
 * `removeStaleAgentComponentProjectionsRaw`, which only build and issue one
 * statement each. The other delegates are never invoked by these two
 * functions; they exist only so `toSearchBackfillClient`'s destructuring
 * assignment has something to bind to.
 */
function makeFakeTransaction(executeRawResult: number): {
  tx: TransactionClient;
  executeRawStub: ReturnType<typeof vi.fn>;
} {
  const executeRawStub = vi
    .fn()
    .mockResolvedValue(
      executeRawResult
    ) as unknown as TransactionClient["$executeRaw"];
  const tx = {
    $executeRaw: executeRawStub,
    artifact: {},
    project: {},
    comment: {},
    pullRequestDetail: {},
    branchDetail: {},
    agentComponent: {},
  } as unknown as TransactionClient;
  return {
    tx,
    executeRawStub: executeRawStub as unknown as ReturnType<typeof vi.fn>,
  };
}

describe("toSearchBackfillClient — coverage recovery", () => {
  it("returns 0 and never issues a statement for an empty page", async () => {
    const { tx, executeRawStub } = makeFakeTransaction(0);
    const client = toSearchBackfillClient(tx);

    const result = await client.upsertProjectionRows([]);

    expect(result).toBe(0);
    expect(executeRawStub).not.toHaveBeenCalled();
  });

  it("issues one statement and returns its count for a page mixing populated and null optional foreign keys", async () => {
    const { tx, executeRawStub } = makeFakeTransaction(2);
    const client = toSearchBackfillClient(tx);

    const result = await client.upsertProjectionRows([
      fullRow(),
      nullForeignKeyRow(),
    ]);

    expect(result).toBe(2);
    expect(executeRawStub).toHaveBeenCalledTimes(1);

    // Rebuild the tagged-template call into the statement Prisma would send.
    const [strings, ...interpolated] = executeRawStub.mock.calls[0];
    const statement = Prisma.sql(strings, ...interpolated);
    // A null foreign key is a literal NULL in its column slot, never a bound
    // value.
    expect(statement.text.match(VALUES_CLAUSE)?.[1]).toBe(
      [
        `($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::uuid, $8::uuid, ${FRESH_DOCUMENT_STATUS(9)}, $12, $13, $14, $15, $16::uuid, $17::uuid)`,
        `($18::uuid, $19::uuid, $20, $21::uuid, $22, $23, NULL, NULL, ${FRESH_DOCUMENT_STATUS(24)}, $27, $28, $29, $30, NULL, NULL)`,
      ].join(",")
    );
    expect(statement.values).toEqual([
      expect.any(String),
      "org-a",
      SearchEntityType.Document,
      "entity-1",
      "Title",
      "Body",
      "project-1",
      "assignee-1",
      "entity-1",
      "org-a",
      "open",
      "high",
      AT,
      "slug-1",
      "PRD",
      "team-1",
      "anchor-1",
      expect.any(String),
      "org-a",
      SearchEntityType.Document,
      "entity-2",
      "Title",
      "Body",
      "entity-2",
      "org-a",
      "open",
      "high",
      AT,
      "slug-1",
      "PRD",
    ]);
  });

  it("delegates the stale agent-component prune to $executeRaw and returns its count", async () => {
    const { tx, executeRawStub } = makeFakeTransaction(5);
    const client = toSearchBackfillClient(tx);

    const result = await client.removeStaleAgentComponentProjections();

    expect(result).toBe(5);
    expect(executeRawStub).toHaveBeenCalledTimes(1);
  });
});
