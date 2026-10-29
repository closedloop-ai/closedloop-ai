/**
 * ISS-8554 / PLN-1853 Phase 3 (revision 12) — the `user` single-rule SQL sort
 * against a real Postgres.
 *
 * THE LOAD-BEARING ASSERTION, same as the `updated` sibling
 * (`session-list-sql-reader.integration.test.ts`): the new SQL path and the
 * EXISTING in-memory comparator (`buildDisplaySortComparator`) must agree on
 * the SAME fixture — the invariant the production shadow checks on live
 * traffic, pinned here deterministically.
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
import { readSessionListPageByUser } from "./session-list-sql-reader";
import { buildDisplaySortComparator } from "./session-sort-comparators";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

const SESSION_STARTED_AT = new Date("2026-09-01T00:00:00.000Z");
const EMPTY_LIST_QUERY: AgentSessionListQuery = {};

describe.skipIf(!hasDatabase)(
  "ISS-8554 Phase 3: user single-rule SQL sort",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it(
      'orders case-insensitively by "First Last", falls back to email when no name part ' +
        "survives, drops an empty-string name part, sorts the owner-less session last, " +
        "and agrees with the in-memory comparator",
      async () => {
        const organizationId = await organizations.create();

        // TWO PREFIX PAIRS, and they are why this fixture is not four keys that
        // differ on their first letter. "al smith"/"alice young" and
        // "bob zed"/"bobby" each tie until one key runs out, which is exactly
        // where the database's own collation and JS's code-unit `<` disagree:
        // glibc skips the space on its first pass and puts "alice young" before
        // "al smith". Drop the `COLLATE "C"` from the statement and the
        // cross-check below goes red on both pairs (tamsinb on #8675).
        const al = await createTestUser(organizationId, {
          firstName: "Al",
          lastName: "Smith",
        });
        const alice = await createTestUser(organizationId, {
          firstName: "Alice",
          lastName: "Young",
        });
        const bob = await createTestUser(organizationId, {
          firstName: "Bob",
          lastName: "Zed",
        });
        const bobby = await createTestUser(organizationId, {
          firstName: "Bobby",
          lastName: null,
        });
        // An empty-string `firstName` is DROPPED (matches `Boolean("")` filtering
        // out of the JS array), not rendered as a leading space -- so this user's
        // key is "mallory" (the bare last name), not " mallory".
        const emptyFirstName = await createTestUser(organizationId, {
          firstName: "",
          lastName: "Mallory",
        });
        // No name parts at all -- falls back to email.
        const emailOnly = await createTestUser(organizationId, {
          firstName: null,
          lastName: null,
          email: "aaron-no-name@example.com",
        });
        const computeTargetId = await createComputeTarget(
          organizationId,
          bob.id,
          `lane-8554-${randomUUID()}`
        );

        const alSession = await seedSession(
          organizationId,
          computeTargetId,
          al.id
        );
        const aliceSession = await seedSession(
          organizationId,
          computeTargetId,
          alice.id
        );
        const bobSession = await seedSession(
          organizationId,
          computeTargetId,
          bob.id
        );
        const bobbySession = await seedSession(
          organizationId,
          computeTargetId,
          bobby.id
        );
        const emptyFirstNameSession = await seedSession(
          organizationId,
          computeTargetId,
          emptyFirstName.id
        );
        const emailOnlySession = await seedSession(
          organizationId,
          computeTargetId,
          emailOnly.id
        );
        const ownerlessSession = await seedSession(
          organizationId,
          computeTargetId,
          null
        );

        // Code-unit order of the resolved keys: "aaron-no-name@example.com" <
        // "al smith" < "alice young" < "bob zed" < "bobby" < "mallory",
        // owner-less last in BOTH directions (FEA-4330).
        const ascIds = await readPageIds(organizationId, "asc");
        expect(ascIds).toEqual([
          emailOnlySession,
          alSession,
          aliceSession,
          bobSession,
          bobbySession,
          emptyFirstNameSession,
          ownerlessSession,
        ]);

        const descIds = await readPageIds(organizationId, "desc");
        expect(descIds).toEqual([
          emptyFirstNameSession,
          bobbySession,
          bobSession,
          aliceSession,
          alSession,
          emailOnlySession,
          ownerlessSession,
        ]);

        // Cross-check: the EXISTING in-memory comparator, over the SAME rows,
        // must produce the IDENTICAL order.
        //
        // BOTH DIRECTIONS. `desc` goes through the statement's SECOND `CASE`
        // term, and nothing else compares that term against
        // `buildDisplaySortComparator` (tamsinb on #8675).
        const candidates = await withDb((db) =>
          db.sessionDetail.findMany({
            where: { artifact: { is: { organizationId } } },
            select: displaySortCandidateSelect,
          })
        );
        const inMemoryIds = (dir: "asc" | "desc") =>
          [...candidates]
            .sort(buildDisplaySortComparator([{ column: "user", dir }]))
            .map((row) => row.artifactId);
        expect(inMemoryIds("asc")).toEqual(ascIds);
        expect(inMemoryIds("desc")).toEqual(descIds);
      }
    );
  }
);

/** The ordered ids alone — this statement's contract is the ORDER. */
async function readPageIds(
  organizationId: string,
  dir: "asc" | "desc"
): Promise<string[]> {
  const page = await readSessionListPageByUser(
    { organizationId, filters: EMPTY_LIST_QUERY },
    dir,
    0,
    10
  );
  return page.map((row) => row.id);
}

/**
 * Raw Prisma, so no expectation here derives from the code under test. The
 * owner is the assignee, the key both the statement (ISS-12251 AC-006) and the
 * in-memory comparator sort `user` on.
 */
function seedSession(
  organizationId: string,
  computeTargetId: string,
  ownerUserId: string | null
): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: "ISS-8554 Phase 3 fixture",
        status: "active",
        ...(ownerUserId ? { assigneeId: ownerUserId } : {}),
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
    return artifact.id;
  });
}
