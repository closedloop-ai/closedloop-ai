/**
 * ISS-8554 / PLN-1853 Phase 3 (revision 13, D15 amended) — the up-to-four-rule
 * COMPOUND sort against a real Postgres.
 *
 * THE LOAD-BEARING ASSERTION, same as the three single-rule siblings: the new
 * SQL path and the EXISTING in-memory comparator (`buildDisplaySortComparator`)
 * must agree on the SAME multi-rule request — the invariant the production
 * shadow checks on live traffic.
 *
 * EVERY CHAIN HERE CARRIES A DISPLAY COLUMN, because that is the only arm this
 * statement is the candidate for (`resolveSqlNativeCompoundSortRequest`). An
 * all-DB-native chain like `[cost asc, repo desc]` is served by Prisma
 * `orderBy` under the database's own collation, so cross-checking it against
 * `buildDisplaySortComparator` would compare the statement against an arm
 * production never uses for it (tamsinb on #8732).
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
import type {
  AgentSessionListQuery,
  AgentSessionSortRule,
} from "../validators";
import { displaySortCandidateSelect } from "./session-display-sort";
import { readSessionListPageByCompoundSort } from "./session-list-sql-reader";
import { buildDisplaySortComparator } from "./session-sort-comparators";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

const FAR_PAST = new Date("2020-01-01T00:00:00.000Z");
const EMPTY_LIST_QUERY: AgentSessionListQuery = {};

/** A name part of ONLY a NBSP — stripped by `btrim`'s set, not by `trim()`. */
const NBSP_ONLY_NAME = " ";
/** A trailing TAB — likewise inside ECMAScript's trim set and outside `trim()`'s. */
const TAB_SUFFIXED_SURNAME = "Smith\t";

type Fixture = {
  costTieBeta: string;
  costTieAlpha: string;
  costLow: string;
  statusError: string;
  statusInactiveLong: string;
  statusActiveEnded: string;
};

