/**
 * ISS-8554 / PLN-1853 Phase 3 (revision 12) — the `updated` single-rule SQL
 * sort against a real Postgres.
 *
 * THE LOAD-BEARING ASSERTION is the cross-check against the EXISTING in-memory
 * comparator (`buildDisplaySortComparator`): both paths must agree on the
 * SAME fixture. That agreement is exactly what the production shadow
 * (`session-list-sort-shadow.ts`) checks on every live request; this pins it
 * once, deterministically, rather than only hoping the shadow catches a
 * divergence in traffic.
 */
import { randomUUID } from "node:crypto";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import type { AgentSessionListQuery } from "../validators";
import { displaySortCandidateSelect } from "./session-display-sort";
import { readSessionListPageByUpdated } from "./session-list-sql-reader";
import { buildDisplaySortComparator } from "./session-sort-comparators";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

const SESSION_STARTED_AT = new Date("2026-09-01T00:00:00.000Z");

describe.skipIf(!hasDatabase)(
  "ISS-8554 Phase 3: updated single-rule SQL sort",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it("orders by GREATEST(session_detail.updated_at, artifacts.updated_at), ties broken by artifact_id desc, and agrees with the in-memory comparator", async () => {
      const organizationId = await organizations.create();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id,
        `lane-8554-${randomUUID()}`
      );

      // Three distinct `updated` instants, plus a FOURTH tied with the third —
      // the tiebreaker case. `seedSession` below stamps BOTH `@updatedAt`
      // columns with raw SQL after creation, bypassing Prisma's auto-stamp.
      const earliest = await seedSession(
        organizationId,
        computeTargetId,
        new Date("2026-09-10T00:00:00.000Z")
      );
      const middle = await seedSession(
        organizationId,
        computeTargetId,
        new Date("2026-09-15T00:00:00.000Z")
      );
      const tiedA = await seedSession(
        organizationId,
        computeTargetId,
        new Date("2026-09-20T00:00:00.000Z")
      );
      const tiedB = await seedSession(
        organizationId,
        computeTargetId,
        new Date("2026-09-20T00:00:00.000Z")
      );
      // `artifact_id DESC` is the tiebreaker (FEA-4329): the two tied rows must
      // come back in that order regardless of insertion order.
      const [expectedFirstTied, expectedSecondTied] = [tiedA, tiedB].sort(
        (a, b) => (a < b ? 1 : -1)
      );

      const ascIds = await readPageIds(organizationId, "asc");
      expect(ascIds).toEqual([
        earliest,
        middle,
        expectedFirstTied,
        expectedSecondTied,
      ]);

      const descIds = await readPageIds(organizationId, "desc");
      expect(descIds).toEqual([
        expectedFirstTied,
        expectedSecondTied,
        middle,
        earliest,
      ]);

      // Cross-check: the EXISTING in-memory comparator, over the SAME rows,
      // must produce the IDENTICAL order — the invariant the production
      // shadow exists to prove on live traffic.
      //
      // BOTH DIRECTIONS. `desc` is the list's default and the only path through
      // the statement's `CASE -1.0` key negation, so an `asc`-only cross-check
      // is vacuous exactly where production spends its time (tamsinb on
      // #8670).
      const candidates = await withDb((db) =>
        db.sessionDetail.findMany({
          where: { artifact: { is: { organizationId } } },
          select: displaySortCandidateSelect,
        })
      );
      const inMemoryIds = (dir: "asc" | "desc") =>
        [...candidates]
          .sort(buildDisplaySortComparator([{ column: "updated", dir }]))
          .map((row) => row.artifactId);
      expect(inMemoryIds("asc")).toEqual(ascIds);
      expect(inMemoryIds("desc")).toEqual(descIds);
    });

    it("scopes to the organization — a session in a different org never appears", async () => {
      const organizationId = await organizations.create();
      const otherOrganizationId = await organizations.create();
      const user = await createTestUser(organizationId);
      const otherUser = await createTestUser(otherOrganizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id,
        `lane-8554-${randomUUID()}`
      );
      const otherComputeTargetId = await createComputeTarget(
        otherOrganizationId,
        otherUser.id,
        `lane-8554-other-${randomUUID()}`
      );

      const own = await seedSession(
        organizationId,
        computeTargetId,
        new Date("2026-09-10T00:00:00.000Z")
      );
      await seedSession(
        otherOrganizationId,
        otherComputeTargetId,
        new Date("2026-09-10T00:00:00.000Z")
      );

      const ids = await readPageIds(organizationId, "asc");
      expect(ids).toEqual([own]);
    });

    it("returns each row's `updated` sort key, read in the ordering's own snapshot", async () => {
      const organizationId = await organizations.create();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id,
        `lane-8554-keys-${randomUUID()}`
      );
      const updatedAt = new Date("2026-09-18T00:00:00.000Z");
      const artifactId = await seedSession(
        organizationId,
        computeTargetId,
        updatedAt
      );

      // The KEY half of the reader's contract: the shadow's verdict can only
      // separate a moving key from a real ordering divergence if these come
      // back populated (`session-list-sort-differ.ts`). Dropping the key read
      // leaves every row `null` and fails here.
      const page = await readSessionListPageByUpdated(
        { organizationId, filters: EMPTY_LIST_QUERY },
        "desc",
        0,
        10
      );
      expect(page).toEqual([
        { id: artifactId, recordUpdatedAtMs: updatedAt.getTime() },
      ]);
    });
  }
);

const EMPTY_LIST_QUERY: AgentSessionListQuery = {};

/** The ordered ids alone, for the cases asserting ORDER rather than keys. */
async function readPageIds(
  organizationId: string,
  dir: "asc" | "desc"
): Promise<string[]> {
  const page = await readSessionListPageByUpdated(
    { organizationId, filters: EMPTY_LIST_QUERY },
    dir,
    0,
    10
  );
  return page.map((row) => row.id);
}

/** Raw Prisma + raw SQL, so no expectation here derives from the code under test. */
function seedSession(
  organizationId: string,
  computeTargetId: string,
  updatedAt: Date
): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: "ISS-8554 Phase 3 fixture",
        status: "active",
        session: {
          create: {
            computeTargetId,
            externalSessionId: `iss-8554-${randomUUID()}`,
            sessionStartedAt: SESSION_STARTED_AT,
            sessionUpdatedAt: SESSION_STARTED_AT,
            lastActivityAt: SESSION_STARTED_AT,
          },
        },
      },
      select: { id: true },
    });
    // `@updatedAt` stamps `now()` on every write, so a raw UPDATE after
    // creation is the only way to pin a deterministic `updated` instant on
    // both columns the row's displayed value is the MAX of.
    await db.$executeRaw`UPDATE session_detail SET updated_at = ${updatedAt} WHERE artifact_id = ${artifact.id}::uuid`;
    await db.$executeRaw`UPDATE artifacts SET updated_at = ${updatedAt} WHERE id = ${artifact.id}::uuid`;
    return artifact.id;
  });
}
