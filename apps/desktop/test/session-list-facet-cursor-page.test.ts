import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SessionListCursorSortKey } from "../src/main/agent-sync/agent-session-read-model.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { SESSION_STARTED_AT_TS_EXPR } from "../src/main/agent-sync/session-date-window.js";
import {
  buildListCursorFilterClause,
  listCursorPageSortSql,
} from "../src/main/database/session-aggregate-filters.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { listFacetsFromQuery } from "../src/main/session/session-read-fast-paths.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import { sanitizeQuery } from "../src/main/session/shared-agent-sessions-query.js";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/shared/session-date-window-contract.js";
import {
  type SharedAgentSessionsListRequest,
  UNKNOWN_HARNESS_BUCKET,
} from "../src/shared/shared-agent-sessions-contract.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  insertSqliteEvent,
  insertSqliteSession,
} from "./sqlite-session-fixtures.js";

/**
 * ISS-12439 — the Owner, Harness, Model, Priority facets and the `updated`
 * sort page in SQL. The hydrated list read (`listSessionCursorPage` removed
 * from the source) is the oracle: a facet read must return the same ids, in the
 * same order, with the same total, on a corpus built to tie on every sort key.
 */

type SeedRow = {
  id: string;
  harness: string | null;
  model: string | null;
  priority: Priority | null;
  userId: string | null;
  startedAt: string;
  updatedAt: string;
  lastActivityAt: string;
};

const TABLE_SCAN_PATTERN = /SCAN (s|sessions)\b/;
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const TIED_ACTIVITY = "2026-06-10T10:00:00.000Z";
const TIED_UPDATE = "2026-06-12T00:00:00.000Z";

// Rows share last activity, start, and update instants in groups, so only the
// tie order separates them.
const ROWS: readonly SeedRow[] = [
  seed(
    "a1",
    "claude",
    "opus",
    Priority.High,
    OWNER_A,
    "07",
    TIED_ACTIVITY,
    TIED_UPDATE
  ),
  seed(
    "a2",
    "claude",
    "opus",
    Priority.Low,
    OWNER_B,
    "08",
    TIED_ACTIVITY,
    TIED_UPDATE
  ),
  seed(
    "a3",
    "codex",
    "gpt",
    null,
    OWNER_A,
    "07",
    TIED_ACTIVITY,
    "2026-06-13T00:00:00.000Z"
  ),
  seed(
    "a4",
    "codex",
    null,
    Priority.High,
    null,
    "09",
    TIED_ACTIVITY,
    "2026-06-13T00:00:00.000Z"
  ),
  seed(
    "a5",
    null,
    "gpt",
    Priority.Urgent,
    OWNER_B,
    "09",
    "2026-06-11T10:00:00.000Z",
    TIED_UPDATE
  ),
  seed(
    "a6",
    null,
    null,
    null,
    OWNER_A,
    "07",
    "2026-06-11T10:00:00.000Z",
    TIED_UPDATE
  ),
  seed(
    "a7",
    "claude",
    null,
    Priority.Medium,
    OWNER_B,
    "06",
    "2026-06-09T10:00:00.000Z",
    "2026-06-14T00:00:00.000Z"
  ),
  seed(
    "a8",
    "codex",
    "opus",
    null,
    null,
    "06",
    "2026-06-09T10:00:00.000Z",
    "2026-06-14T00:00:00.000Z"
  ),
];

const FACET_REQUESTS: readonly [string, SharedAgentSessionsListRequest][] = [
  ["owner", { userIds: [OWNER_A] }],
  ["two owners", { userIds: [OWNER_A, OWNER_B] }],
  ["scoped owner", { userId: OWNER_B }],
  ["harness", { harnesses: ["claude"] }],
  ["single harness", { harness: "codex" }],
  ["harness unknown", { harnesses: [UNKNOWN_HARNESS_BUCKET] }],
  ["harness and unknown", { harnesses: ["codex", UNKNOWN_HARNESS_BUCKET] }],
  ["model", { models: ["opus"] }],
  ["model unknown", { models: [UNKNOWN_HARNESS_BUCKET] }],
  ["priority", { priorities: [Priority.High] }],
  ["priority unset", { priorities: [PRIORITY_UNSET_VALUE] }],
  ["priority and unset", { priorities: [Priority.Low, PRIORITY_UNSET_VALUE] }],
  ["owner and harness", { userIds: [OWNER_A], harnesses: ["claude", "codex"] }],
  [
    "harness and priority",
    { harnesses: ["codex"], priorities: [Priority.High] },
  ],
  [
    "status and model",
    {
      statuses: [SESSION_STATUS.INACTIVE],
      models: ["gpt", UNKNOWN_HARNESS_BUCKET],
    },
  ],
];