describe.skipIf(!hasDatabase)(
  "ISS-8554 Phase 3: compound (2-to-4-rule) SQL sort",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it(
      "a numeric/text/numeric chain (cost asc, repo desc, updated desc) " +
        "ranks the mixed-case repo names on CODE UNITS, as the live " +
        "comparator does, and matches it",
      async () => {
        const { organizationId, fixture } = await seedFixture();

        const rules: AgentSessionSortRule[] = [
          { column: "cost", dir: "asc" },
          { column: "repo", dir: "desc" },
          { column: "updated", dir: "desc" },
        ];
        const ascIds = await readPageIds(organizationId, rules);
        // The three cost-1 rows are separated by `repo` alone, and their names
        // are ordered by CASE: descending code units give `acme/r`, `Zulu/z`,
        // `Mid-tier/m`. Under the database's own collation the same three read
        // `Zulu/z`, `Mid-tier/m`, `acme/r` — which is what makes this case a
        // real check on the collation rather than on the slot wiring.
        //
        // The two cost-10 rows share a repo, so the THIRD slot decides them:
        // without it they would fall through to the `artifact_id` tiebreaker
        // and the rule would be proving nothing.
        expect(ascIds).toEqual([
          fixture.statusInactiveLong,
          fixture.statusActiveEnded,
          fixture.statusError,
          fixture.costLow,
          fixture.costTieAlpha,
          fixture.costTieBeta,
        ]);

        const inMemoryAscIds = await inMemoryAscOrder(organizationId, rules);
        expect(inMemoryAscIds).toEqual(ascIds);
      }
    );

    it("a text-primary/numeric-secondary chain (status asc, duration desc) sorts on the raw status and matches the in-memory comparator", async () => {
      const { organizationId, fixture } = await seedFixture();

      const rules: AgentSessionSortRule[] = [
        { column: "status", dir: "asc" },
        { column: "duration", dir: "desc" },
      ];
      const ascIds = await readPageIds(organizationId, rules);
      // ISS-9939 / ISS-10262: the `status` SORT key is the raw persisted
      // `artifacts.status` — `statusActiveEnded` stores literal `active`,
      // which sorts BEFORE `error`/`inactive` here and is alone in its status
      // group, so its own `duration` value never enters this ordering.
      expect(ascIds).toEqual([
        fixture.statusActiveEnded,
        fixture.statusError,
        fixture.costTieBeta,
        fixture.costTieAlpha,
        fixture.costLow,
        fixture.statusInactiveLong,
      ]);

      const inMemoryAscIds = await inMemoryAscOrder(organizationId, rules);
      expect(inMemoryAscIds).toEqual(ascIds);
    });

    it("the four-rule boundary (priority, harness, updated, repo) matches the in-memory comparator", async () => {
      const { organizationId } = await seedFixture();

      const rules: AgentSessionSortRule[] = [
        { column: "priority", dir: "asc" },
        { column: "harness", dir: "asc" },
        { column: "updated", dir: "desc" },
        { column: "repo", dir: "asc" },
      ];
      const ascIds = await readPageIds(organizationId, rules);

      const inMemoryAscIds = await inMemoryAscOrder(organizationId, rules);
      expect(inMemoryAscIds).toEqual(ascIds);
    });

    it(
      "a (user asc, repo asc) chain derives the owner key the way " +
        "compareOwnerDisplayNameKeys does — prefix-sharing names on code " +
        "units, and the ECMAScript whitespace set trimmed off both ends",
      async () => {
        const { organizationId, owners } = await seedOwnerFixture();

        const rules: AgentSessionSortRule[] = [
          { column: "user", dir: "asc" },
          { column: "repo", dir: "asc" },
        ];
        const ascIds = await readPageIds(organizationId, rules);
        // `'al smith' < 'alice young'` on code units (the space at index 2
        // precedes `i`); the database's own collation skips that space and
        // inverts the pair. The two `'bob smith'` rows TIE — one of them keys
        // through a TAB-suffixed surname — so `repo` decides them. And the
        // NBSP-only row keys its `aa-` EMAIL, which sorts FIRST; left in the
        // key the raw NBSP collates after every ASCII name instead, because
        // `COLLATE "C"` compares UTF-8 BYTES and U+00A0 encodes as 0xC2 0xA0.
        expect(ascIds).toEqual([
          owners.nbspOnlyName,
          owners.alSmith,
          owners.aliceYoung,
          owners.bobTabSurname,
          owners.bobPlain,
        ]);

        const inMemoryAscIds = await inMemoryAscOrder(organizationId, rules);
        expect(inMemoryAscIds).toEqual(ascIds);
      }
    );

    it(
      "a (duration desc, repo asc) chain floors the running-row clock to the " +
        "minute, so a row started on the current minute keys blank and " +
        "collects last in both directions",
      async () => {
        const organizationId = await organizations.create();
        const user = await createTestUser(organizationId);
        const computeTargetId = await createComputeTarget(
          organizationId,
          user.id,
          `lane-8554-${randomUUID()}`
        );
        const anchorMs = await settleOnAMinuteAnchor();

        // Running — stored `active` with no recorded end — and started
        // EXACTLY on the minute the statement's floored clock reads. Floored,
        // its end equals its start and the span is 0: unmeasurable,
        // nulls-last in both directions. Against a bare `now()` it would be
        // the LONGEST span here, which the `desc` assertion is what detects.
        const startedOnTheMinute = await seedSession(
          organizationId,
          computeTargetId,
          {
            cost: 1,
            harness: "claude",
            lastActivityAt: new Date(anchorMs),
            priority: null,
            repo: "A-running",
            sessionEndedAt: null,
            sessionStartedAt: new Date(anchorMs),
            status: "active",
            updatedAt: new Date(anchorMs),
          }
        );
        const oneSecond = await seedSession(organizationId, computeTargetId, {
          cost: 1,
          harness: "claude",
          priority: null,
          repo: "B-terminal",
          sessionEndedAt: new Date(anchorMs + 1000),
          sessionStartedAt: new Date(anchorMs),
          status: "inactive",
          updatedAt: new Date(anchorMs),
        });

        const descRules: AgentSessionSortRule[] = [
          { column: "duration", dir: "desc" },
          { column: "repo", dir: "asc" },
        ];
        const descIds = await readPageIds(organizationId, descRules);
        expect(descIds).toEqual([oneSecond, startedOnTheMinute]);
        expect(await inMemoryAscOrder(organizationId, descRules)).toEqual(
          descIds
        );

        const ascRules: AgentSessionSortRule[] = [
          { column: "duration", dir: "asc" },
          { column: "repo", dir: "asc" },
        ];
        const ascIds = await readPageIds(organizationId, ascRules);
        expect(ascIds).toEqual([oneSecond, startedOnTheMinute]);
        expect(await inMemoryAscOrder(organizationId, ascRules)).toEqual(
          ascIds
        );
      }
    );

    it("returns each row's `recordUpdatedAtMs` witness key, read in the ordering's own snapshot", async () => {
      const { organizationId, fixture } = await seedFixture();

      // The KEY half of the reader's contract, same as the single-rule
      // siblings: the shadow's divergence attribution can only separate a
      // moving key from a real ordering divergence if these come back
      // populated (`session-list-sort-differ.ts`).
      const page = await readSessionListPageByCompoundSort(
        { organizationId, filters: EMPTY_LIST_QUERY },
        [
          { column: "cost", dir: "asc" },
          { column: "repo", dir: "desc" },
          { column: "updated", dir: "desc" },
        ],
        0,
        10
      );
      expect(page.find((row) => row.id === fixture.costLow)).toMatchObject({
        recordUpdatedAtMs: expect.any(Number),
      });
    });
  }
);

