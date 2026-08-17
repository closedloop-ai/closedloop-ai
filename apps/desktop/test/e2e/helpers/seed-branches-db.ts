/**
 * Direct SQLite seeding for the Branches E2E tests.
 *
 * Unlike `seedClaudeTranscripts` (which drives the real importer, but can only
 * ever produce a net-new Draft branch — the local importer captures PR creation,
 * not a MERGED lifecycle), some Branches assertions need a corpus the importer
 * cannot synthesize on its own: a MERGED, single-PR branch with NO LOC enrichment
 * (FEA-2159's "Median PR size" case). That requires a `pull_requests` row with
 * `merged_at` set plus a `kind='branch'` artifact whose `lines_added/removed/
 * files_changed` are NULL and NO matching `kind='pull_request'` artifact to fall
 * back to.
 *
 * The desktop store is a single libSQL/SQLite file (`agent-dashboard.sqlite`) in
 * the app's `--user-data-dir`, opened in WAL mode. WAL supports multi-process
 * access, so this helper opens a SECOND `@libsql/client` connection on the SAME
 * file — exactly the connection type the app's own `openMigrationDatabase` uses —
 * and inserts the four real rows the Branches read path projects from:
 * `sessions`, `artifacts` (kind='branch'), `session_artifact_links`, and
 * `pull_requests`. These are the REAL tables `getSharedBranchAnalytics` reads, so
 * the app's real projection runs over them — no test-only code path.
 *
 * Every seeded session also gets a synthetic `PreToolUse` tool event (FEA-1421),
 * without which FEA-3284's default `quality=substantive` list read would classify
 * it as an idle phantom row and hide it. See `seedSessionsList`'s docstring below
 * for the rule and the `idle` opt-out.
 *
 * The db host opens + migrates the schema ASYNCHRONOUSLY after launch, so
 * `seedMergedUnenrichedSinglePrBranch` first polls `sqlite_master` until the
 * tables exist, then commits the rows in one batch (FK-ordered: parents first).
 * Applies the same WAL/busy-timeout/foreign-keys PRAGMAs every desktop connection
 * applies (see connection-pragmas.ts) so the write behaves identically.
 */

import { createClient } from "@libsql/client";
import type { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link.ts";
import {
  applyDesktopBusyTimeout,
  applyDesktopSeedPragmas,
  branchesDbPath,
  waitForMigrationsApplied,
  waitForTablesPresent,
} from "./desktop-seed-core";
import { closedloopArtifactBatchItems } from "./seed-closedloop-artifact-link";

/**
 * The `artifacts.id` a branch seed writes for a given session — the SSOT for the
 * seeded branch artifact identity. Branch DETAIL is keyed by this artifact id
 * (App.tsx `route.branchId`), NOT by the session id, so callers that want to
 * open the seeded branch detail must navigate with this value.
 */
export function branchArtifactId(sessionId: string): string {
  return `artifact-branch-${sessionId}`;
}

export type MergedUnenrichedBranchSeed = {
  /** GitHub-style "owner/repo" (matched null-safely to the PR row). */
  repoFullName: string;
  /** The branch name (NOT a default branch — those are hidden by the read). */
  branchName: string;
  /** External session id the branch is linked through. */
  sessionId: string;
  /** The single linked PR's number. */
  prNumber: number;
  /** ISO merge instant — makes the PR state MERGED (status → Merged). */
  mergedAt: string;
};

export type NoPullRequestBranchSeed = {
  /** GitHub-style "owner/repo" stored on the branch artifact. */
  repoFullName: string;
  /** The branch name (NOT a default branch - those are hidden by the read). */
  branchName: string;
  /** External session id the branch is linked through. */
  sessionId: string;
  /** The linked session activity instant that drives the Branches row age. */
  activityAt: string;
  /** Optional canonical monitored-activity carrier persisted on the Branch link. */
  canonicalActivityEvidenceJson?: string;
  /**
   * ISS-4737 — the linked session's CAPTURED cost, as one `token_usage` row.
   *
   * Omit for the default corpus: no row at all, i.e. NOTHING PRICED. Pass `0` for
   * the distinct "PRICED, and it sums to exactly zero" state the AI-spend card's
   * null-on-zero rule exists to cover — a real `cost_usd_estimated = 0` row, which
   * the read path preserves as `0` rather than collapsing to null (an absent row
   * is what "unpriced" looks like). Pass a positive number for a priced control.
   */
  costUsd?: number;
};

/**
 * Block until the launched app has migrated the Branches schema into its store —
 * a cross-process read of `sqlite_master` (reading the app's committed schema
 * across processes is reliable; only the reverse — the running app observing a
 * test-process write — is not, which is why seeding happens with the app DOWN).
 * Call while the app is UP so the caller knows migrations finished before it
 * closes the app to seed.
 */
export async function waitForBranchesSchema(
  userDataDir: string,
  timeoutMs = 30_000
): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopBusyTimeout(client);
    await waitForBranchSchema(client, timeoutMs);
  } finally {
    client.close();
  }
}

