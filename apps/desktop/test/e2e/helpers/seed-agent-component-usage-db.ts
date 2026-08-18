/**
 * Direct SQLite seeding for the desktop AGENT-COMPONENT INVENTORY LIST E2E
 * specs — the corpus with real per-row usage aggregates that
 * `seed-agent-components-db.ts` deliberately cannot produce.
 *
 * WHY A SECOND AGENT-COMPONENT SEEDER (ISS-5364)
 * ----------------------------------------------
 * `seed-agent-components-db.ts` (ISS-5029) seeds ONE `agent_components` row and
 * states in its own docstring that it writes NO `agent_component_session_usage`
 * rows, because the DETAIL page it exists for is gated only on the component's
 * kind and captured `content`. The LIST is not: every per-row aggregate the
 * Agents inventory renders — `invocations`, `sessions`, and `locPerDollar` —
 * is derived from usage, so against that corpus every row on the desktop
 * inventory reads `0 / 0 / —`. A list-level assertion written over identical
 * rows is an assertion that cannot fail.
 *
 * THE TWO PREDICATES A NAIVE USAGE SEED SILENTLY FAILS
 * ---------------------------------------------------
 * Writing `agent_component_session_usage` rows alone is NOT enough to put a
 * `locPerDollar` on screen, and the reason is not visible from the usage table:
 *
 *  1. `locPerDollarForKind` (`src/main/dashboard/shared-agent-components-api.ts`)
 *     returns null for any kind outside `isLocPerDollarVerifiableKind`, which
 *     today is `subagent` ALONE. A `skill`/`command` row can carry a thousand
 *     invocations and still render an em-dash in the Metric column.
 *  2. The LOC numerator is `sessionLocalGitLoc` (`src/main/session/
 *     session-loc-cost.ts`), i.e. `gitDiffStats` — and `gitDiffStats` is
 *     populated by `sync-source.ts`'s `gitLocRows` query, whose `authored_sessions`
 *     CTE requires the session to own at least one `session_artifact_links` row
 *     with `relation = 'created'` pointing at a `kind = 'commit'` artifact.
 *     BOTH of that query's lanes sit behind that gate, including the
 *     branch/PR-total fallback. So the existing
 *     `seedSessionDetailLocPerDollarBranch` corpus (a `kind='branch'` artifact
 *     and no commit) — which is enough for the SESSION-DETAIL ratio, because
 *     that one reads `sessionLocPerDollarNumeratorLoc`'s `max(gitLoc, branchLoc)`
 *     and `branchLocRows` is ungated — yields `gitDiffStats: undefined` here,
 *     `totalLoc = 0`, and `locPerDollarFromLines` returning null.
 *
 * So this module seeds an authored COMMIT artifact per session, not a branch
 * one, and defaults components to `subagent`. `agent-component-usage-read-path.test.ts`
 * executes {@link agentComponentUsageBatchItems} against an ephemeral migrated
 * store and reads the result back through the production
 * `listAgentComponentsLocal`, so the corpus is proven to survive the real read
 * predicates rather than merely to have been inserted.
 *
 * Substrate contract is `desktop-seed-core.ts`'s, unchanged: open a SECOND
 * `@libsql/client` connection on the app's own `agent-dashboard.sqlite` (the
 * same WAL-mode file, which supports multi-process access), apply the app's own
 * PRAGMAs, wait for the db host's asynchronous post-launch migration to finish,
 * write one FK-ordered batch, then checkpoint the WAL so a later launch reads
 * the rows straight from the main db file.
 */

import { createClient } from "@libsql/client";
import {
  applyDesktopSeedPragmas,
  branchesDbPath,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForMigrationsApplied,
} from "./desktop-seed-core";
import {
  pricedTokenUsageBatchItem,
  substantiveToolEventBatchItem,
} from "./seed-branches-db";

/**
 * One `{ sql, args }` statement, as `@libsql/client`'s `batch` consumes them.
 *
 * `null` is in the arg union deliberately: nullable columns are bound by value
 * (`agent_components.source_url` below), and `@libsql/client`'s own `InValue`
 * accepts null, so the type states what the seeder actually binds rather than
 * making call sites cast a real null away.
 */
export type SeedBatchItem = {
  sql: string;
  args: Array<string | number | null>;
};