const SORTS: readonly Pick<
  SharedAgentSessionsListRequest,
  "sortBy" | "sortDir"
>[] = [
  { sortBy: "lastActivity", sortDir: "desc" },
  { sortBy: "lastActivity", sortDir: "asc" },
  { sortBy: "started", sortDir: "desc" },
  { sortBy: "started", sortDir: "asc" },
  { sortBy: "updated", sortDir: "desc" },
  { sortBy: "updated", sortDir: "asc" },
  {},
];

let dir: string;
let db: SqliteAgentDatabase;
let cursorCalls = 0;
let pagedSource: AgentSessionSyncSource;
let hydratedSource: AgentSessionSyncSource;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "iss-12439-"));
  db = await openTestDb(dir);
  for (const row of ROWS) {
    await insertSqliteSession(db, row.id, {
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      status: SESSION_STATUS.INACTIVE,
    });
    await db.run(
      "UPDATE sessions SET harness = $1, model = $2, priority = $3, user_id = $4 WHERE id = $5",
      row.harness,
      row.model,
      row.priority,
      row.userId,
      row.id
    );
    await insertSqliteEvent(db, row.id, row.lastActivityAt);
  }
  const source = db.syncSource;
  pagedSource = {
    ...source,
    listSessionCursorPage: (request) => {
      cursorCalls += 1;
      return source.listSessionCursorPage?.(request) as never;
    },
  };
  hydratedSource = { ...source, listSessionCursorPage: undefined };
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a facet read pages in SQL and returns the hydrated read's rows", () => {
  for (const [name, facet] of FACET_REQUESTS) {
    for (const sort of SORTS) {
      test(`${name}, ${sort.sortBy ?? "unsorted"} ${sort.sortDir ?? ""}`, async () => {
        const request = {
          quality: "all",
          limit: 50,
          ...facet,
          ...sort,
        } as const;
        const before = cursorCalls;
        const paged = await getSharedAgentSessions(pagedSource, request);
        const hydrated = await getSharedAgentSessions(hydratedSource, request);

        expect(cursorCalls).toBe(before + 1);
        expect(paged.items.map((item) => item.id)).toEqual(
          hydrated.items.map((item) => item.id)
        );
        expect(paged.total).toBe(hydrated.total);
      });
    }
  }

  test("the facets select a strict, non-empty subset", async () => {
    const owner = await getSharedAgentSessions(pagedSource, {
      quality: "all",
      userIds: [OWNER_A],
      sortBy: "updated",
      sortDir: "asc",
    });
    assert.deepEqual(
      owner.items.map((item) => item.id),
      ["a6", "a1", "a3"]
    );
    const unknownModel = await getSharedAgentSessions(pagedSource, {
      quality: "all",
      models: [UNKNOWN_HARNESS_BUCKET],
      sortBy: "updated",
      sortDir: "desc",
    });
    assert.deepEqual(
      unknownModel.items.map((item) => item.id),
      ["a7", "a4", "a6"]
    );
  });
});

