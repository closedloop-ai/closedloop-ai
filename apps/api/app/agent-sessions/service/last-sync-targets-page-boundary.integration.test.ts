/**
 * @file last-sync-targets-page-boundary.integration.test.ts
 * @description ISS-10165 — the same exactly-once property as
 * `last-sync-targets-exactly-once.test.ts`, executed by a real Postgres planner
 * rather than a fake one.
 *
 * WHY BOTH. The unit suite proves the property is CAUSED by the terminal key: it
 * hands the shipped `orderBy` to a planner stand-in that resolves ties
 * adversarially, so deleting `{ id: "asc" }` reddens it deterministically. What
 * it cannot prove is that the ordering means the same thing to Postgres —
 * `orderBy` is a value here and a plan there. This suite closes that half: it
 * seeds a population tied on every ranking key, reads two adjacent pages under
 * two DIFFERENT plans (`enable_seqscan` flipped between them, which is the
 * planner freedom a page boundary is exposed to in production when statistics
 * shift mid-walk), and requires the pages to still partition the population.
 *
 * WHAT IT DOES NOT CLAIM. It does not claim to redden on the revert: with the
 * terminal key removed, Postgres MAY return a tied run in the same order under
 * both plans, so a green here is not evidence of a total ordering. The unit
 * suite owns the counterfactual; this one owns "and the database agrees".
 */
import { randomUUID } from "node:crypto";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  buildLastSyncTargetsQuery,
  LAST_SYNC_TARGET_PAGE_SIZE,
} from "./last-sync-targets";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/** Two full pages, so there is a boundary for a target to fall through. */
const CORPUS = LAST_SYNC_TARGET_PAGE_SIZE * 2;

/**
 * ONE tie bucket: every seeded target shares all four ranking values, so the
 * terminal key is the only thing that can decide which page a row lands on.
 */
const TIED_AT = new Date("2026-06-26T00:00:00.000Z");

/**
 * Under one page, so the whole population is readable in a single `findMany`
 * and the assertion is about rank rather than about paging.
 */
const NULL_WATERMARK_CORPUS = 7;

describeIfDb(
  "ISS-10165 — lastSyncTargets page boundary (real Postgres)",
  () => {
    it("delivers each tied target exactly once across two adjacent pages read under different plans", async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const machineSuffix = randomUUID().replaceAll("-", "").slice(0, 8);

      const seededIds = await withDb(async (db) => {
        const ids: string[] = [];
        for (let index = 0; index < CORPUS; index++) {
          const target = await db.computeTarget.create({
            data: {
              organizationId,
              userId: user.id,
              // Descending machine names, so the insertion order and any
              // name-ordered plan disagree with the id order the fix relies on.
              machineName: `tied-${machineSuffix}-${String(CORPUS - index).padStart(3, "0")}`,
              platform: "darwin",
              isOnline: true,
              lastSeenAt: TIED_AT,
              lastAgentSessionSyncAt: TIED_AT,
              lastAgentSessionSyncAttemptAt: TIED_AT,
            },
            select: { id: true },
          });
          ids.push(target.id);
        }
        return ids;
      });

      const query = buildLastSyncTargetsQuery({ organizationId, filters: {} });

      // `SET LOCAL` inside a transaction, never a bare `SET` through `withDb`.
      // `withDb` is NOT transactional — it hands back the pooled client — so a
      // bare `SET` applies to whichever connection served that one statement, the
      // `findMany` after it may be served by another, and the plan flip this
      // suite is built on would be silently inert. It would also outlive the test
      // on a pooled connection and degrade every later suite in this
      // single-process (`--no-file-parallelism`) run. The setting is read BACK for
      // the same reason `token-queries.integration.test.ts` does: a GUC that did
      // not take would hand back a green suite that no longer isolates anything.
      const readPage = async (skip: number, sequentialScans: boolean) =>
        await withDb.tx(async (db) => {
          const setting = sequentialScans ? "on" : "off";
          await db.$executeRawUnsafe(`SET LOCAL enable_seqscan = ${setting}`);
          const [applied] = await db.$queryRaw<{ seqscan: string }[]>(
            Prisma.sql`SELECT current_setting('enable_seqscan') AS seqscan`
          );
          if (applied?.seqscan !== setting) {
            throw new Error(
              `planner isolation did not take effect (enable_seqscan=${applied?.seqscan}, wanted ${setting}) — both pages would be read under the same plan and this suite would report a guarantee it is no longer testing`
            );
          }
          return await db.computeTarget.findMany({ ...query, skip });
        });

      try {
        const firstPage = await readPage(0, true);
        const secondPage = await readPage(LAST_SYNC_TARGET_PAGE_SIZE, false);

        const servedIds = [...firstPage, ...secondPage].map((row) => row.id);
        // Sorted-multiset equality against the seeded population: a count or a Set
        // size passes when one target is skipped and another is served twice.
        expect([...servedIds].sort()).toEqual([...new Set(servedIds)].sort());
        expect([...servedIds].sort()).toEqual([...seededIds].sort());
      } finally {
        // No GUC reset needed: each `SET LOCAL` died with its own transaction.
        await withDb(async (db) => {
          await db.computeTarget.deleteMany({ where: { organizationId } });
          await db.user.deleteMany({ where: { organizationId } });
          await db.organization.deleteMany({ where: { id: organizationId } });
        });
      }
    });
  }
);