/** An invoking session, and the authored churn + spend its LOC/$ divides. */
export type AgentComponentUsageSessionSeed = {
  /** `sessions.id`, and the `agent_component_session_usage.session_id` it is invoked from. */
  sessionId: string;
  /**
   * `sessions.name` — the session's DISPLAY name, and the only text a Sessions
   * grid row can be located by: the shared detail Sessions tab renders the
   * projected `row.name` directly, so a row seeded without one renders an EMPTY
   * name cell and no `getByText` can ever resolve it. Omit only when the seed
   * genuinely means "an unnamed session"; any spec that asserts a seeded row is
   * ON SCREEN must set it.
   */
  name?: string | null;
  /**
   * Authored COMMIT churn. Seeded onto a `kind='commit'` artifact linked
   * `relation='created'`, because that is the only shape `gitLocRows` accepts —
   * see the module docstring. `linesAdded + linesRemoved` is the LOC/$ numerator.
   */
  linesAdded: number;
  linesRemoved: number;
  filesChanged?: number;
  /** GitHub-style "owner/repo" for the commit artifact's identity. */
  repoFullName?: string;
  /**
   * The session's priced spend — the LOC/$ denominator. OMIT for the
   * "unavailable metric" control: with no `token_usage` row the summed cost is
   * 0 and `locPerDollarFromLines` returns null (never a fabricated 0), so the
   * component renders the Metric column's em-dash while still carrying real
   * invocation and session counts. Same explicit-undefined convention as
   * `seedSessionDetailLocPerDollarBranch`'s `costUsd`.
   */
  costUsd?: number;
};

/** One live inventory row plus the usage that gives it per-row aggregates. */
export type AgentComponentUsageComponentSeed = {
  /** `agent_components.id` — any stable local identity. */
  id: string;
  /**
   * `agent_components.component_kind`. Defaults to `subagent`, the ONLY kind
   * whose per-component LOC/$ attribution is verifiable — any other kind
   * renders the Metric em-dash regardless of the usage seeded below.
   */
  kind?: string;
  /**
   * `agent_components.component_key`, and the `component_key` every usage row
   * below is written with. Seed it already lowercase/trimmed: the usage
   * aggregate groups on SQL `lower(trim(...))` while the inventory folds on the
   * JS `normalizeComponentKey`, and only an already-normalized key is guaranteed
   * to land on the same identity under both.
   */
  key: string;
  /** Display name — what the Name lead renders and specs locate rows by. */
  name: string;
  /** `agent_components.harness`, e.g. `claude`. */
  harness?: string;
  /** `agent_components.source_url` — the repo/remote provenance. */
  sourceUrl?: string | null;
  /**
   * ISS-5534: `agent_components.pack_id` — the plugin this row belongs to.
   *
   * The ONLY way to seed a plugin whose `invocations` are a real child rollup.
   * `pluginUsageSql` (shared-agent-components-api.ts) sums
   * `agent_component_session_usage` over the CHILD rows whose `pack_id` is set
   * and whose kind is skill/command/subagent/mcp, groups by `pack_id`, and
   * `resolvePluginUsage` looks that map up under the plugin's own
   * `component_key` (a plugin's pack id equals its key). So the plugin row
   * itself seeds NO usage and sets no `packId`; its children set `packId` to the
   * plugin's `key`, and the plugin's rendered total is their sum — exactly the
   * production shape whose double-count the Invocations card removes.
   */
  packId?: string | null;
  /**
   * ISS-6180: `agent_components.uninstalled_at` — the TOMBSTONE the scanners
   * stamp instead of deleting the row (`mcp-discovery.ts`). A non-null value
   * takes the row out of live inventory, which is what makes it a plugin child
   * whose usage must NOT roll into its plugin's total while its `pack_id` is
   * still set. Defaults to null (live), so every pre-existing corpus is
   * unaffected.
   */
  uninstalledAt?: string | null;
  /**
   * Per-session invocation counts. An empty list is a legitimate seed (a row
   * with no usage at all), but note the desktop projection reports absent usage
   * as the NUMBER 0, never null, so it renders "0" and not an em-dash.
   */
  usage: readonly { sessionId: string; invocations: number }[];
};

/** A whole inventory corpus: the invoking sessions, and the rows that invoke them. */
export type AgentComponentUsageCorpus = {
  sessions: readonly AgentComponentUsageSessionSeed[];
  components: readonly AgentComponentUsageComponentSeed[];
};

/** The default kind — the only one whose LOC/$ is verifiable (FEA-4052). */
const VERIFIABLE_KIND = "subagent";