describe("a facet count is served by its index, not a table scan", () => {
  const COUNT_CASES: readonly [
    string,
    SharedAgentSessionsListRequest,
    string,
  ][] = [
    ["harness", { harnesses: ["claude"] }, "idx_sessions_harness"],
    ["model", { models: ["opus"] }, "idx_sessions_model"],
    ["priority", { priorities: [Priority.High] }, "idx_sessions_priority"],
    ["owner", { userIds: [OWNER_A] }, "idx_sessions_user_id"],
  ];
  for (const [name, facet, index] of COUNT_CASES) {
    test(name, async () => {
      const { clause, params } = buildListCursorFilterClause(
        listFacetsFromQuery(
          sanitizeQuery(facet, SESSIONS_SURFACE_DATE_WINDOW_FIELD)
        )
      );
      const plan = await db.prisma.client.$queryRawUnsafe<{ detail: string }[]>(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM sessions s ${clause}`,
        ...params
      );
      const detail = plan.map((row) => row.detail).join(" | ");
      expect(detail).toContain(`USING COVERING INDEX ${index}`);
      expect(detail).not.toMatch(TABLE_SCAN_PATTERN);
    });
  }
});

describe("tamsinb review (ISS-12439): the PAGE query, not only the count, is served by the facet's index", () => {
  // Under the default lastActivity sort, `listCursorPageSortSql` used to pin
  // `INDEXED BY idx_sessions_last_activity_started` unconditionally, so a
  // selective facet (a model in a handful of 7,872 rows) still walked that
  // whole index testing the facet predicate on every row
  // (`SCAN s USING INDEX idx_sessions_last_activity_started`). The pin is now
  // skipped when the request carries a facet, so the planner is free to seek
  // the facet's own index instead.
  const PAGE_CASES: readonly [string, SharedAgentSessionsListRequest][] = [
    ["harness", { harnesses: ["claude"] }],
    ["model", { models: ["opus"] }],
    ["priority", { priorities: [Priority.High] }],
    ["owner", { userIds: [OWNER_A] }],
  ];
  for (const [name, facet] of PAGE_CASES) {
    test(name, async () => {
      const query = sanitizeQuery(facet, SESSIONS_SURFACE_DATE_WINDOW_FIELD);
      const { clause, params } = buildListCursorFilterClause(
        listFacetsFromQuery(query)
      );
      const { source, orderBy } = listCursorPageSortSql(
        SessionListCursorSortKey.LastActivity,
        "DESC",
        true
      );
      const plan = await db.prisma.client.$queryRawUnsafe<{ detail: string }[]>(
        `EXPLAIN QUERY PLAN
         WITH activity AS (
           SELECT s.id, s.updated_at,
             ${SESSION_STARTED_AT_TS_EXPR} AS sort_started_at,
             s.last_activity_at AS sort_last_activity_at,
             s.started_at AS tie_started_at
           FROM ${source}
           ${clause}
         )
         SELECT id, updated_at FROM activity ORDER BY ${orderBy} LIMIT 50 OFFSET 0`,
        ...params
      );
      const detail = plan.map((row) => row.detail).join(" | ");
      expect(detail).not.toContain(
        "USING INDEX idx_sessions_last_activity_started"
      );
      expect(detail).not.toMatch(TABLE_SCAN_PATTERN);
    });
  }
});

function seed(
  id: string,
  harness: string | null,
  model: string | null,
  priority: Priority | null,
  userId: string | null,
  startHour: string,
  lastActivityAt: string,
  updatedAt: string
): SeedRow {
  return {
    id,
    harness,
    model,
    priority,
    userId,
    startedAt: `2026-06-08T${startHour}:00:00.000Z`,
    updatedAt,
    lastActivityAt,
  };
}

describe("a row that changes between selection and hydration is dropped", () => {
  test("a Priority edit after the cursor page leaves the row out of the facet", async () => {
    const stale: AgentSessionSyncSource = {
      ...pagedSource,
      loadSyncedSessions: async (ids, cache, loadOptions) => {
        await db.run(
          "UPDATE sessions SET priority = $1 WHERE id = $2",
          Priority.Low,
          "a1"
        );
        return pagedSource.loadSyncedSessions(ids, cache, loadOptions);
      },
    };
    try {
      const result = await getSharedAgentSessions(stale, {
        quality: "all",
        priorities: [Priority.High],
        sortBy: "updated",
        sortDir: "asc",
      });
      assert.ok(!result.items.some((item) => item.id === "a1"));
      assert.ok(result.items.some((item) => item.id === "a4"));
    } finally {
      await db.run(
        "UPDATE sessions SET priority = $1 WHERE id = $2",
        Priority.High,
        "a1"
      );
    }
  });
});

describe("cursor search preserves hydrated repository and base-branch identity", () => {
  const BASE_BRANCH = "release/hotfix-2026";
  let worktreeDir: string;

  beforeAll(async () => {
    worktreeDir = path.join(dir, "b1-worktree");
    const launchWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
    await mkdir(launchWorkDir, { recursive: true });
    await writeFile(
      path.join(launchWorkDir, "launch-metadata.json"),
      JSON.stringify({ baseBranch: BASE_BRANCH })
    );
    await insertSqliteSession(db, "b1", {
      name: "Session b1",
      cwd: worktreeDir,
      startedAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      status: SESSION_STATUS.INACTIVE,
    });
    await db.run(
      "UPDATE sessions SET harness = $1, repo_full_name = $2, metadata = $3 WHERE id = $4",
      "claude",
      "acme/repo-target",
      JSON.stringify({ gitBranch: "legacy-metadata-only" }),
      "b1"
    );
    await insertSqliteEvent(db, "b1", "2026-06-15T00:00:00.000Z");
    await insertSqliteSession(db, "b2", {
      name: "Session b2",
      startedAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      status: SESSION_STATUS.INACTIVE,
    });
    for (const [suffix, observedAt] of [
      ["old", "2026-06-15T00:00:00.000Z"],
      ["new", "2026-06-16T00:00:00.000Z"],
    ] as const) {
      const artifactId = `b2-artifact-${suffix}`;
      await db.run(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, branch_name,
            harness, observed_at, created_at, last_seen_at)
         VALUES ($1, $2, 'branch', 'acme/branches', $3,
                 'claude', $4, $4, $4)`,
        artifactId,
        `branch:acme/branches:${suffix}`,
        `search-${suffix}-branch`,
        observedAt
      );
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, is_primary,
            status, extractor_version, observed_at, created_at)
         VALUES ($1, 'b2', $2, 'created', 'git_commit', '{}', 0,
                 'candidate', 1, $3, $3)`,
        `b2:${artifactId}`,
        artifactId,
        observedAt
      );
    }
  });

  afterAll(async () => {
    await db.run("DELETE FROM sessions WHERE id = $1", "b1");
    await db.run("DELETE FROM sessions WHERE id = $1", "b2");
    await db.run("DELETE FROM artifacts WHERE id LIKE 'b2-artifact-%'");
  });

  test("a harness facet plus a base-branch-only search term keeps the match", async () => {
    const request = {
      quality: "all",
      harnesses: ["claude"],
      search: "hotfix-2026",
      limit: 50,
    } as const;
    const before = cursorCalls;
    const paged = await getSharedAgentSessions(pagedSource, request);
    const hydrated = await getSharedAgentSessions(hydratedSource, request);

    expect(cursorCalls).toBe(before + 1);
    assert.ok(
      hydrated.items.some((item) => item.id === "b1"),
      "the hydrated oracle must match b1 via its base branch"
    );
    expect(paged.items.map((item) => item.id)).toEqual(
      hydrated.items.map((item) => item.id)
    );
    expect(paged.total).toBe(hydrated.total);
  });

  test("a repository-only search term uses the cursor and keeps the same row", async () => {
    const request = {
      quality: "all",
      search: "repo-target",
      limit: 50,
    } as const;
    const before = cursorCalls;
    const paged = await getSharedAgentSessions(pagedSource, request);
    const hydrated = await getSharedAgentSessions(hydratedSource, request);

    expect(cursorCalls).toBe(before + 1);
    expect(paged.items.map((item) => item.id)).toEqual(
      hydrated.items.map((item) => item.id)
    );
    expect(paged.items.some((item) => item.id === "b1")).toBe(true);
    expect(paged.total).toBe(hydrated.total);
  });

  test("branch provenance supplies repository search when cwd and stored name are absent", async () => {
    const request = {
      quality: "all",
      search: "acme/branches",
      limit: 50,
    } as const;
    const paged = await getSharedAgentSessions(pagedSource, request);
    const hydrated = await getSharedAgentSessions(hydratedSource, request);

    expect(paged.items.map((item) => item.id)).toEqual(["b2"]);
    expect(paged.items.map((item) => item.id)).toEqual(
      hydrated.items.map((item) => item.id)
    );
    expect(paged.total).toBe(hydrated.total);
  });

  test("a phrase spanning fields is not a per-field substring match", async () => {
    const request = {
      quality: "all",
      search: "Session b1 acme/repo-target",
      limit: 50,
    } as const;
    const paged = await getSharedAgentSessions(pagedSource, request);
    const hydrated = await getSharedAgentSessions(hydratedSource, request);

    expect(paged.items.map((item) => item.id)).toEqual(
      hydrated.items.map((item) => item.id)
    );
    expect(paged.items).toEqual([]);
    expect(paged.total).toBe(0);
  });

  test("search sees only the newest write-evidenced branch", async () => {
    for (const [search, expectedIds] of [
      ["search-new-branch", ["b2"]],
      ["search-old-branch", []],
    ] as const) {
      const request = { quality: "all", search, limit: 50 } as const;
      const paged = await getSharedAgentSessions(pagedSource, request);
      const hydrated = await getSharedAgentSessions(hydratedSource, request);

      expect(paged.items.map((item) => item.id)).toEqual(expectedIds);
      expect(paged.items.map((item) => item.id)).toEqual(
        hydrated.items.map((item) => item.id)
      );
      expect(paged.total).toBe(hydrated.total);
    }
  });

  test("metadata-only gitBranch is not the displayed branch search field", async () => {
    const request = {
      quality: "all",
      search: "legacy-metadata-only",
      limit: 50,
    } as const;
    const paged = await getSharedAgentSessions(pagedSource, request);
    const hydrated = await getSharedAgentSessions(hydratedSource, request);

    expect(paged.items.map((item) => item.id)).toEqual([]);
    expect(paged.total).toBe(0);
    expect(paged.total).toBe(hydrated.total);
  });
});
