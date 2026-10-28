/**
 * PLN-1775 M1 (ISS-7403): the discovery-candidate write.
 *
 * Drives the real `recordObservedRepositories` against the same fake-Prisma
 * fragment tree the repo-sync tier suites use, so the statement's shape, binds,
 * ordering, and chunking are asserted rather than described. What this write
 * must NOT do is as load-bearing as what it does: an already-verified row keeps
 * its state and the verifier's bookkeeping, because re-seeing a repository is
 * not evidence about whether the org can read it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindsOf,
  type MockDb,
  makeDb,
  mockPrismaJoin,
  mockPrismaSql,
  staticSqlOf,
} from "./github-repo-sync-doubles";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  Prisma: { sql: mockPrismaSql, join: mockPrismaJoin },
}));

vi.mock("@repo/api/src/types/branch", () => ({
  normalizeRepoFullName: (value: string) => value.trim().toLowerCase(),
}));

import { withDb } from "@repo/database";
import {
  OBSERVED_REPOSITORY_UPSERT_CHUNK_SIZE,
  recordObservedRepositories,
} from "@/lib/github/observed-repository-store";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-08-20T12:00:00.000Z");
const ORG = "org-observed-1";

/** Binds per VALUES row: id, org, full name, state, first, last, count, updated. */
const BINDS_PER_OBSERVATION_ROW = 8;
const FULL_NAME_BIND_OFFSET = 2;
const VERIFICATION_STATE_BIND_OFFSET = 3;
const FIRST_OBSERVED_AT_BIND_OFFSET = 4;
const LAST_OBSERVED_AT_BIND_OFFSET = 5;
const OBSERVED_COUNT_BIND_OFFSET = 6;
const UPDATED_AT_BIND_OFFSET = 7;

function wire(db: MockDb): void {
  mockWithDb.mockImplementation((fn: (client: MockDb) => unknown) => fn(db));
}