/**
 * The `agent_component_invocations` column values every seeded invocation row
 * carries, as STRING LITERALS.
 *
 * They are the members of `AgentComponentInvocationRelationship.Direct`,
 * `…AnchorKind.Timestamp`, `…AttributionStatus.Unresolved` and
 * `…EvidenceClass.None` in `@repo/api/src/types/agent-component-invocation`, and
 * they are pinned here for exactly the reason {@link SEEDED_DATA_REVISION} is:
 * this module is loaded by Playwright's Node ESM loader, where a deep
 * `@repo/api/src/...` specifier does not resolve and the whole desktop e2e suite
 * collapses to "No tests found". `agent-component-usage-read-path.test.ts` — a
 * node-runner test with no such constraint — imports the real constants and
 * asserts they equal these, so a rename fails there instead of silently seeding
 * an unrecognised value.
 *
 * `unresolved` + `none` is the pair production's own `baseCandidate` emits when
 * no definition evidence was captured, which is the truth about this corpus:
 * `agent_components.content_hash` is deliberately left NULL (see
 * {@link componentBatchItems}), so there is no definition to have evidenced.
 * Both values are also inert for the read path — the local invocation projection
 * only counts `unmatched` and `ambiguous` — so neither inflates a health readout.
 */
const INVOCATION_RELATIONSHIP = "direct";
const INVOCATION_ANCHOR_KIND = "timestamp";
const INVOCATION_ATTRIBUTION_STATUS = "unresolved";
const INVOCATION_EVIDENCE_CLASS = "none";

/**
 * The pinned literals above, exposed so the node-runner drift guard in
 * `agent-component-usage-read-path.test.ts` can compare them against the real
 * `@repo/api` enum members it CAN import. Returning them from a function (rather
 * than exporting the consts) keeps the pins private to this module's SQL.
 */
export function seededInvocationLiterals(): {
  anchorKind: string;
  attributionStatus: string;
  evidenceClass: string;
  relationship: string;
} {
  return {
    anchorKind: INVOCATION_ANCHOR_KIND,
    attributionStatus: INVOCATION_ATTRIBUTION_STATUS,
    evidenceClass: INVOCATION_EVIDENCE_CLASS,
    relationship: INVOCATION_RELATIONSHIP,
  };
}

const DEFAULT_REPO_FULL_NAME = "acme/seeded-repo";

const DEFAULT_HARNESS = "claude";

/**
 * The current `DATA_REVISION`, PINNED rather than imported — see the long note
 * on the `sessions` INSERT below for why the value matters at all.
 *
 * It cannot be imported here. `DATA_REVISION` lives in
 * `src/main/collectors/engine/data-revision.ts`, which imports
 * `src/main/database/db-constants.ts`, which imports
 * `@repo/api/src/types/session-artifact-link` WITHOUT a file extension — the
 * dominant convention across `src/main`. The desktop BUILD resolves that
 * (bundler resolution adds the extension), but Playwright loads specs through
 * Node's ESM loader, where `@repo/api`'s `exports` map performs no extension
 * resolution: the specifier simply does not resolve. Pulling that module into
 * the spec graph therefore does not fail one test — it fails COLLECTION, and the
 * entire desktop e2e suite reports "No tests found" (verified locally: 95 tests
 * in 70 files collect without the import, 0 with it).
 *
 * So the value is pinned, and `agent-component-usage-read-path.test.ts` — a
 * node-runner test with no such loader constraint — imports the real constant
 * and asserts it equals this one. A `DATA_REVISION` bump fails there, loudly and
 * with this file named, instead of silently returning the E2E corpus to the
 * empty-usage state the pin exists to prevent.
 */
export const SEEDED_DATA_REVISION = 78;

/**
 * Seed a multi-row component inventory WITH matching usage, invoking sessions,
 * authored-commit LOC and priced spend, straight into the launched app's real
 * SQLite store — so the app's own local IPC `AgentComponentsDataSource`
 * (`listAgentComponentsLocal`) projects rows carrying genuinely DIFFERENT
 * per-row aggregates.
 *
 * Called with the app DOWN, between two `launchDesktopApp` calls against one
 * `userDataDir`, exactly like every sibling seeder.
 */
