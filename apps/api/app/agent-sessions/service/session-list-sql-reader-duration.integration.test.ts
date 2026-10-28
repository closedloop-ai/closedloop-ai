/**
 * ISS-8554 / PLN-1853 Phase 3 (revision 12) — the `duration` single-rule SQL
 * sort against a real Postgres.
 *
 * THE LOAD-BEARING ASSERTION, same as the `updated`/`user` siblings: the new
 * SQL path and the EXISTING in-memory comparator (`buildDisplaySortComparator`)
 * must agree on the SAME fixture — the invariant the production shadow checks
 * on live traffic, pinned here deterministically.
 *
 * Two arms of the fold are seeded directly because nothing else here reaches
 * them. An `active`-stored row carrying a recorded end and no later activity
 * must measure to `now()`, not to that end (`endedButStillRuns` below).
 *
 * And the statement's FAIL-OPEN arm — a stored status the fold does not
 * recognize reads as `active`, the same answer `normalizeSessionStatus` gives
 * it (marisolashgrove on #8691). Nothing else here seeds an unrecognized status,
 * so without that row `ELSE 'active'` could become `ELSE a.status` and the two
 * paths would measure such a session to different instants with the suite
 * still green.
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
import { settleOnAMinuteAnchor } from "@/__tests__/utils/session-list-sort-clock-fixture";
import type { AgentSessionListQuery } from "../validators";
import { displaySortCandidateSelect } from "./session-display-sort";
import { readSessionListPageByDuration } from "./session-list-sql-reader";
import { buildDisplaySortComparator } from "./session-sort-comparators";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

// Far enough in the past that the RESUMED (still-running) row's duration —
// measured against the real `now()` at read time — dwarfs every terminal
// row's fixed millisecond-scale span by years, so the ordering assertions
// below are stable regardless of the few milliseconds between the SQL
// statement's own clock reading and this test's. No assertion pins the
// running row's EXACT duration value (gated by `no-timing-assertions`
// anyway) — only its ORDER relative to the terminal rows, which this margin
// makes deterministic.
const FAR_PAST = new Date("2020-01-01T00:00:00.000Z");
const EMPTY_LIST_QUERY: AgentSessionListQuery = {};

describe.skipIf(!hasDatabase)(
  "ISS-8554 Phase 3: duration single-rule SQL sort",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it(
      "orders by the displayed duration span, keeps an active-but-ended row " +
        "running, leaves a genuinely resumed row running, measures an " +
        "unrecognized stored status against the running clock, treats a " +
        "zero-length span as unmeasurable, breaks ties on artifact_id desc, " +
        "and agrees with the in-memory comparator",
      async () => {
        const organizationId = await organizations.create();
        const user = await createTestUser(organizationId);
        const computeTargetId = await createComputeTarget(
          organizationId,
          user.id,
          `lane-8554-${randomUUID()}`
        );

        // Terminal, 50s.
        const shortError = await seedSession(organizationId, computeTargetId, {
          status: "error",
          sessionEndedAt: new Date(FAR_PAST.getTime() + 50_000),
        });
        // Stored `active`, with a recorded end and NO later activity: it
        // measures to `now()`, not to its 30s end. Started 10s after
        // `resumedRunning` below so the two running spans do not tie.
        const endedButStillRuns = await seedSession(
          organizationId,
          computeTargetId,
          {
            status: "active",
            sessionStartedAt: new Date(FAR_PAST.getTime() + 10_000),
            sessionEndedAt: new Date(FAR_PAST.getTime() + 30_000),
            lastActivityAt: new Date(FAR_PAST.getTime() + 10_000),
          }
        );
        // Tied at 75s — the tiebreaker case.
        const tiedA = await seedSession(organizationId, computeTargetId, {
          status: "inactive",
          sessionEndedAt: new Date(FAR_PAST.getTime() + 75_000),
        });
        const tiedB = await seedSession(organizationId, computeTargetId, {
          status: "inactive",
          sessionEndedAt: new Date(FAR_PAST.getTime() + 75_000),
        });
        // Terminal, 100s — the longest FIXED span.
        const longInactive = await seedSession(
          organizationId,
          computeTargetId,
          {
            status: "inactive",
            sessionEndedAt: new Date(FAR_PAST.getTime() + 100_000),
          }
        );
        // Stored `active`, ended, but activity AFTER the recorded end — a
        // genuine resume, same as `endedButStillRuns` above now that nothing
        // reconciles either shape. Still reads as running, so its span is
        // measured against `now()` and dwarfs every fixed span above.
        const resumedRunning = await seedSession(
          organizationId,
          computeTargetId,
          {
            status: "active",
            sessionEndedAt: new Date(FAR_PAST.getTime() + 5000),
            lastActivityAt: new Date(FAR_PAST.getTime() + 999_999_000),
          }
        );
        // ISS-5592 retired `completed`, so the statement's fold does not
        // recognize it and `normalizeSessionStatus` fails it OPEN to `active`.
        // The recorded end is therefore NOT what this row is measured to; it
        // reads as running like the other two `active`-folding rows above.
        // Started 20s after `resumedRunning`, which is the whole margin
        // separating their two clock-measured spans.
        const unrecognizedFailOpen = await seedSession(
          organizationId,
          computeTargetId,
          {
            status: "completed",
            sessionStartedAt: new Date(FAR_PAST.getTime() + 20_000),
            sessionEndedAt: new Date(FAR_PAST.getTime() + 40_000),
            lastActivityAt: new Date(FAR_PAST.getTime() + 999_999_000),
          }
        );
        // Zero-length span — unmeasurable, sorts last in BOTH directions
        // (FEA-4330), same as a session with no end at all.
        const zeroSpan = await seedSession(organizationId, computeTargetId, {
          status: "inactive",
          sessionEndedAt: FAR_PAST,
        });

        const [expectedFirstTied, expectedSecondTied] = [tiedA, tiedB].sort(
          (a, b) => (a < b ? 1 : -1)
        );

        const ascIds = await readPageIds(organizationId, "asc");
        expect(ascIds).toEqual([
          shortError,
          expectedFirstTied,
          expectedSecondTied,
          longInactive,
          unrecognizedFailOpen,
          endedButStillRuns,
          resumedRunning,
          zeroSpan,
        ]);

        const descIds = await readPageIds(organizationId, "desc");
        expect(descIds).toEqual([
          resumedRunning,
          endedButStillRuns,
          unrecognizedFailOpen,
          longInactive,
          expectedFirstTied,
          expectedSecondTied,
          shortError,
          zeroSpan,
        ]);

        // Cross-check: the EXISTING in-memory comparator, over the SAME rows,
        // must produce the IDENTICAL order.
        //
        // BOTH DIRECTIONS. `desc` is where the statement's sign flip and its
        // `NULLS LAST` pull against each other, and nothing else compares that
        // combination against `buildDisplaySortComparator` (tamsinb on #8691).
        const inMemoryIds = await inMemoryDurationIds(organizationId);
        expect(inMemoryIds("asc")).toEqual(ascIds);
        expect(inMemoryIds("desc")).toEqual(descIds);
      }
    );

    it(
      "floors the running-row clock to the minute, so a row started on the " +
        "current minute has no measurable span yet and sorts with the blanks " +
        "in both directions",
      async () => {
        const organizationId = await organizations.create();
        const user = await createTestUser(organizationId);
        const computeTargetId = await createComputeTarget(
          organizationId,
          user.id,
          `lane-8554-${randomUUID()}`
        );

        const anchorMs = await settleOnAMinuteAnchor();

        // Running (stored `active`, no recorded end) and started EXACTLY on
        // the minute the statement's floored clock reads. Floored, its end
        // equals its start and the span is 0 — unmeasurable, nulls-last in
        // both directions. Against a bare `now()` it would instead be the
        // LONGEST span here, which the `desc` assertion below is what
        // detects.
        const startedOnTheMinute = await seedSession(
          organizationId,
          computeTargetId,
          {
            lastActivityAt: new Date(anchorMs),
            sessionEndedAt: null,
            sessionStartedAt: new Date(anchorMs),
            status: "active",
          }
        );
        const oneSecond = await seedSession(organizationId, computeTargetId, {
          sessionEndedAt: new Date(anchorMs + 1000),
          sessionStartedAt: new Date(anchorMs),
          status: "inactive",
        });

        const ascIds = await readPageIds(organizationId, "asc");
        expect(ascIds).toEqual([oneSecond, startedOnTheMinute]);

        const descIds = await readPageIds(organizationId, "desc");
        expect(descIds).toEqual([oneSecond, startedOnTheMinute]);

        const inMemoryIds = await inMemoryDurationIds(organizationId);
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
  const page = await readSessionListPageByDuration(
    { organizationId, filters: EMPTY_LIST_QUERY },
    dir,
    0,
    10
  );
  return page.map((row) => row.id);
}

/**
 * The in-memory comparator's order over the org's rows, as a per-direction
 * reader so one candidate read serves both directions' assertions.
 */