async function readPageIds(
  organizationId: string,
  rules: readonly AgentSessionSortRule[]
): Promise<string[]> {
  const page = await readSessionListPageByCompoundSort(
    { organizationId, filters: EMPTY_LIST_QUERY },
    rules,
    0,
    10
  );
  return page.map((row) => row.id);
}

/** The existing in-memory comparator's own order, for the cross-check assertion. */
async function inMemoryAscOrder(
  organizationId: string,
  rules: readonly AgentSessionSortRule[]
): Promise<string[]> {
  const candidates = await withDb((db) =>
    db.sessionDetail.findMany({
      where: { artifact: { is: { organizationId } } },
      select: displaySortCandidateSelect,
    })
  );
  const compare = buildDisplaySortComparator(rules);
  return [...candidates].sort(compare).map((row) => row.artifactId);
}

/**
 * Six sessions with distinct values across every column the chains above sort
 * by, so each secondary/tertiary/quaternary key genuinely discriminates rather
 * than falling through to the `artifact_id` tiebreaker.
 *
 * The two cost-10 rows deliberately SHARE a repo, so the third slot of the
 * first chain has a tie to decide.
 */
async function seedFixture(): Promise<{
  organizationId: string;
  fixture: Fixture;
}> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    user.id,
    `lane-8554-${randomUUID()}`
  );

  const costTieBeta = await seedSession(organizationId, computeTargetId, {
    status: "inactive",
    cost: 10,
    repo: "Acme/beta",
    harness: "claude",
    priority: "HIGH",
    durationSeconds: 200,
    updatedAt: new Date(FAR_PAST.getTime() + 1000),
  });
  const costTieAlpha = await seedSession(organizationId, computeTargetId, {
    status: "inactive",
    cost: 10,
    repo: "Acme/beta",
    harness: "codex",
    priority: "LOW",
    durationSeconds: 150,
    updatedAt: new Date(FAR_PAST.getTime() + 2000),
  });
  const costLow = await seedSession(organizationId, computeTargetId, {
    status: "inactive",
    cost: 5,
    repo: "zeta_one",
    harness: "claude",
    priority: "MEDIUM",
    durationSeconds: 120,
    updatedAt: new Date(FAR_PAST.getTime() + 3000),
  });
  const statusError = await seedSession(organizationId, computeTargetId, {
    status: "error",
    cost: 1,
    repo: "Mid-tier/m",
    harness: "claude",
    priority: null,
    durationSeconds: 20,
    updatedAt: new Date(FAR_PAST.getTime() + 4000),
  });
  const statusInactiveLong = await seedSession(
    organizationId,
    computeTargetId,
    {
      status: "inactive",
      cost: 1,
      repo: "acme/r",
      harness: "gemini",
      priority: null,
      durationSeconds: 45,
      updatedAt: new Date(FAR_PAST.getTime() + 5000),
    }
  );
  // Stored `active`, with a recorded end nothing followed: it reads as still
  // running like any other `active` row. Alone in the `active` status group in
  // the test below, so its own duration value never decides the ordering.
  const statusActiveEnded = await seedSession(organizationId, computeTargetId, {
    status: "active",
    cost: 1,
    repo: "Zulu/z",
    harness: "claude",
    priority: null,
    durationSeconds: 30,
    updatedAt: new Date(FAR_PAST.getTime() + 6000),
    lastActivityOffsetSeconds: 1,
  });

  return {
    organizationId,
    fixture: {
      costTieBeta,
      costTieAlpha,
      costLow,
      statusError,
      statusInactiveLong,
      statusActiveEnded,
    },
  };
}

type OwnerFixture = {
  alSmith: string;
  aliceYoung: string;
  bobTabSurname: string;
  bobPlain: string;
  nbspOnlyName: string;
};

/**
 * Five sessions, each owned by a user whose NAME PARTS probe one way the owner
 * key can drift. Every other sort input is held equal, so the `user` rule and
 * its `repo` tiebreak are the only things deciding the order.
 */