function fullNamesWritten(db: MockDb): unknown[] {
  return db.$executeRaw.mock.calls.flatMap((call) => {
    const binds = bindsOf(call[0]);
    const names: unknown[] = [];
    for (
      let start = 0;
      start < binds.length;
      start += BINDS_PER_OBSERVATION_ROW
    ) {
      names.push(binds[start + FULL_NAME_BIND_OFFSET]);
    }
    return names;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordObservedRepositories", () => {
  it("writes one INSERT ... ON CONFLICT that only ever touches the observation columns", async () => {
    const db = makeDb();
    wire(db);

    await recordObservedRepositories({
      organizationId: ORG,
      observations: [
        { repositoryFullName: "acme/widget", observedSessionCount: 3 },
      ],
      now: NOW,
    });

    const statement = db.$executeRaw.mock.calls[0]?.[0];
    const sql = staticSqlOf(statement);
    expect(sql).toContain('INSERT INTO "github_observed_repository"');
    expect(sql).toContain(
      'ON CONFLICT ("organization_id", "repository_full_name") DO UPDATE SET'
    );
    // The verifier owns state, identity, failure count, and next attempt. An
    // observation that reset any of them would let a busy repository retry a
    // settled denial forever, and would strip a verified row of the identity
    // branch authority depends on.
    const assignedColumns = [...sql.matchAll(/"(\w+)" =/g)].map(
      (match) => match[1]
    );
    expect([...new Set(assignedColumns)].sort()).toEqual([
      "last_observed_at",
      "observed_session_count",
      "updated_at",
    ]);

    const binds = bindsOf(statement);
    expect(binds).toHaveLength(BINDS_PER_OBSERVATION_ROW);
    expect(binds[FULL_NAME_BIND_OFFSET]).toBe("acme/widget");
    // A new row is only ever a candidate: never verified, never carrying
    // identity a desktop-reported name cannot prove.
    expect(binds[VERIFICATION_STATE_BIND_OFFSET]).toBe("pending");
    expect(binds[OBSERVED_COUNT_BIND_OFFSET]).toBe(3);
    // Every timestamp is BOUND, never `NOW()`: the columns are TIMESTAMP(3)
    // without zone, beside UTC values Prisma writes.
    expect(binds[FIRST_OBSERVED_AT_BIND_OFFSET]).toBe(NOW);
    expect(binds[LAST_OBSERVED_AT_BIND_OFFSET]).toBe(NOW);
    expect(binds[UPDATED_AT_BIND_OFFSET]).toBe(NOW);
  });

  it("accumulates the observed count on conflict instead of overwriting it", async () => {
    const db = makeDb();
    wire(db);

    await recordObservedRepositories({
      organizationId: ORG,
      observations: [
        { repositoryFullName: "acme/widget", observedSessionCount: 2 },
      ],
      now: NOW,
    });

    const sql = staticSqlOf(db.$executeRaw.mock.calls[0]?.[0]);
    // A replacement would make the column report "repos in the last batch"
    // rather than accumulated evidence, and the verifier orders its backlog by
    // it.
    expect(sql).toContain(
      '"github_observed_repository"."observed_session_count"'
    );
    expect(sql).toContain('+ EXCLUDED."observed_session_count"');
  });

  it("folds names that normalize together so one statement cannot carry a duplicate conflict key", async () => {
    const db = makeDb();
    wire(db);

    await recordObservedRepositories({
      organizationId: ORG,
      observations: [
        { repositoryFullName: "Acme/Widget", observedSessionCount: 2 },
        { repositoryFullName: " acme/widget ", observedSessionCount: 5 },
      ],
      now: NOW,
    });

    // Postgres aborts a multi-row ON CONFLICT with SQLSTATE 21000 when one key
    // repeats, which would lose the whole chunk rather than one row.
    const binds = bindsOf(db.$executeRaw.mock.calls[0]?.[0]);
    expect(binds).toHaveLength(BINDS_PER_OBSERVATION_ROW);
    expect(binds[FULL_NAME_BIND_OFFSET]).toBe("acme/widget");
    expect(binds[OBSERVED_COUNT_BIND_OFFSET]).toBe(7);
  });

  it("writes repositories in a total order so concurrent ingests cannot deadlock", async () => {
    const db = makeDb();
    wire(db);

    await recordObservedRepositories({
      organizationId: ORG,
      observations: [
        { repositoryFullName: "acme/zulu", observedSessionCount: 1 },
        { repositoryFullName: "acme/alpha", observedSessionCount: 1 },
        { repositoryFullName: "acme/marisol", observedSessionCount: 1 },
      ],
      now: NOW,
    });

    // Two desktops syncing one org overlap routinely; unordered row locks make
    // that a 40P01 the caller would swallow as a lost observation.
    expect(fullNamesWritten(db)).toEqual([
      "acme/alpha",
      "acme/marisol",
      "acme/zulu",
    ]);
  });

  it("chunks past the bind ceiling and writes every chunk", async () => {
    const db = makeDb();
    wire(db);
    const total = OBSERVED_REPOSITORY_UPSERT_CHUNK_SIZE + 5;
    const observations = Array.from({ length: total }, (_, index) => ({
      repositoryFullName: `acme/repo-${String(index).padStart(6, "0")}`,
      observedSessionCount: 1,
    }));

    await recordObservedRepositories({
      organizationId: ORG,
      observations,
      now: NOW,
    });

    // Postgres refuses a statement past its bind ceiling, and the chunk size is
    // derived from that ceiling — so a widened row moves the size rather than
    // overflowing the Bind message.
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    expect(fullNamesWritten(db)).toHaveLength(total);
  });

  it("issues no statement when there is nothing to observe", async () => {
    const db = makeDb();
    wire(db);

    await recordObservedRepositories({
      organizationId: ORG,
      observations: [{ repositoryFullName: "   ", observedSessionCount: 1 }],
      now: NOW,
    });

    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