async function inMemoryDurationIds(
  organizationId: string
): Promise<(dir: "asc" | "desc") => string[]> {
  const candidates = await withDb((db) =>
    db.sessionDetail.findMany({
      where: { artifact: { is: { organizationId } } },
      select: displaySortCandidateSelect,
    })
  );
  return (dir) =>
    [...candidates]
      .sort(buildDisplaySortComparator([{ column: "duration", dir }]))
      .map((row) => row.artifactId);
}

/** Raw Prisma, so no expectation here derives from the code under test. */
function seedSession(
  organizationId: string,
  computeTargetId: string,
  overrides: {
    status: string;
    sessionEndedAt: Date | null;
    sessionStartedAt?: Date;
    lastActivityAt?: Date;
    endsWithError?: boolean;
  }
): Promise<string> {
  const startedAt = overrides.sessionStartedAt ?? FAR_PAST;
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: "ISS-8554 Phase 3 fixture",
        status: overrides.status,
        session: {
          create: {
            computeTargetId,
            externalSessionId: `iss-8554-${randomUUID()}`,
            sessionStartedAt: startedAt,
            sessionUpdatedAt: startedAt,
            lastActivityAt:
              overrides.lastActivityAt ?? overrides.sessionEndedAt ?? startedAt,
            sessionEndedAt: overrides.sessionEndedAt,
            endsWithError: overrides.endsWithError ?? false,
          },
        },
      },
      select: { id: true },
    });
    return artifact.id;
  });
}