export async function seedAgentComponentUsage(
  userDataDir: string,
  corpus: AgentComponentUsageCorpus,
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopSeedPragmas(client);
    // The COMPLETE migration barrier, not a table/column proxy: this corpus
    // spans `sessions`, `events`, `artifacts`, `session_artifact_links`,
    // `token_usage`, `agent_components` and `agent_component_session_usage`,
    // which land across widely separated migrations, and a proxy wait on an
    // early one silently under-waits (see `waitForMigrationsApplied`).
    await waitForMigrationsApplied(
      client,
      options.schemaTimeoutMs ?? SEED_SCHEMA_TIMEOUT_MS
    );

    await client.batch(
      agentComponentUsageBatchItems(corpus, new Date().toISOString()),
      "write"
    );

    // Fold the committed rows out of the -wal into the main db file so a later
    // launch reads them straight from the main db (same convention as every
    // other desktop seeder).
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * The whole corpus as one FK-ordered statement list.
 *
 * Exported separately from {@link seedAgentComponentUsage} so the read-path
 * regression (`agent-component-usage-read-path.test.ts`) can execute the exact
 * statements the E2E seeder writes against an ephemeral migrated store and read
 * them back through `listAgentComponentsLocal` — proving the corpus survives the
 * production predicates, not merely that the INSERTs succeeded.
 */
export function agentComponentUsageBatchItems(
  corpus: AgentComponentUsageCorpus,
  observedAt: string
): SeedBatchItem[] {
  const items: SeedBatchItem[] = [];
  for (const session of corpus.sessions) {
    items.push(...sessionBatchItems(session, observedAt));
  }
  for (const component of corpus.components) {
    items.push(...componentBatchItems(component, observedAt));
  }
  return items;
}

/**
 * The session, its substantive event, its authored commit artifact + link, and
 * (when priced) its `token_usage` row.
 */
function sessionBatchItems(
  seed: AgentComponentUsageSessionSeed,
  observedAt: string
): SeedBatchItem[] {
  const repoFullName = seed.repoFullName ?? DEFAULT_REPO_FULL_NAME;
  const artifactId = `artifact-commit-${seed.sessionId}`;
  // A synthetic 40-char sha: `artifacts.sha` is free-form text here, and only
  // the identity key has to be unique.
  //
  // The `#` terminator is load-bearing. Right-padding the bare id with "0" is
  // NOT injective over ids that differ only by a numeric suffix: `…session-1`
  // padded and `…session-10` padded both land on `…session-100000000000000`, so
  // the second one violates `artifacts.identity_key`'s UNIQUE constraint and the
  // whole seed batch fails. That needs ELEVEN sessions to surface, so a corpus
  // of a handful seeds cleanly and only a large one breaks. A terminator the pad
  // character can never produce keeps every distinct id on a distinct sha.
  const sha = `${seed.sessionId}#`.padEnd(40, "0").slice(0, 40);
  return [
    {
      // `data_revision` MUST be the CURRENT `DATA_REVISION`, not the literal `1`
      // every other desktop seeder writes. This is the only seeder that writes
      // `agent_component_session_usage`, and that rollup is exactly what boot
      // maintenance rematerializes:
      //
      //   `post-boot-maintenance.ts` runs the data-revision rebuild with
      //   `useStoredComponentInvocationRebuild: true`. The rebuild selects every
      //   session whose `data_revision !== DATA_REVISION`
      //   (`listStaleRevisionSessions`), and a seeded session is stale at `1`,
      //   terminal (`'completed'`), and has no transcript source and no
      //   `harness` — so it lands in `missingSourceIds` and flows into
      //   `rebuildAgentComponentSessionUsageFromInvocations`, which
      //   `DELETE`s `agent_component_session_usage` for those session ids and
      //   re-`INSERT`s them from `agent_component_invocations`. This corpus
      //   seeds NO invocation rows, so the delete lands and the insert restores
      //   nothing: every seeded usage row is gone moments after boot.
      //
      // The symptom is a detail page that resolves the component (its
      // `agent_components` row is untouched) yet reads `0 Sessions` with the
      // genuine "No sessions have invoked this component yet" empty state — an
      // empty page on which a truncation-ABSENCE assertion passes vacuously,
      // which is the false green `agent-detail-sessions-truncation.spec.ts`
      // exists to rule out. It is invisible to the in-process read-path test
      // (`agent-component-usage-read-path.test.ts`), which never boots the app,
      // and invisible to the sibling grid specs, which locate rows by the
      // component NAME and assert column alignment rather than any usage-derived
      // value.
      //
      // Stamping the current revision states the truth about this corpus: it is
      // already fully derived, so boot maintenance has nothing to re-derive and
      // leaves the seeded rollup alone. The value is pinned rather than imported
      // (and guarded against drift by a node test) — see
      // {@link SEEDED_DATA_REVISION}.
      sql: `INSERT INTO sessions
              (id, name, status, started_at, ended_at, updated_at,
               last_activity_at, data_revision)
            VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`,
      args: [
        seed.sessionId,
        seed.name ?? null,
        observedAt,
        observedAt,
        observedAt,
        observedAt,
        SEEDED_DATA_REVISION,
      ],
    },
    substantiveToolEventBatchItem(seed.sessionId, observedAt),
    {
      // `lines_added` MUST be non-null: `gitLocRows`'s commit lane filters on
      // it, and its branch/PR fallback lane is gated on this same link existing.
      sql: `INSERT INTO artifacts
              (id, identity_key, kind, repo_full_name, sha,
               lines_added, lines_removed, files_changed,
               created_at, last_seen_at, observed_at)
            VALUES (?, ?, 'commit', ?, ?,
                    ?, ?, ?,
                    ?, ?, ?)`,
      args: [
        artifactId,
        `commit:${repoFullName}:${sha}`,
        repoFullName,
        sha,
        seed.linesAdded,
        seed.linesRemoved,
        seed.filesChanged ?? 1,
        observedAt,
        observedAt,
        observedAt,
      ],
    },
    {
      // `relation='created'` on a commit artifact is the `authored_sessions`
      // gate — the predicate the branch-only seeders in `seed-loc-per-dollar-db.ts`
      // never satisfy, which is why their corpus yields no `gitDiffStats`.
      sql: `INSERT INTO session_artifact_links
              (id, session_id, artifact_id, relation, method, evidence,
               is_primary, status, extractor_version, observed_at, created_at)
            VALUES (?, ?, ?, 'created', 'git_push', '{}',
                    1, 'confirmed', 1, ?, ?)`,
      args: [
        `link-commit-${seed.sessionId}`,
        seed.sessionId,
        artifactId,
        observedAt,
        observedAt,
      ],
    },
    ...(seed.costUsd === undefined
      ? []
      : [pricedTokenUsageBatchItem(seed.sessionId, seed.costUsd)]),
  ];
}

/** The inventory row plus one usage row per invoking session. */
function componentBatchItems(
  seed: AgentComponentUsageComponentSeed,
  observedAt: string
): SeedBatchItem[] {
  const kind = seed.kind ?? VERIFIABLE_KIND;
  const harness = seed.harness ?? DEFAULT_HARNESS;
  return [
    {
      // `content_hash` is left NULL, and every usage row below carries a NULL
      // `component_version_hash`, so the whole corpus stays on ONE name-level
      // identity bucket. A hash on either side alone would split the row into a
      // synthesized version bucket and make the aggregates harder to reason
      // about for no benefit to an alignment spec.
      sql: `INSERT INTO agent_components
              (id, component_kind, external_id, component_key, name, harness,
               source_url, pack_id, description, resolved_state,
               first_seen_at, last_seen_at, uninstalled_at)
            VALUES (?, ?, ?, ?, ?, ?,
                    ?, ?, ?, 'resolved', ?, ?, ?)`,
      args: [
        seed.id,
        kind,
        `${kind}:${seed.key}`,
        seed.key,
        seed.name,
        harness,
        seed.sourceUrl ?? null,
        seed.packId ?? null,
        seed.name,
        observedAt,
        observedAt,
        seed.uninstalledAt ?? null,
      ],
    },
    // ISS-5464: the DURABLE invocation rows the usage rollup below is DERIVED
    // from. Seeding the rollup alone is not enough, and the reason is invisible
    // from both the usage table and any in-process read:
    //
    //   `startBootMaintenance` (boot-maintenance.ts) runs
    //   `backfillSessionAnalytics` FIRST at db open. That pass anti-joins
    //   `sessions` against `session_analytics` and selects every session lacking
    //   a rollup row — which is EVERY session this seeder writes, since it
    //   writes no `session_analytics`. That gate is entirely independent of
    //   `data_revision`, so pinning {@link SEEDED_DATA_REVISION} does not close
    //   it. It calls `upsertSessionAnalyticsRollupBatch` without
    //   `replaceComponentUsage: false`, which runs
    //   `ensureStoredAgentComponentInvocations` (bootstrapping invocations from
    //   the session's EVENTS when it has none — minting a phantom
    //   `tool`/`SeedTool` identity out of this seeder's own substantive tool
    //   event) and then `rebuildAgentComponentSessionUsageFromInvocations`,
    //   which DELETEs the rollup for those sessions and re-INSERTs it from the
    //   invocation rows.
    //
    // Seeded usage alone is therefore destroyed moments after boot and REPLACED
    // by the phantom tool identity: `agent_components` is untouched (so the
    // detail page still resolves its heading) while the component reads
    // `0 Sessions` with the genuine "No sessions have invoked this component
    // yet" empty state — the exact false green
    // `agent-detail-sessions-truncation.spec.ts` exists to rule out.
    //
    // Writing the invocations closes it at the source rather than by evading a
    // maintenance pass: `ensureStoredAgentComponentInvocations` SKIPS any
    // session that already has invocation rows, so no phantom is minted, and the
    // rebuild re-derives byte-identical usage from these rows. The corpus
    // becomes IDEMPOTENT under every rebuild path (the analytics backfill, the
    // data-revision rebuild, and the cost heal passes) instead of surviving only
    // until the first one runs.
    //
    // Each row's shape is chosen so the rebuild's aggregate reproduces the
    // rollup written below EXACTLY: `invocations` is its COUNT(*), so one row is
    // emitted per counted invocation; `git_branch` is '' (not NULL) so the
    // rebuild's COALESCE short-circuits to the same '' sentinel instead of
    // deriving a branch from the event joins; `definition_hash` is NULL so its
    // CASE yields the same NULL `component_version_hash`; `succeeded` is NULL
    // and the anchor is a Timestamp (never an error-bearing event/agent) so
    // `error_count` stays 0; and `invoked_at` is the same `observedAt`, so
    // MIN/MAX reproduce `first_invoked_at`/`last_invoked_at`.
    //
    // NOTE: the rebuild takes `harness` from the SESSION
    // (`COALESCE(NULLIF(s.harness,''),'claude')`), not the component, so a seed
    // that overrides a component's `harness` away from the 'claude' default will
    // see it revert to 'claude' after a rebuild. No current corpus does.
    ...seed.usage.flatMap((usage) =>
      Array.from({ length: usage.invocations }, (_unused, index) => ({
        sql: `INSERT INTO agent_component_invocations
                (id, session_id, external_invocation_id, component_kind,
                 component_key, raw_name, normalized_name, relationship,
                 invoked_at, sequence, anchor_kind, anchor_value,
                 attribution_status, evidence_class, definition_hash,
                 local_component_id, git_branch, succeeded,
                 created_at, updated_at)
              VALUES (?, ?, ?, ?,
                      ?, ?, ?, '${INVOCATION_RELATIONSHIP}',
                      ?, ?, '${INVOCATION_ANCHOR_KIND}', ?,
                      '${INVOCATION_ATTRIBUTION_STATUS}', '${INVOCATION_EVIDENCE_CLASS}', NULL,
                      ?, '', NULL,
                      ?, ?)`,
        args: [
          `invocation-${usage.sessionId}-${seed.id}-${index}`,
          usage.sessionId,
          // Unique per (session_id, external_invocation_id) — the table's one
          // UNIQUE index (`idx_aci_session_external_invocation`).
          `${seed.key}#${index}`,
          kind,
          seed.key,
          seed.key,
          seed.key,
          observedAt,
          index,
          observedAt,
          seed.id,
          observedAt,
          observedAt,
        ],
      }))
    ),
    ...seed.usage.map((usage) => ({
      // `git_branch` is part of the composite PK and NOT NULL — '' is the
      // production sentinel for "no branch" (see the schema note on
      // `AgentComponentSessionUsage.gitBranch`), so it is written explicitly
      // rather than left to the column default.
      sql: `INSERT INTO agent_component_session_usage
              (session_id, component_kind, component_key, git_branch,
               agent_component_id, harness, invocations, error_count,
               component_version_hash, first_invoked_at, last_invoked_at,
               started_day)
            VALUES (?, ?, ?, '',
                    ?, ?, ?, 0,
                    NULL, ?, ?, ?)`,
      args: [
        usage.sessionId,
        kind,
        seed.key,
        seed.id,
        harness,
        usage.invocations,
        observedAt,
        observedAt,
        observedAt.slice(0, 10),
      ],
    })),
  ];
}
