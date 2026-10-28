import {
  CustomFieldQueryRejection,
  CustomFieldSortDirection,
} from "@repo/api/src/types/custom-field-list-query";
import { Result as ResultHelpers } from "@repo/api/src/types/result";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestOrganization } from "@/__tests__/utils/db-helpers";

/**
 * That the custom-field facets resolve INSIDE the list read's snapshot
 * (ISS-7211 review, whitlockk).
 *
 * The route used to resolve them first and only then open the `RepeatableRead`
 * transaction. Page and total agreed with each other — they shared the
 * transaction — but both were computed from ids read at an EARLIER instant,
 * while the custom-field values hydrated onto the returned rows came from the
 * later one. A value edited in that window produced a row that visibly
 * contradicted the filter that selected it.
 *
 * **How this is proved without racing a concurrent writer:** `withDb.tx` fails
 * closed when asked for an `isolationLevel` while a transaction is already
 * active — Postgres fixes isolation at BEGIN, so it cannot honor the request by
 * joining. That refusal is therefore a reliable, deterministic detector of "am I
 * inside a transaction right now", with no timing involved. Asserting it from
 * inside the facet-resolution call is what pins the ordering.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const resolveCustomFieldQueryContext = vi.fn();

vi.mock("./custom-field-route-helpers", () => ({
  resolveCustomFieldQueryContext: (...args: unknown[]) =>
    resolveCustomFieldQueryContext(...args),
}));

/**
 * Whether a transaction is ambient at this point in the call stack.
 *
 * Uses the fail-closed guard in `withDb.tx` rather than any test-only hook, so
 * the detector is a real production invariant and cannot drift from one.
 */
async function isInsideTransaction(): Promise<boolean> {
  try {
    await withDb.tx(async () => undefined, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ambient transaction")) {
      throw error;
    }
    return true;
  }
}

describeIfDb("document list snapshot (ISS-7211 review)", () => {
  let organizationId: string;

  beforeAll(async () => {
    organizationId = await createTestOrganization();
  });

  afterAll(async () => {
    if (organizationId) {
      await withDb(async (db) => {
        await db.artifact.deleteMany({ where: { organizationId } });
        await db.organization.delete({ where: { id: organizationId } });
      });
    }
  });

  it("resolves the custom-field facets inside the read's transaction", async () => {
    let ambientDuringResolution: boolean | undefined;
    let ambientDuringRead: boolean | undefined;
    resolveCustomFieldQueryContext.mockImplementation(async () => {
      ambientDuringResolution = await isInsideTransaction();
      return ResultHelpers.ok({});
    });

    const { readDocumentListInSnapshot } = await import(
      "./document-list-snapshot"
    );
    const result = await readDocumentListInSnapshot(
      { organizationId },
      {
        customFieldSortId: "11111111-1111-4111-8111-111111111111",
        customFieldSortDir: CustomFieldSortDirection.Asc,
      },
      async () => {
        ambientDuringRead = await isInsideTransaction();
        return [];
      }
    );

    expect(result.ok).toBe(true);
    // Against the pre-review wiring this is `false`: resolution ran in the route
    // before any transaction existed, so the ids it produced were older than the
    // values the page hydrated.
    expect(ambientDuringResolution).toBe(true);
    // And the page read shares that same transaction, so the two cannot be
    // reading different snapshots.
    expect(ambientDuringRead).toBe(true);
  });

  it("propagates a facet refusal out of the transaction as a Result", async () => {
    // The refusal must travel as a value, not by throwing: a throw inside an
    // interactive transaction is a rollback path, and this is an ordinary 400.
    resolveCustomFieldQueryContext.mockImplementation(() =>
      Promise.resolve(
        ResultHelpers.err(CustomFieldQueryRejection.FilterTooBroad)
      )
    );

    const { readDocumentListInSnapshot } = await import(
      "./document-list-snapshot"
    );
    let readRan = false;
    const result = await readDocumentListInSnapshot(
      { organizationId },
      { customFieldSortId: "11111111-1111-4111-8111-111111111111" },
      () => {
        readRan = true;
        return Promise.resolve([]);
      }
    );

    expect(result.ok).toBe(false);
    // The page read must not run at all once the facets are refused.
    expect(readRan).toBe(false);
  });
});