/**
 * ISS-10851 — null watermark placement, decided by the database.
 *
 * Postgres, not this code, chooses where a NULL lands in an ORDER BY, and the
 * two spellings disagree: a bare DESC is NULLS FIRST, the `nulls: "last"` this
 * query now pins is the opposite. A fake planner can only model that agreement;
 * this case observes it, on the fleet shape the defect was found on — most
 * targets never synced, one just did.
 */
describeIfDb(
  "ISS-10851 — never-synced targets sort last (real Postgres)",
  () => {
    it("ranks the one target with a real watermark ahead of the never-synced majority", async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const machineSuffix = randomUUID().replaceAll("-", "").slice(0, 8);

      const syncedId = await withDb(async (db) => {
        let stampedId = "";
        for (let index = 0; index < NULL_WATERMARK_CORPUS; index++) {
          // Only the LAST target carries watermarks. Its machine name sorts last
          // and it is inserted last, so neither insertion order nor a
          // name-ordered plan can put it on top by accident.
          const hasWatermark = index === NULL_WATERMARK_CORPUS - 1;
          const target = await db.computeTarget.create({
            data: {
              organizationId,
              userId: user.id,
              machineName: `nullws-${machineSuffix}-${String(index).padStart(3, "0")}`,
              platform: "darwin",
              isOnline: true,
              lastSeenAt: TIED_AT,
              lastAgentSessionSyncAt: hasWatermark ? TIED_AT : null,
              lastAgentSessionSyncAttemptAt: hasWatermark ? TIED_AT : null,
            },
            select: { id: true },
          });
          if (hasWatermark) {
            stampedId = target.id;
          }
        }
        return stampedId;
      });

      try {
        const query = buildLastSyncTargetsQuery({
          organizationId,
          filters: {},
        });
        const page = await withDb((db) => db.computeTarget.findMany(query));

        expect(page).toHaveLength(NULL_WATERMARK_CORPUS);
        // Not `toContain`: the card's whole job is telling an operator which
        // machine is fresh, so the stamped one being PRESENT is not the contract
        // — it being first is.
        expect(page[0]?.id).toBe(syncedId);
        expect(
          page
            .slice(1)
            .every((row) => row.lastAgentSessionSyncAttemptAt === null)
        ).toBe(true);
      } finally {
        await withDb(async (db) => {
          await db.computeTarget.deleteMany({ where: { organizationId } });
          await db.user.deleteMany({ where: { organizationId } });
          await db.organization.deleteMany({ where: { id: organizationId } });
        });
      }
    });
  }
);