/**
 * Seed a MERGED, single-PR, LOC-un-enriched branch straight into the launched
 * app's SQLite store, so the app's real `getSharedBranchAnalytics` projection
 * medians it in as size 0 (FEA-2159). Polls for the migrated schema first (the
 * db host migrates async after launch), then inserts the four rows in one
 * FK-ordered batch.
 */
export async function seedMergedUnenrichedSinglePrBranch(
  userDataDir: string,
  seed: MergedUnenrichedBranchSeed,
  options: {
    schemaTimeoutMs?: number;
    /**
     * The seeded session's `last_activity_at` (retention age anchor). Defaults to
     * "now" so the session survives the boot retention sweep; override only to
     * exercise retention behavior.
     */
    sessionLastActivityAt?: string;
    /**
     * ISS-4899: also seed a `kind='pull_request'` ARTIFACT plus a `created`
     * link, so the SESSION-side read surfaces the PR.
     *
     * The `pull_requests` table row this helper always writes feeds the BRANCHES
     * read; it does NOT feed a session's `prs`. `sync-source.ts` builds its
     * `pullRequestRows` from `session_artifact_links` joined to
     * `artifacts WHERE kind='pull_request' AND pr_number IS NOT NULL` and a
     * `created`/`workspace` relation (or a `harness_pr_link` method) — the
     * `pull_requests` table is consulted only for merged/closed lifecycle
     * enrichment. Without this artifact the session-detail "Pull requests" row
     * renders "None".
     *
     * Defaults to false so the FEA-2159 median-PR-size corpus (which requires NO
     * `kind='pull_request'` artifact for its LOC fallback to stay null) is
     * unchanged.
     */
    linkPullRequestArtifact?: boolean;
    /**
     * ISS-5617: also seed a `kind='closedloop_artifact'` ARTIFACT carrying this
     * SLUG, plus its `session_artifact_links` row — the local shape the desktop
     * detail read folds into `artifactRefs` and `projectLocalLinkedArtifacts`
     * turns into the Properties pane's "Linked artifacts" pills.
     *
     * The slug must carry a DOCUMENT-typed prefix (`ISS-`/`FEA-`/`PRD-`/`PLN-`/
     * `DOC-`). `projectLocalLinkedArtifacts` drops any ref whose prefix does not
     * name a DocumentType (`PRO-`/`WRK-`/`SES-`), matching what the cloud keeps,
     * so a `WRK-1` here would seed a link that correctly renders no pill.
     *
     * Undefined by default: every other caller of this helper asserts on a
     * corpus with no document links, and one appearing unbidden would change the
     * row inventory those specs pin.
     */
    linkClosedloopArtifactSlug?: string;
  } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForBranchSchema(client, options.schemaTimeoutMs ?? 30_000);

    const artifactId = branchArtifactId(seed.sessionId);
    const now = seed.mergedAt;
    // The session's `last_activity_at` is the retention sweep's age anchor
    // (`sweepExpiredSessions` deletes terminal sessions whose last activity
    // predates the 90-day window, cascading its links + PR rows). Stamp it to a
    // RECENT instant so the seeded session survives the boot retention sweep;
    // this is independent of the branch's own `lastActivityAt` (which the read
    // derives from the PR's merge instant), so the branch still reads as merged.
    const sessionLastActivity =
      options.sessionLastActivityAt ?? new Date().toISOString();
    // One atomic batch, FK-ordered (sessions → events/artifacts → link → pull_requests).
    // The branch artifact's lines_* are NULL (un-enriched) and there is NO
    // kind='pull_request' artifact, so the read's PR-LOC fallback is also null —
    // the branch is fully un-enriched, the exact FEA-2159 corpus. The synthetic
    // PreToolUse row makes the session substantive under the shared FEA-3284
    // quality gate, matching a real agent run without affecting branch LOC.
    await client.batch(
      [
        {
          sql: `INSERT INTO sessions
                  (id, status, started_at, ended_at, updated_at,
                   last_activity_at, data_revision)
                VALUES (?, 'completed', ?, ?, ?, ?, 1)`,
          args: [
            seed.sessionId,
            seed.mergedAt,
            seed.mergedAt,
            seed.mergedAt,
            sessionLastActivity,
          ],
        },
        substantiveToolEventBatchItem(seed.sessionId, now),
        {
          sql: `INSERT INTO artifacts
                  (id, identity_key, kind, repo_full_name, branch_name,
                   lines_added, lines_removed, files_changed,
                   created_at, last_seen_at, observed_at)
                VALUES (?, ?, 'branch', ?, ?,
                        NULL, NULL, NULL,
                        ?, ?, ?)`,
          args: [
            artifactId,
            `branch:${seed.repoFullName}:${seed.branchName}`,
            seed.repoFullName,
            seed.branchName,
            now,
            now,
            now,
          ],
        },
        {
          // FEA-2531: `git_push` (write + push evidence) so the seeded branch
          // passes the new Branches display gate and the E2E screen stays
          // populated. `seeded` (a non-write method) would now be hidden.
          sql: `INSERT INTO session_artifact_links
                  (id, session_id, artifact_id, relation, method, evidence,
                   is_primary, status, extractor_version, observed_at, created_at)
                VALUES (?, ?, ?, 'authored', 'git_push', '{}',
                        1, 'confirmed', 1, ?, ?)`,
          args: [
            `link-${seed.sessionId}`,
            seed.sessionId,
            artifactId,
            now,
            now,
          ],
        },
        {
          sql: `INSERT INTO pull_requests
                  (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
                   state, closed_at, merged_at, title, observed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?,
                        'closed', ?, ?, ?, ?, ?)`,
          args: [
            `pr-${seed.sessionId}`,
            seed.sessionId,
            `https://github.com/${seed.repoFullName}/pull/${seed.prNumber}`,
            seed.prNumber,
            seed.repoFullName,
            seed.branchName,
            seed.mergedAt,
            seed.mergedAt,
            `Seeded merged PR #${seed.prNumber}`,
            now,
            now,
          ],
        },
        ...(options.linkPullRequestArtifact
          ? pullRequestArtifactBatchItems(seed, now)
          : []),
        ...(options.linkClosedloopArtifactSlug
          ? closedloopArtifactBatchItems(
              seed,
              now,
              options.linkClosedloopArtifactSlug
            )
          : []),
      ],
      "write"
    );

    // Fold the committed rows out of the -wal into the main db file so a later
    // launch reads them straight from the main db, independent of any -wal the
    // prior launch left behind.
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * Seed a branch artifact that has no `pull_requests` row. The Branches list
 * should still project it from the real local DB path because the durable branch
 * identity is `sessions` -> `session_artifact_links` -> `artifacts(kind='branch')`.
 */
export async function seedNoPullRequestBranch(
  userDataDir: string,
  seed: NoPullRequestBranchSeed,
  options: {
    /** Optional canonical write relation for lifecycle-phase test evidence. */
    branchRelation?: ArtifactRefRelation;
    schemaTimeoutMs?: number;
    /**
     * Retention-sweep anchor. Defaults to "now" so a deliberately old
     * `activityAt` remains visible after the next desktop boot.
     */
    sessionLastActivityAt?: string;
  } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForBranchSchema(client, options.schemaTimeoutMs ?? 30_000);

    const artifactId = branchArtifactId(seed.sessionId);
    const now = new Date().toISOString();
    const sessionLastActivity = options.sessionLastActivityAt ?? now;

    // FK-ordered batch with NO `pull_requests` insert and NO pull_request
    // artifact. This is the net-new local branch corpus FEA-2528 covers. The
    // synthetic PreToolUse row keeps the seeded session visible under the
    // default substantive-session quality gate.
    await client.batch(
      [
        {
          sql: `INSERT INTO sessions
                  (id, status, started_at, ended_at, updated_at,
                   last_activity_at, data_revision)
                VALUES (?, 'completed', ?, ?, ?, ?, 1)`,
          args: [
            seed.sessionId,
            seed.activityAt,
            seed.activityAt,
            seed.activityAt,
            sessionLastActivity,
          ],
        },
        substantiveToolEventBatchItem(seed.sessionId, now),
        {
          sql: `INSERT INTO artifacts
                  (id, identity_key, kind, repo_full_name, branch_name,
                   created_at, last_seen_at, observed_at)
                VALUES (?, ?, 'branch', ?, ?,
                        ?, ?, ?)`,
          args: [
            artifactId,
            `branch:${seed.repoFullName}:${seed.branchName}`,
            seed.repoFullName,
            seed.branchName,
            now,
            now,
            now,
          ],
        },
        {
          // FEA-2531: `git_push` (write + push evidence) so this net-new local
          // branch passes the new Branches display gate (a non-write `seeded`
          // method would now be hidden).
          sql: `INSERT INTO session_artifact_links
                  (id, session_id, artifact_id, relation, method, evidence,
                   is_primary, status, extractor_version, observed_at, created_at)
                VALUES (?, ?, ?, ?, 'git_push', ?,
                        1, 'confirmed', 1, ?, ?)`,
          args: [
            `link-${seed.sessionId}`,
            seed.sessionId,
            artifactId,
            options.branchRelation ?? "authored",
            seed.canonicalActivityEvidenceJson ?? "{}",
            now,
            now,
          ],
        },
        // ISS-4737: the captured-cost row, only when the caller asked for one.
        // `0` is a deliberate value here, NOT "no cost" — hence the explicit
        // undefined check rather than a truthiness test, which would silently
        // drop exactly the priced-zero case the spend rule is about.
        ...(seed.costUsd === undefined
          ? []
          : [pricedTokenUsageBatchItem(seed.sessionId, seed.costUsd)]),
      ],
      "write"
    );

    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

export type SessionListSeed = {
  /** The `sessions.id` — the row's detail-nav target and label fallback. */
  sessionId: string;
  /**
   * Visible row label in the Sessions list / Insights table. When omitted the
   * `name` column is NULL and the list falls back to rendering `sessionId`
   * (see `session-table-row.ts`: `name ?? externalSessionId`).
   */
  name?: string;
  /** Session lifecycle status (defaults to `completed`). */
  status?: string;
  /** `started_at` / `ended_at` / `updated_at` instant (defaults to now). */
  at?: string;
  /**
   * ISS-5131: `ended_at` on its own, when it must differ from `started_at`.
   * Defaults to `at`, so every existing seed is byte-unchanged. The Duration a
   * terminal session renders is `ended_at - started_at`, so a spec asserting a
   * non-zero Duration has to set this.
   *
   * ISS-5818: pass an explicit `null` for a session that has NOT ended — the
   * Waiting projection requires it, and `undefined` still means "same as `at`"
   * so every existing seed is byte-unchanged.
   */
  endedAt?: string | null;
  /**
   * `last_activity_at` — the Sessions read's default-window filter AND the
   * retention sweep's age anchor. Defaults to "now" so the row is in-window on
   * every range and survives the boot retention sweep (which deletes terminal
   * sessions whose last activity predates the 90-day window).
   */
  lastActivityAt?: string;
  /**
   * ISS-5575: `updated_at` on its own. Defaults to `at`, so every existing seed
   * is byte-unchanged.
   *
   * It is the BOOT STALE SWEEP's anchor, not a display field: an `active` row
   * whose `updated_at` predates `DEFAULT_STALE_SESSION_MINUTES` is reaped to
   * `inactive` with `ended_at = last_activity_at` before the renderer ever reads
   * it. A spec that needs a LIVE `active` row with ancient activity — a
   * cloud-synced session the reaper has not caught, which is the whole
   * population the display staleness fold exists for — has to keep this recent
   * while `lastActivityAt` stays old.
   */
  updatedAt?: string;
  /**
   * ISS-5818: `awaiting_input_since` — the desktop's ONLY encoding of "blocked
   * on the user". `waiting` is display vocabulary and is never persisted as a
   * status (root `AGENTS.md`), so a spec asserting the Waiting badge has to seed
   * this timestamp on a NON-terminal row with `endedAt` cleared. Defaults to
   * NULL, so every existing seed is byte-unchanged.
   */
  awaitingInputSince?: string | null;
  /**
   * FEA-3343 / FEA-3284: seed a genuinely IDLE (0-turn / 0-token) session — the
   * "phantom" row the default `quality=substantive` list hides. Defaults to
   * false: seeded sessions are SUBSTANTIVE so they appear on the default
   * surface. Only set this to assert the hide/reveal behavior itself.
   */
  idle?: boolean;
  /**
   * FEA-4299: the session's working directory. The Repository facet resolves the
   * row's repo identity LIVE from this path first (`git remote get-url origin`),
   * falling back to the stored `repoFullName` when the live lookup fails (a
   * deleted/non-git worktree). Point this at a real temp git repo to exercise
   * live resolution, or at a missing path to exercise the stored fallback.
   * Defaults to NULL (no cwd → no live resolution).
   */
  cwd?: string | null;
  /**
   * FEA-4299 / FEA-3555: the durable stored `repo_full_name` write-back cache
   * value. Used as the Repository-facet identity ONLY when the live `cwd`
   * resolution yields no remote (e.g. a deleted worktree). Defaults to NULL.
   */
  repoFullName?: string | null;
  /**
   * ISS-4481: the stored `cost_usd_estimated` rollup. A positive value makes a
   * (substantive) row a KNOWN priced cost that the Cost → Unknown filter must
   * EXCLUDE; the default NULL leaves a worked row cost-Unavailable and an idle
   * row cost-Unknown (both render "—"). Set this to seed a priced row for the
   * Unknown-filter exclusion assertion.
   */
  estimatedCost?: number | null;
  /**
   * ISS-4481: the stored `billing_mode`. A subscription mode keeps a $0 cost a
   * KNOWN "$0.00" (Cost → Unknown must exclude it) for a WORKED row; NULL (the
   * default) leaves a non-subscription session's $0 cost Unknown.
   */
  billingMode?: string | null;
  /**
   * ISS-4902: an ISO instant for a SECOND synthetic tool event, on top of the
   * one stamped at `at`.
   *
   * This is the ONE lever that moves the PROJECTED `lastActivityAt`. The desktop
   * read does NOT project the `sessions.last_activity_at` column — `sync-source.ts`
   * re-derives the field per row as `max(started_at, max(events.created_at))`,
   * so a `lastActivityAt` seed alone leaves the projected value pinned to `at`
   * and any surface deriving a span from it (the session-detail timeline axis,
   * whose end is `resolveSessionDurationEnd`/`resolveSessionTimelineAxisEnd`
   * over that projected value) collapses to a 0-length window.
   *
   * Seed this at the instant the session's activity really ends to give the
   * detail a non-degenerate calendar span. The column-level `lastActivityAt`
   * remains a separate lever (the list date-window filter + the retention
   * sweep's age anchor) and should normally be set to the same instant.
   * Defaults to undefined (one event, at `at`).
   */
  activityEventAt?: string;
  /**
   * ISS-4675: an ISO instant written into `sessions.metadata.messages` as a
   * single assistant turn.
   *
   * This is the ONE lever that makes a seeded row's `wallClock` DIFFER from the
   * timestamp span the Sessions list would otherwise derive. The collector's
   * wall window is `startedAt → max(activity)` where activity includes
   * `metadata.messages` timestamps (`session-trace.ts`
   * `buildTraceTimelineRows`), so a message here extends `wallClock` to
   * `at → traceMessageAt`. Nothing else the row exposes moves with it.
   *
   * Pair it with `lastActivityAt: <the same value as `at`>` to make the
   * divergence total: the row's own start→last-activity span is then 0, so the
   * pre-ISS-4631 calendar derivation renders "0s" while the collector headline
   * renders the real span. That asymmetry is exactly the ISS-4631 divergence.
   * Defaults to undefined (`metadata` NULL, `wallClock` = the calendar span).
   */
  traceMessageAt?: string;
  /**
   * ISS-5820: the FEA-3419 cache-write TTL subdivision this session reported.
   * Rides the same `token_usage` row `estimatedCost` writes, so it only applies
   * when `estimatedCost` is set. Defaults to undefined — both columns NULL, the
   * "never reported" case in which `CacheWriteTtlProperty` renders nothing, so
   * every existing seed is byte-unchanged.
   *
   * A spec asserting the Cache Write row on the Electron adapter MUST set this:
   * without it the row is absent because the session has no split to show, and
   * a Cache-Write assertion would pass or fail for a reason that has nothing to
   * do with whether the SQLite → IPC projection carries the columns.
   */
  cacheWriteTtlSplit?: CacheWriteTtlSplitSeed;
};

/** The two ephemeral cache-creation buckets a seeded session reports. */
export type CacheWriteTtlSplitSeed = {
  ephemeral1h: number;
  ephemeral5m: number;
};

/**
 * Seed `sessions` rows straight into the launched app's SQLite store so the real
 * Sessions list (and the Insights bounded table) projects them — WITHOUT the
 * transcript importer, whose read-your-writes WAL race quarantined
 * `sessions-flow.spec.ts` (FEA-2187). Unlike Branches, the Sessions read path
 * projects the `sessions` table directly (no artifact/link join). Seeds while the
 * app is DOWN (no cross-process WAL contention), then checkpoints so the next
 * boot reads the rows from the main db file.
 *
 * A bare row is NOT enough to appear. Since FEA-3284 the list read defaults to
 * `quality=substantive` (`shared-agent-sessions-api.ts` `sanitizeQuery`) and
 * drops any session that is not `isSubstantiveSession`, whose signals are derived
 * from the hydrated session (`sessionIsSubstantive`) rather than from `sessions`
 * columns. So each seeded session is given a synthetic `PreToolUse` tool event
 * (FEA-1421, #2938), which the read counts as `toolUseCount > 0`.
 *
 * Pass `idle: true` to make a row a genuine phantom session: it withholds BOTH
 * substantive signals, so the row stays 0-turn / 0-tool and renders with the
 * canonical `IdleConcept.PhantomSession` badge — the case
 * `sessions-idle-badge.spec.ts` pins. (Since FEA-4194 reverted the quality
 * segment the default list no longer HIDES idle rows; it shows them, badged.)
 */
export async function seedSessionsList(
  userDataDir: string,
  sessions: SessionListSeed[],
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForBranchSchema(client, options.schemaTimeoutMs ?? 30_000);

    const now = new Date().toISOString();
    const batchItems = sessions.flatMap((session) => {
      const at = session.at ?? now;
      const row = sessionRowBatchItem(session, at, now);
      // An idle seed must withhold EVERY substantive signal, not just one:
      // `isSubstantiveSession` ORs turns/tokens/toolUse, so leaving the tool
      // event in place would make the "idle" row substantive anyway and the
      // idle-badge assertion in sessions-idle-badge.spec.ts would silently pass
      // for the wrong reason.
      if (session.idle) {
        return [row];
      }
      const items = [row, substantiveToolEventBatchItem(session.sessionId, at)];
      // ISS-4902: a second tool event at the session's real end instant. The
      // projected `lastActivityAt` is `max(started_at, max(events.created_at))`
      // (sync-source.ts), NOT the seeded column, so this is what gives the
      // detail's timeline axis a non-zero calendar span.
      if (session.activityEventAt) {
        items.push(
          substantiveToolEventBatchItem(
            session.sessionId,
            session.activityEventAt,
            "activity-end"
          )
        );
      }
      // ISS-4675: extend the collector's observed wall window past the row
      // timestamps without moving the projected `lastActivityAt`.
      if (session.traceMessageAt) {
        items.push(
          traceMessageMetadataBatchItem(
            session.sessionId,
            session.traceMessageAt
          )
        );
      }
      // ISS-4481: a priced (KNOWN-cost) row. The Sessions cost filter sums cost
      // from `token_usage` (`sumTokenUsage`), NOT the `sessions.cost_usd_estimated`
      // column, so a priced fixture needs a token_usage row carrying the cost.
      if (
        session.estimatedCost !== undefined &&
        session.estimatedCost !== null
      ) {
        items.push(
          pricedTokenUsageBatchItem(
            session.sessionId,
            session.estimatedCost,
            session.cacheWriteTtlSplit
          )
        );
      }
      return items;
    });
    await client.batch(batchItems, "write");

    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * Poll until the launched app has FULLY migrated the store.
 *
 * The db host runs migrations asynchronously after launch, so the file — and any
 * individual table or column — can be visible while later migrations are still
 * pending. This wait deliberately holds for the whole migration history rather
 * than for the specific tables/columns the Branches read path names: the seeders
 * that ride this barrier write columns from all over the history (e.g.
 * `sessions.repo_full_name`, added in `0029`, long after `sessions` itself in
 * `0001` and `sessions.last_activity_at` in `0005`), and its callers close the
 * app immediately afterwards to seed — which freezes the schema wherever the
 * migration chain happened to be. See `waitForMigrationsApplied`.
 */
async function waitForBranchSchema(
  client: ReturnType<typeof createClient>,
  timeoutMs: number
): Promise<void> {
  await waitForMigrationsApplied(client, timeoutMs);
}

export function substantiveToolEventBatchItem(
  sessionId: string,
  observedAt: string,
  /**
   * Discriminator for the row id so a session can carry more than one seeded
   * event (`events.id` is the primary key). Defaults to the original single-row
   * id so every existing caller keeps writing the same row.
   */
  slot = "substantive"
): { sql: string; args: string[] } {
  return {
    sql: `INSERT INTO events
            (id, session_id, event_type, tool_name, summary, created_at)
          VALUES (?, ?, 'PreToolUse', 'SeedTool', 'Seeded substantive tool invocation', ?)`,
    args: [`event-${slot}-${sessionId}`, sessionId, observedAt],
  };
}

/**
 * ISS-4481: a `token_usage` row carrying a positive estimated cost, so the
 * Sessions cost filter (`sumTokenUsage` over `token_usage`) reads the session as
 * a KNOWN priced cost. Also makes the row substantive (tokens > 0). The tokens
 * are nominal (the filter buckets on the cost, not the tokens).
 */
export function pricedTokenUsageBatchItem(
  sessionId: string,
  estimatedCost: number,
  /**
   * ISS-5820: the FEA-3419 cache-write TTL subdivision. Omitted (the default)
   * leaves both columns NULL — "breakdown never reported" — which is what every
   * existing caller wrote and what makes `CacheWriteTtlProperty` self-suppress.
   * Supply it to seed a session that DID report the split, so the Cache Write
   * row has something to render.
   */
  cacheWriteTtlSplit?: CacheWriteTtlSplitSeed
): { sql: string; args: Array<string | number | null> } {
  return {
    sql: `INSERT INTO token_usage
            (session_id, model, input_tokens, output_tokens, cost_usd_estimated,
             cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
          VALUES (?, 'seed-model', 1000, 500, ?, ?, ?, ?)`,
    args: [
      sessionId,
      estimatedCost,
      cacheWriteTtlSplit
        ? cacheWriteTtlSplit.ephemeral5m + cacheWriteTtlSplit.ephemeral1h
        : 0,
      cacheWriteTtlSplit?.ephemeral5m ?? null,
      cacheWriteTtlSplit?.ephemeral1h ?? null,
    ],
  };
}

/**
 * ISS-4675: stamp a single assistant turn into `sessions.metadata.messages` at
 * `traceMessageAt`.
 *
 * `buildTraceTimelineRows` (`apps/desktop/src/main/database/session-trace.ts`)
 * keeps a metadata message only when it carries BOTH a `timestamp` and a
 * `role`, so both are written; `model` supplies the row label. The resulting
 * timeline row extends the collector's observed wall window — and therefore the
 * derived `wallClock` — past the row's own timestamps, which is the whole point
 * of the fixture (see {@link SessionListSeed.traceMessageAt}).
 */
function traceMessageMetadataBatchItem(
  sessionId: string,
  traceMessageAt: string
): { sql: string; args: Array<string | number> } {
  return {
    sql: "UPDATE sessions SET metadata = ? WHERE id = ?",
    args: [
      JSON.stringify({
        messages: [
          { model: "seed-model", role: "assistant", timestamp: traceMessageAt },
        ],
      }),
      sessionId,
    ],
  };
}

/** Real tables the Plans read path (`listPlans`) projects from. */
const PLANS_REQUIRED_TABLES = ["plans", "plan_versions"] as const;

export type PlanListSeed = {
  /** The `plans.id` — stable row identity. */
  id: string;
  /** Visible plan title in the Plans list (the `PlanListButton` label). */
  title: string;
  /**
   * The single `plan_versions` row's markdown body. `listPlans` includes the
   * latest version (`versionCount = 1`), and the shell renders the title from
   * the plan row; the content only matters if the detail pane is opened.
   */
  markdown?: string;
  /** `updated_at` instant (Plans are ordered `updated_at DESC`). Defaults to now. */
  updatedAt?: string;
};

/**
 * Seed `plans` + `plan_versions` rows straight into the launched app's SQLite
 * store so the real Plans view (`PlansView` → `listPlans`) projects them.
 *
 * ISS-4527 review (shafty023): `PlansView` reads `db.getPlansList()` from the
 * SQLite `plans`/`plan_versions` tables — it is NOT a config-only view. Keeping
 * it in the smoke's HEALTH_ONLY set exercised only the same EMPTY path the
 * original all-views smoke already covers. Seeding a plan makes the seeded smoke
 * assert Plans left its "No plans captured yet" empty state and rendered the
 * seeded title, closing the same gap it closes for the other data-backed views.
 *
 * `listPlans` applies no substantive/quality filter and no date window, so a
 * bare plan row with one version renders — no synthetic tool event is needed
 * (unlike `seedSessionsList`). Seeds while the app is DOWN, then checkpoints so
 * the next boot reads the rows from the main db file.
 */
export async function seedPlansList(
  userDataDir: string,
  plans: PlanListSeed[],
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForTablesPresent(
      client,
      PLANS_REQUIRED_TABLES,
      options.schemaTimeoutMs ?? 30_000
    );

    const now = new Date().toISOString();
    const batchItems = plans.flatMap((plan) => {
      const updatedAt = plan.updatedAt ?? now;
      return [
        {
          sql: `INSERT INTO plans
                  (id, title, status, harness, plan_key, needs_confirmation,
                   confidence, capture_method, created_at, updated_at)
                VALUES (?, ?, 'active', 'claude', ?, 0, 1.0, 'extractor', ?, ?)`,
          args: [plan.id, plan.title, `key-${plan.id}`, updatedAt, updatedAt],
        },
        {
          sql: `INSERT INTO plan_versions
                  (id, plan_id, version_number, content_markdown,
                   content_sha256, author_type, capture_method, created_at)
                VALUES (?, ?, 1, ?, ?, 'agent', 'hook', ?)`,
          args: [
            `${plan.id}-v1`,
            plan.id,
            plan.markdown ?? `${plan.title} body`,
            `sha-${plan.id}-v1`,
            updatedAt,
          ],
        },
      ];
    });
    await client.batch(batchItems, "write");

    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * ISS-4714: a fictional migration name recorded as applied that no shipped build
 * includes — its `9999_` prefix sorts after every real migration, so the boot
 * forward-guard classifies it as the DB-ahead (Downgrade) refusal (a store
 * created by a NEWER Desktop build), never a checksum-drift or history-gap.
 */
export const FUTURE_MIGRATION_NAME = "9999_from_the_future";

/**
 * ISS-4714 (wongk/codex review): seed the DB-AHEAD-of-app condition into an
 * already-migrated store while the app is DOWN, so the NEXT launch's migration
 * runner refuses to open the DB and the renderer surfaces the "update required"
 * banner. Insert one fictional future `_desktop_migrations` row (all the REAL
 * migrations are already recorded from the first launch, so this lone extra
 * applied-but-unknown migration is exactly the forward-guard's Downgrade case).
 *
 * Waits for the `_desktop_migrations` tracking table first (the db host migrates
 * asynchronously after launch), then writes the row and checkpoints the WAL so
 * the change is visible to the next launch's fresh connection.
 */
export async function seedFutureMigrationRow(
  userDataDir: string,
  timeoutMs = 30_000
): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopBusyTimeout(client);
    await waitForTablesPresent(client, ["_desktop_migrations"], timeoutMs);
    await client.execute({
      sql: `INSERT OR REPLACE INTO "_desktop_migrations" ("name", "checksum", "applied_at")
            VALUES (?, ?, ?)`,
      args: [FUTURE_MIGRATION_NAME, "f".repeat(64), new Date().toISOString()],
    });
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * ISS-4899: the `kind='pull_request'` artifact + `created` link a SESSION needs
 * before its detail renders a PR pill.
 *
 * `sync-source.ts` derives a session's `prs` from `session_artifact_links` joined
 * to `artifacts WHERE kind='pull_request' AND pr_number IS NOT NULL`, gated on a
 * `created`/`workspace` relation or a `harness_pr_link` method — never from the
 * `pull_requests` table, which it reads only for merged/closed lifecycle facts.
 * `method='harness_pr_link'` is the real observation shape for a PR the harness
 * opened, and it satisfies the gate from both sides.
 *
 * `pr_state` is what the pill's status word is derived from; `lines_*` are left
 * NULL so the artifact stays LOC-un-enriched like its branch sibling.
 */
function pullRequestArtifactBatchItems(
  seed: MergedUnenrichedBranchSeed,
  observedAt: string
): Array<{ sql: string; args: Array<string | number> }> {
  const artifactId = `artifact-pr-${seed.sessionId}`;
  return [
    {
      sql: `INSERT INTO artifacts
              (id, identity_key, kind, repo_full_name, branch_name, pr_number,
               pr_state, url, title, lines_added, lines_removed, files_changed,
               created_at, last_seen_at, observed_at)
            VALUES (?, ?, 'pull_request', ?, ?, ?,
                    'merged', ?, ?, NULL, NULL, NULL,
                    ?, ?, ?)`,
      args: [
        artifactId,
        `pull_request:${seed.repoFullName}:${seed.prNumber}`,
        seed.repoFullName,
        seed.branchName,
        seed.prNumber,
        `https://github.com/${seed.repoFullName}/pull/${seed.prNumber}`,
        `Seeded merged PR #${seed.prNumber}`,
        observedAt,
        observedAt,
        observedAt,
      ],
    },
    {
      sql: `INSERT INTO session_artifact_links
              (id, session_id, artifact_id, relation, method, evidence,
               is_primary, status, extractor_version, observed_at, created_at)
            VALUES (?, ?, ?, 'created', 'harness_pr_link', '{}',
                    0, 'confirmed', 1, ?, ?)`,
      args: [
        `link-pr-${seed.sessionId}`,
        seed.sessionId,
        artifactId,
        observedAt,
        observedAt,
      ],
    },
  ];
}

/** A `pull_request` artifact link to attach to an already-seeded session. */
export type SessionPrLinkSeed = {
  /** The `sessions.id` the link hangs off (seed the row with `seedSessionsList`). */
  sessionId: string;
  repoFullName: string;
  prNumber: number;
  /**
   * `session_artifact_links.relation`. `referenced` / `reviewed` are the
   * NON-authoring relations the ISS-4922 Local Authored gate suppresses;
   * `created` is the authoring relation it always keeps.
   */
  relation: "created" | "referenced" | "reviewed";
  /** Detection method recorded on the link (defaults to a prose URL match). */
  method?: string;
};

/**
 * ISS-4922: attach `pull_request` artifact links to sessions already seeded by
 * {@link seedSessionsList}, so the Local lane hydrates real `prRefs` and the
 * session-detail "Pull requests" row renders real pills.
 *
 * Writes the same two rows the live importer writes — an `artifacts` row keyed
 * `pr:<repo>:<number>` and the pure-join `session_artifact_links` row carrying
 * the relation — so the app's own projection (`sync-source.ts`, which maps a
 * `target_kind === "pull_request"` link into a `SyncedSessionPrRef`) runs over
 * them with no test-only path.
 */
export async function seedSessionPullRequestLinks(
  userDataDir: string,
  links: SessionPrLinkSeed[],
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForBranchSchema(client, options.schemaTimeoutMs ?? 30_000);

    const now = new Date().toISOString();
    const batchItems = links.flatMap((link) => {
      const identityKey = `pr:${link.repoFullName}:${link.prNumber}`;
      const artifactId = `artifact-pr-${link.repoFullName.replace("/", "-")}-${link.prNumber}`;
      return [
        {
          sql: `INSERT OR IGNORE INTO artifacts
                  (id, identity_key, kind, repo_full_name, pr_number, url, title,
                   created_at, last_seen_at, observed_at)
                VALUES (?, ?, 'pull_request', ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            artifactId,
            identityKey,
            link.repoFullName,
            link.prNumber,
            `https://github.com/${link.repoFullName}/pull/${link.prNumber}`,
            `Seeded PR #${link.prNumber}`,
            now,
            now,
            now,
          ],
        },
        {
          sql: `INSERT INTO session_artifact_links
                  (id, session_id, artifact_id, relation, method, evidence,
                   is_primary, status, extractor_version, observed_at, created_at)
                VALUES (?, ?, ?, ?, ?, '{}', 0, 'confirmed', 1, ?, ?)`,
          args: [
            `link-pr-${link.sessionId}-${link.prNumber}`,
            link.sessionId,
            artifactId,
            link.relation,
            link.method ?? "url_in_message",
            now,
            now,
          ],
        },
      ];
    });
    await client.batch(batchItems, "write");
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * The `sessions` INSERT for one seed. Extracted from the flatMap body so that
 * loop stays under Biome's cognitive-complexity ceiling — the per-column
 * defaulting is the bulk of its score and none of its branching.
 */
function sessionRowBatchItem(
  session: SessionListSeed,
  at: string,
  now: string
) {
  return {
    sql: `INSERT INTO sessions
            (id, name, status, started_at, ended_at, updated_at,
             last_activity_at, awaiting_input_since, cwd, repo_full_name,
             cost_usd_estimated, billing_mode, data_revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    args: [
      session.sessionId,
      session.name ?? null,
      // ISS-5592: `completed` is unrecognized now and badges "Active"; the
      // default must be the recognized terminal value ~30 specs assume.
      session.status ?? "inactive",
      at,
      session.endedAt === undefined ? at : session.endedAt,
      session.updatedAt ?? at,
      session.lastActivityAt ?? now,
      session.awaitingInputSince ?? null,
      session.cwd ?? null,
      session.repoFullName ?? null,
      session.estimatedCost ?? null,
      session.billingMode ?? null,
    ],
  };
}