async function seedOwnerFixture(): Promise<{
  organizationId: string;
  owners: OwnerFixture;
}> {
  const organizationId = await organizations.create();
  const seedUser = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    seedUser.id,
    `lane-8554-owner-${randomUUID()}`
  );

  const alSmith = await seedOwnedSession(organizationId, computeTargetId, {
    firstName: "Al",
    lastName: "Smith",
    repo: "C-al",
  });
  const aliceYoung = await seedOwnedSession(organizationId, computeTargetId, {
    firstName: "Alice",
    lastName: "Young",
    repo: "D-alice",
  });
  // Keys 'bob smith' once the trailing TAB is trimmed, tying with the row
  // below; `repo` then puts THIS row first. Left untrimmed it keys
  // 'bob smith\t' and sorts AFTER its twin instead.
  const bobTabSurname = await seedOwnedSession(
    organizationId,
    computeTargetId,
    {
      firstName: "Bob",
      lastName: TAB_SUFFIXED_SURNAME,
      repo: "A-tab",
    }
  );
  const bobPlain = await seedOwnedSession(organizationId, computeTargetId, {
    firstName: "Bob",
    lastName: "Smith",
    repo: "B-plain",
  });
  // No usable name part survives the trim, so the key is the EMAIL, and the
  // `aa-` prefix puts that ahead of every name above. Left in the key the raw
  // NBSP goes LAST instead — `COLLATE "C"` is a byte comparison and U+00A0
  // encodes as 0xC2 0xA0, above every ASCII letter.
  const nbspOnlyName = await seedOwnedSession(organizationId, computeTargetId, {
    email: `aa-nbsp-${randomUUID()}@example.com`,
    firstName: NBSP_ONLY_NAME,
    lastName: null,
    repo: "E-nbsp",
  });

  return {
    organizationId,
    owners: { alSmith, aliceYoung, bobTabSurname, bobPlain, nbspOnlyName },
  };
}

/** One session owned by a freshly created user with the given name parts. */
async function seedOwnedSession(
  organizationId: string,
  computeTargetId: string,
  owner: {
    email?: string;
    firstName: string;
    lastName: string | null;
    repo: string;
  }
): Promise<string> {
  const user = await createTestUser(organizationId, {
    ...(owner.email === undefined ? {} : { email: owner.email }),
    firstName: owner.firstName,
    lastName: owner.lastName,
  });
  return await seedSession(organizationId, computeTargetId, {
    cost: 1,
    durationSeconds: 60,
    harness: "claude",
    priority: null,
    repo: owner.repo,
    status: "inactive",
    updatedAt: FAR_PAST,
    userId: user.id,
  });
}

/** Raw Prisma + raw SQL, so no expectation here derives from the code under test. */
function seedSession(
  organizationId: string,
  computeTargetId: string,
  overrides: {
    status: string;
    cost: number;
    repo: string;
    harness: string;
    priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT" | null;
    updatedAt: Date;
    /** The span's length, when it is measured from {@link FAR_PAST}. */
    durationSeconds?: number;
    /** Seconds after `sessionStartedAt` that `lastActivityAt` is pinned to. */
    lastActivityOffsetSeconds?: number;
    /** Set explicitly for a clock-anchored row; otherwise {@link FAR_PAST}. */
    sessionStartedAt?: Date;
    /** `null` leaves the row RUNNING — no recorded end at all. */
    sessionEndedAt?: Date | null;
    lastActivityAt?: Date;
    userId?: string;
  }
): Promise<string> {
  const sessionStartedAt = overrides.sessionStartedAt ?? FAR_PAST;
  const sessionEndedAt =
    overrides.sessionEndedAt === undefined
      ? new Date(
          sessionStartedAt.getTime() + (overrides.durationSeconds ?? 0) * 1000
        )
      : overrides.sessionEndedAt;
  const lastActivityAt =
    overrides.lastActivityAt ??
    (overrides.lastActivityOffsetSeconds === undefined
      ? (sessionEndedAt ?? sessionStartedAt)
      : new Date(
          sessionStartedAt.getTime() +
            overrides.lastActivityOffsetSeconds * 1000
        ));
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: "ISS-8554 Phase 3 compound-sort fixture",
        status: overrides.status,
        ...(overrides.priority ? { priority: overrides.priority } : {}),
        // The statement and the in-memory comparator both key `user` on the
        // assignee (ISS-12251 AC-006).
        ...(overrides.userId ? { assigneeId: overrides.userId } : {}),
        session: {
          create: {
            computeTargetId,
            externalSessionId: `iss-8554-compound-${randomUUID()}`,
            harness: overrides.harness,
            repositoryFullName: overrides.repo,
            estimatedCost: overrides.cost,
            sessionStartedAt,
            sessionUpdatedAt: sessionStartedAt,
            lastActivityAt,
            sessionEndedAt,
            endsWithError: false,
          },
        },
      },
      select: { id: true },
    });
    await db.$executeRaw`UPDATE session_detail SET updated_at = ${overrides.updatedAt} WHERE artifact_id = ${artifact.id}::uuid`;
    await db.$executeRaw`UPDATE artifacts SET updated_at = ${overrides.updatedAt} WHERE id = ${artifact.id}::uuid`;
    return artifact.id;
  });
}
