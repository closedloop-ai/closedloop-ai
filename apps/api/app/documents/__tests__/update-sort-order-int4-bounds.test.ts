/**
 * ISS-9487 — `sortOrder` on the artifact update boundary.
 *
 * `updateDocumentValidator.sortOrder` is the only thing between a
 * caller-supplied rank and `artifacts.sort_order`, a Prisma `Int` (int4). It
 * was a bare `z.number()`:
 * `1.5` is not a value that column can hold, and `2147483648` / `1e21` reach
 * Prisma as an uncaught 500 at the driver rather than a 400 here.
 *
 * ISS-8880 §3 closed exactly this for the catalog, custom-field enum-option and
 * organization writers (`app/catalog/__tests__/int4-and-target-kind-bounds.test.ts`);
 * this column was the writer it did not cover.
 *
 * The bounds are asserted through the imported constants rather than literals,
 * so a second spelling of either ceiling cannot pass this file.
 */

import {
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
} from "@closedloop-ai/loops-api/column-limits";
import { DocumentStatus } from "@repo/api/src/types/document";
import type { TransactionClient } from "@repo/database";
import { describe, expect, it } from "vitest";
import { computeNextSortOrder } from "@/app/documents/document-sort-order";
import {
  ARTIFACT_SORT_ORDER_MAX,
  updateDocumentValidator,
} from "@/app/documents/validators";

function parseSortOrder(sortOrder: unknown) {
  return updateDocumentValidator.safeParse({ sortOrder });
}

describe("updateDocumentValidator.sortOrder — int4 column bounds (ISS-9487)", () => {
  // Every value the column can actually hold, at both ends.
  const inRange = [POSTGRES_INT4_MIN, -1, 0, 1, ARTIFACT_SORT_ORDER_MAX];

  // The whole impossible set for an int4 column, not just the two everyone
  // writes, plus the top half of the column the append arithmetic needs. The
  // `± 1` rows and `POSTGRES_INT4_MAX` are whole numbers that `.int()` admits,
  // so only `.min()` / `.max()` refuse them. `± 1e21` never reach the bounds:
  // zod 4's `.int()` admits only safe integers and refuses them itself.
  const outOfRange = [
    ARTIFACT_SORT_ORDER_MAX + 1,
    POSTGRES_INT4_MAX,
    POSTGRES_INT4_MAX + 1,
    POSTGRES_INT4_MIN - 1,
    1e21,
    -1e21,
  ];

  // Not integers at all: the column stores whole numbers, so a fraction is a
  // value it cannot represent however small the magnitude.
  const fractional = [1.5, -1.5, 0.1, ARTIFACT_SORT_ORDER_MAX - 0.5];

  it.each(inRange)("accepts %d", (sortOrder) => {
    expect(parseSortOrder(sortOrder).success).toBe(true);
  });

  it.each(outOfRange)("refuses %d, outside the column's range", (sortOrder) => {
    expect(parseSortOrder(sortOrder).success).toBe(false);
  });

  it.each(fractional)("refuses %d, not an integer", (sortOrder) => {
    expect(parseSortOrder(sortOrder).success).toBe(false);
  });

  it("refuses a non-finite magnitude arriving as a JSON literal", () => {
    // `1e400` is legal JSON and `JSON.parse` yields `Infinity`, so this is a
    // value a wire caller can actually present — not a type-forbidden input.
    const parsed = JSON.parse('{"sortOrder":1e400}') as { sortOrder: number };
    expect(parsed.sortOrder).toBe(Number.POSITIVE_INFINITY);
    expect(parseSortOrder(parsed.sortOrder).success).toBe(false);
  });

  it("leaves room for the next append above the highest rank it admits", async () => {
    // #7812 review (marisolashgrove): a ceiling at the column's own max only moves
    // the 22003 to the project's next create, which appends at MAX + gap.
    expect(parseSortOrder(ARTIFACT_SORT_ORDER_MAX).success).toBe(true);
    const tx = {
      artifact: {
        aggregate: () =>
          Promise.resolve({ _max: { sortOrder: ARTIFACT_SORT_ORDER_MAX } }),
      },
    } as unknown as TransactionClient;

    const next = await computeNextSortOrder(tx, "org-1", "project-1");

    expect(next).toBeGreaterThan(ARTIFACT_SORT_ORDER_MAX);
    expect(next).toBeLessThanOrEqual(POSTGRES_INT4_MAX);
  });

  it("still accepts an explicit null, which clears the rank", () => {
    expect(parseSortOrder(null).success).toBe(true);
  });

  it("still accepts a body that omits the key entirely", () => {
    expect(
      updateDocumentValidator.safeParse({ status: DocumentStatus.Draft })
        .success
    ).toBe(true);
  });
});
