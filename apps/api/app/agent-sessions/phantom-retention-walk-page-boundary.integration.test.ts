/**
 * @file phantom-retention-walk-page-boundary.integration.test.ts
 * @description ISS-10171 — the phantom sweep's candidate walk hands each aged
 * idle session to exactly one page, against a real Postgres, with the whole
 * corpus tied on the leading ordering column.
 *
 * WHY THIS SITE NEEDS A TERMINAL KEY. `purgePhantomSessionsBatch` restarts the
 * predicate on every call, so there is no cursor to stabilize — what the
 * ordering buys is that a `take`-bounded page has a DEFINED answer. Ordering by
 * `lastActivityAt` alone is not total: the corpus below shares one activity
 * instant, so without the `artifactId` terminal key the planner decides which
 * tied rows a page holds, and two batches need not agree. `artifactId` is
 * `SessionDetail`'s `@id`, which makes the ordering total.
 *
 * WHAT IS PINNED, EXACTLY. Two things, and no more:
 *   1. each page's membership is the ordered slice the terminal key names —
 *      this is the assertion the terminal key is causal for; dropping
 *      `{ artifactId: "asc" }` from the production `orderBy` reds it; and
 *   2. the ids the walk actually deleted, as a SORTED MULTISET, equal the
 *      seeded corpus — no row served twice, none skipped. A count or a Set
 *      size passes when one row is duplicated and another lost, so neither is
 *      used here.
 *
 * Assertion 2 is a correctness floor, not a mutation kill: this walk deletes
 * what it serves, so the population shrinks and the multiset can hold even
 * under an undefined page order. It is pinned because it is the property that
 * actually matters, not because the terminal key is the only thing protecting
 * it.
 *
 * The corpus ids are server-generated UUIDs, so their sort order is independent
 * of the order the fixture inserted them.
 */
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { purgePhantomSessionsBatch } from "./phantom-retention-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/** Every row shares this instant, so the leading ordering key ties throughout. */
const TIED_LAST_ACTIVITY = new Date("2026-06-01T00:00:00.000Z");
const CUTOFF = new Date("2026-06-02T00:00:00.000Z");
/** Not a multiple of the page size, so the walk ends on a short final page. */
const CORPUS_SIZE = 7;
const PAGE_SIZE = 3;
/** A walk that cannot terminate must fail loudly rather than run to a timeout. */
const MAX_PAGES = 10;

describeIfDb("phantom candidate walk page boundary", () => {
  it("serves each tied candidate to exactly one page, in terminal-key order", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const seeded: string[] = [];
      for (let index = 0; index < CORPUS_SIZE; index++) {
        const artifactId = await createTestSessionDetail({
          organizationId,
          userId: user.id,
          label: `tied-phantom-${index}`,
          sessionTimestamp: TIED_LAST_ACTIVITY,
          lastActivityAt: TIED_LAST_ACTIVITY,
        });
        seeded.push(artifactId);
      }
      const expectedOrder = [...seeded].sort();

      const pages: string[][] = [];
      const served: string[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await withDb((db) =>
          purgePhantomSessionsBatch(db, CUTOFF, organizationId, PAGE_SIZE)
        );
        expect(batch.deletedSessionIdsComplete).toBe(true);
        pages.push([...batch.deletedSessionIds]);
        served.push(...batch.deletedSessionIds);
        if (batch.candidateCount < PAGE_SIZE) {
          break;
        }
      }

      expect(pages).toEqual([
        expectedOrder.slice(0, PAGE_SIZE),
        expectedOrder.slice(PAGE_SIZE, PAGE_SIZE * 2),
        expectedOrder.slice(PAGE_SIZE * 2),
      ]);
      expect([...served].sort()).toEqual(expectedOrder);
    });
  });
});
