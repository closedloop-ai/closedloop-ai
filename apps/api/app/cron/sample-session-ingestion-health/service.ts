import { withDb } from "@repo/database";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import {
  emitSessionIngestionActiveOrgs,
  emitSessionIngestionStaleness,
  emitSessionIngestionStalledOrgs,
} from "@/lib/observability/session-ingestion-metrics";

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * An org that has not ingested any session data for longer than this is
 * treated as STALLED and counted into the page signal.
 *
 * Sized against the failure it exists to catch (ISS-4537: an org-wide freeze
 * that went unnoticed for ~2 days) and against normal quiet periods. Six hours
 * is long enough that an ordinary overnight gap for a small team does not
 * register, and short enough that a real freeze surfaces the same working day
 * instead of two days later. The gate-specific failure mode is covered far
 * faster by `session.ingestion.policy_denied`, which fires on the first denied
 * request; this threshold governs only the catch-all backstop.
 */
export const SESSION_INGESTION_STALL_THRESHOLD_HOURS = 6;

/**
 * An org whose last ingest predates this is DORMANT, not stalled: a trial that
 * ended, a churned customer, a demo org nobody uses. Counting those as stalled
 * would make the page signal permanently non-zero and therefore worthless, so
 * they are reported separately and excluded from `stalled_orgs`.
 */
export const SESSION_INGESTION_DORMANT_AFTER_HOURS = 24 * 7;

/**
 * Upper bound on per-org staleness gauges emitted per run, so metric
 * cardinality and log volume stay bounded as the org count grows.
 *
 * Dormant AND quiet orgs are filtered out before the cap applies (ISS-4830), and
 * the remainder is reduced to the most-stale-first top N via a bounded heap (see
 * `emitBoundedStalenessSamples`) — so the budget is spent on stalled orgs before
 * healthy ones, and neither a long tail of churned orgs nor a weekend's worth of
 * idle ones can displace the orgs an operator actually needs named.
 */
const MAX_ORG_STALENESS_SAMPLES = 100;

/**
 * Max org ids sent in a single `id IN (...)` policy lookup (ISS-4708).
 *
 * `loadPolicyByOrg` receives one id per org that has ever ingested — an
 * unbounded, fleet-sized array. Passing the whole array as a single `IN` list
 * risks the PostgreSQL bind-parameter ceiling (65535 placeholders): past it the
 * driver rejects the statement outright and the whole sampler run fails. The
 * emission cap (`MAX_ORG_STALENESS_SAMPLES`) bounds only the gauges emitted, not
 * this read, so the id array is chunked at a width well under the ceiling and
 * the chunks run through a pooled-DB-safe bounded fan-out. 1000 is the
 * conventional safe batch width for a single-column `IN` and leaves ample
 * headroom below the 65535 limit while keeping the chunk count small.
 */
const POLICY_LOOKUP_ID_CHUNK_SIZE = 1000;

/**
 * ISS-4678 + ISS-4827: an org past the stall threshold is only genuinely STALLED
 * if a desktop recently ATTEMPTED to reach the cloud — a live fleet whose
 * session data is not landing (an all-foreign-chunk loop, a desktop resyncing
 * empty batches, a batch that times out inside the ingest transaction). If the
 * org's last ingest ATTEMPT
 * (`ComputeTarget.lastAgentSessionSyncAttemptAt`) also predates this window, no
 * desktop is even trying: this is a QUIET org (overnight/weekend gap, no new
 * sessions), NOT an ingestion outage, and counting it would page on ordinary
 * inactivity.
 *
 * ISS-4827 — WHY NOT THE HEARTBEAT. This window was originally applied to
 * `lastSeenAt`, the DEVICE HEARTBEAT. That was wrong: `lastSeenAt` is refreshed
 * by registration, heartbeat, and online-state check-ins on a ~30-90s cadence
 * (see `desktop-gateway-socket-server.ts` and COMPUTE_TARGET_STALE_MS in
 * apps/api/app/compute-targets/service.ts) INDEPENDENTLY of any ingest attempt,
 * while `agent-session-sync-service.ts` sends no ingest request at all when its
 * queues are empty. A developer who left the desktop app open but did no agent
 * work for >6h therefore presented a fresh heartbeat next to an old ingest
 * watermark and PAGED. A recent heartbeat proves PRESENCE, not an
 * attempted-but-failed ingest — and because the heartbeat is aggregated org-wide,
 * one unrelated connected target could flip the whole org. The attempt watermark
 * is stamped only from the accepted-batch transaction, so it cannot be refreshed
 * by presence alone.
 *
 * Sized one stall-threshold wide so a fleet that attempted anytime within the
 * same window the stall detector considers "should have ingested by now" still
 * counts as attempting; the width is the grace for a fleet that went briefly
 * offline but is otherwise live.
 */
const SESSION_INGESTION_ACTIVITY_WINDOW_HOURS =
  SESSION_INGESTION_STALL_THRESHOLD_HOURS;

export type SessionIngestionHealthSummary = {
  /** Orgs with at least one device that has ever successfully ingested. */
  orgsWithIngestHistory: number;
  /** Orgs whose last ingest is inside the freshness window. */
  activeOrgCount: number;
  /** Previously-ingesting orgs now silent past the stall threshold. */
  stalledOrgCount: number;
  /**
   * ISS-4678 + ISS-4827: orgs past the stall threshold whose desktop fleet has
   * ALSO not ATTEMPTED an ingest inside the activity window — no work is
   * happening, so they are NOT an ingestion outage and are excluded from the
   * page signal. Distinct from dormant: a quiet org may return to activity any
   * moment (weekend gap), a dormant one is effectively abandoned.
   */
  quietOrgCount: number;
  /** Orgs silent past the dormant cutoff, excluded from the page signal. */
  dormantOrgCount: number;
  /**
   * Registered, non-sentinel devices that have never ingested. Their
   * `lastAgentSessionSyncAt` is NULL, which is "no ingest has ever happened",
   * NOT "ingested at the epoch" — so they are excluded from every staleness
   * computation rather than being folded in as infinitely stale.
   */
  neverIngestedTargetCount: number;
  /**
   * Per-org staleness gauges actually emitted. Covers active + stalled orgs
   * only, capped — see `MAX_ORG_STALENESS_SAMPLES`.
   */
  stalenessSamplesEmitted: number;
  /**
   * ISS-4827: orgs whose desktop fleet checked in (`max(lastSeenAt)`) inside the
   * activity window. PRESENCE, not attempt — it deliberately does not classify
   * an org, because a heartbeat carries no ingest evidence. It is the reach
   * signal: it tells the platform-wide check below whether the fleet can talk to
   * us at all.
   */
  fleetPresentOrgCount: number;
  /**
   * ISS-4829: true when the platform is in a QUIET period — no org is ingesting
   * inside the freshness window, no org is stalled, at least one is quiet, and
   * the fleet is demonstrably REACHABLE (at least one org checked in recently).
   * That is a weekend/overnight lull, not "nothing is ingesting anywhere", so
   * the zero-active page is suppressed for the run (see
   * `sampleSessionIngestionHealth`). Reported in the summary so the suppression
   * is visible in the cron's own log line rather than silent.
   */
  platformQuiet: boolean;
};

type OrgIngestionRow = {
  organizationId: string;
  lastIngestedAt: Date;
  policyEnabled: boolean;
  stalenessMs: number;
  /**
   * ISS-4678: milliseconds since a desktop of this org last checked in
   * (`max(lastSeenAt)`). `null` when the org has ingest history but no live
   * heartbeat is resolvable. Never null in practice: an org in the ingest group
   * has at least one non-sentinel target, and `lastSeenAt` is non-nullable.
   *
   * ISS-4827: PRESENCE ONLY — this is no longer what separates stalled from
   * quiet, because a heartbeat is refreshed by check-ins with no ingest attempt
   * behind them. It is retained as a diagnostic dimension (an org attempting
   * with no present fleet is a different shape of problem than one with both)
   * and is deliberately NOT an input to `classifyOrgIngestionRow`.
   */
  lastSeenAgoMs: number | null;
  /**
   * ISS-4827: milliseconds since any desktop of this org last had a session
   * batch ACCEPTED (`max(lastAgentSessionSyncAttemptAt)`) — including the
   * zero-row batches the landed-data watermark ignores. `null` when no accepted
   * batch is on record since the column existed, which the classifier treats as
   * "not attempting": the non-paging side, so a pre-backfill or version-skewed
   * row can never invent a page.
   */
  lastAttemptAgoMs: number | null;
};

/**
 * The per-org fleet signals read alongside the ingest watermark (ISS-4678 /
 * ISS-4827). `lastAttemptAt` is nullable because the column is: an org whose
 * targets have never had a batch accepted has no attempt on record.
 */
type OrgPresence = {
  lastSeenAt: Date | null;
  lastAttemptAt: Date | null;
};

/**
 * A reportable org row carrying its classification. ISS-4830: only `active` and
 * `stalled` rows reach the per-org gauge — `dormant` and `quiet` are both
 * filtered out before it — so the classification is narrowed here and doubles as
 * the ordering key `emitBoundedStalenessSamples` ranks by, keeping a stalled org
 * from losing a capped sample slot to a more-stale active one.
 */
type ClassifiedOrgIngestionRow = OrgIngestionRow & {
  classification: Extract<OrgIngestionClassification, "active" | "stalled">;
};

/**
 * Sample cloud session-ingestion health across every org and emit the
 * `session.ingestion.*` gauges (ISS-4543).
 *
 * SOURCE OF TRUTH — `ComputeTarget.lastAgentSessionSyncAt`. It is stamped with
 * the batch sync timestamp on every ACCEPTED session batch, so the per-org
 * maximum is "the last moment any of this org's desktops successfully landed
 * session data in the cloud" — exactly the quantity a freeze kills. Two
 * alternatives were rejected: `SessionDetail.sessionStartedAt` is a
 * harness-reported client clock and so cannot be trusted for a server-side
 * freshness window, and `SessionDetail.lastSyncedAt`, while server-assigned and
 * correct, lives on the hot, large session table with no index on that column —
 * a repeating full scan for a signal the small `compute_targets` table already
 * carries.
 *
 * NULL HANDLING — the column is nullable, and the query excludes NULLs from the
 * date window rather than substituting a fallback timestamp. A device that has
 * never synced has no ingest history to be stale against; treating NULL as a
 * very old timestamp would report every freshly-registered device as a stalled
 * org and drown the real signal. Those devices are counted separately into
 * `neverIngestedTargetCount` so the exclusion is visible rather than silent.
 *
 * Cloud-sentinel targets (`isCloudSentinel`) are synthetic per-org rows with no
 * device behind them; they can never sync, so they are excluded outright.
 *
 * STALLED vs QUIET (ISS-4678, corrected by ISS-4827) — an old
 * `lastAgentSessionSyncAt` alone is ambiguous: it is equally consistent with an
 * ingestion outage and with a healthy org that simply had no new sessions
 * overnight/on a weekend (the watermark only advances when session rows LAND,
 * and Desktop only posts when sessions are queued). Classifying both as stalled
 * produced a recurring false page. ISS-4678 disambiguated with
 * `max(lastSeenAt)`, the device heartbeat — but that is a PRESENCE signal
 * refreshed by registration/heartbeat/online check-ins on a ~30-90s cadence with
 * no ingest attempt behind it, so an idle-but-open desktop still paged, and
 * because the heartbeat is aggregated org-wide one unrelated connected target
 * could flip the whole org. ISS-4827 replaced it with
 * `max(lastAgentSessionSyncAttemptAt)`, the ATTEMPT watermark stamped inside
 * every accepted-batch transaction (including the zero-row batches the
 * landed-data watermark ignores). An org is STALLED only when a batch was
 * ACCEPTED recently and its data still did not land; one past the threshold with
 * no recent attempt is QUIET, reported separately and kept out of the page
 * signal. The heartbeat is still read, but only as the platform-reach signal
 * behind `fleetPresentOrgCount` / `platformQuiet` (ISS-4829).
 */
export async function sampleSessionIngestionHealth(
  now: Date
): Promise<SessionIngestionHealthSummary> {
  const { lastIngestByOrg, neverIngestedTargetCount } =
    await loadIngestSignals();

  const organizationIds = lastIngestByOrg.map((entry) => entry.organizationId);
  const [policyByOrg, presenceByOrg] = await Promise.all([
    loadPolicyByOrg(organizationIds),
    loadPresenceByOrg(organizationIds),
  ]);

  const rows = buildOrgIngestionRows({
    lastIngestByOrg,
    now,
    policyByOrg,
    presenceByOrg,
  });
  const summary = summarizeOrgIngestionRows(rows, neverIngestedTargetCount);

  // ISS-4829: the zero-active page means "nothing is ingesting anywhere", which
  // is only an outage claim when something SHOULD be ingesting. A platform-wide
  // quiet period — every org past the freshness window, none of them attempting,
  // none stalled — is a weekend/overnight lull, and emitting `0` for it pages on
  // ordinary inactivity exactly the way `stalled_orgs` did before ISS-4678. The
  // gauge is withheld for that run rather than reporting a number an operator
  // would read as an outage; every other run, including a genuine zero-active
  // (orgs stalled, or a fleet attempting with nothing landing), still emits.
  //
  // WITHHOLDING BLIND SPOT (review, PR #4256), recorded deliberately. A
  // platform-wide ingest failure of the pre-acceptance kind — every request
  // refused by auth, or 5xx'd before it reaches the ingest service — produces
  // the SAME four-conjunct signature as a weekend lull, because no attempt
  // watermark advances in either case while heartbeats keep flowing. Gating the
  // withholding on positive attempt evidence instead of presence does NOT fix
  // that: the desktop sync service sends no request at all when its queues are
  // empty (see the ISS-4827 migration note), so a genuine weekend has no attempt
  // evidence either and the gate would restore the every-weekend false page
  // ISS-4829 exists to remove. The two states are not separable from watermarks
  // that advance only on success, so the pre-acceptance classes are covered by
  // the faster, more specific signals named on `classifyOrgIngestionRow` —
  // `session.ingestion.policy_denied` for the policy path, API error-rate for
  // the rest — rather than by widening this backstop until it pages on Sundays.
  if (!summary.platformQuiet) {
    emitSessionIngestionActiveOrgs(
      summary.activeOrgCount,
      SESSION_INGESTION_STALL_THRESHOLD_HOURS,
      summary.quietOrgCount
    );
  }
  emitSessionIngestionStalledOrgs(
    summary.stalledOrgCount,
    SESSION_INGESTION_STALL_THRESHOLD_HOURS
  );

  return summary;
}

/**
 * DELIBERATELY NOT ORG-SCOPED. The org-scoping rule governs per-tenant data
 * read on behalf of a user; this is a platform-wide operator health sampler
 * behind CRON_SECRET with no user and no org in scope, and scoping it to one
 * org would defeat its purpose — the signal it exists to produce is precisely
 * "which orgs, across the whole platform, have gone silent". It emits only
 * aggregate counts and per-org staleness, never tenant content. Same shape as
 * the sibling `/cron/sample-heartbeat-lag`, which scans all RUNNING loops.
 *
 * INDEX COVERAGE (ISS-4543, review #4127). Both predicates are backed by
 * PARTIAL indexes on `compute_targets` — `compute_targets_ingest_group_idx`
 * (organization_id, last_agent_session_sync_at) WHERE is_cloud_sentinel = false
 * AND last_agent_session_sync_at IS NOT NULL for the grouped `_max`, and
 * `compute_targets_never_ingested_idx` (organization_id) WHERE
 * is_cloud_sentinel = false AND last_agent_session_sync_at IS NULL for the
 * NULL count — so neither scan is sequential. They are partial precisely
 * because `last_agent_session_sync_at` is written on EVERY accepted session
 * batch: an actively-syncing (NOT NULL) device row maintains only the small
 * ingest-group index and never touches the never-ingested one, bounding the
 * hot-write-path cost. Built CONCURRENTLY so the index create never blocks
 * ingest. See migration
 * 20260731130000_iss4543_compute_target_ingestion_health_scan_index.
 */
async function loadIngestSignals(): Promise<{
  lastIngestByOrg: Array<{ organizationId: string; lastIngestedAt: Date }>;
  neverIngestedTargetCount: number;
}> {
  const [grouped, neverIngestedTargetCount] = await withDb((db) =>
    Promise.all([
      db.computeTarget.groupBy({
        by: ["organizationId"],
        where: {
          isCloudSentinel: false,
          lastAgentSessionSyncAt: { not: null },
        },
        _max: { lastAgentSessionSyncAt: true },
      }),
      db.computeTarget.count({
        where: { isCloudSentinel: false, lastAgentSessionSyncAt: null },
      }),
    ])
  );

  const lastIngestByOrg: Array<{
    organizationId: string;
    lastIngestedAt: Date;
  }> = [];
  for (const group of grouped) {
    const lastIngestedAt = group._max.lastAgentSessionSyncAt;
    // Defensive: the `not: null` predicate makes an all-NULL group impossible,
    // but Prisma types _max as nullable. Dropping the group is the same safe
    // choice the predicate already makes — never a fabricated timestamp.
    if (lastIngestedAt !== null) {
      lastIngestByOrg.push({
        organizationId: group.organizationId,
        lastIngestedAt,
      });
    }
  }

  return { lastIngestByOrg, neverIngestedTargetCount };
}

/**
 * Look up the session-sync policy for every org that has ingested, CHUNKED so
 * the id array never crosses the driver bind-parameter ceiling (ISS-4708).
 *
 * The id array is fleet-sized and unbounded, so a single `id IN (...)` would put
 * one bind placeholder per org and can exceed PostgreSQL's 65535-placeholder
 * limit, failing the whole run. The ids are split into `IN` lists of at most
 * `POLICY_LOOKUP_ID_CHUNK_SIZE` and the chunk reads run through
 * `mapWithDbConcurrency`, which bounds pooled-connection fan-out (FEA-3299). The
 * merged map is exact: every org present in any chunk's result is represented,
 * and deactivated/deleted orgs (filtered out by `active: true`) are simply
 * absent — the same signal the caller already treats as "not an ingestion
 * stall".
 */
async function loadPolicyByOrg(
  organizationIds: string[]
): Promise<Map<string, boolean>> {
  if (organizationIds.length === 0) {
    return new Map();
  }

  const idChunks = chunkOrgIds(organizationIds);
  const chunkResults = await mapWithDbConcurrency(idChunks, (idChunk) =>
    withDb((db) =>
      db.organization.findMany({
        where: { active: true, id: { in: idChunk } },
        select: { id: true, sessionSyncPolicyEnabled: true },
      })
    )
  );

  const policyByOrg = new Map<string, boolean>();
  for (const organizations of chunkResults) {
    for (const organization of organizations) {
      policyByOrg.set(organization.id, organization.sessionSyncPolicyEnabled);
    }
  }

  return policyByOrg;
}

/**
 * ISS-4678 + ISS-4827: the per-org fleet signals read alongside the ingest
 * watermark — `max(lastSeenAt)` (is a desktop PRESENT?) and
 * `max(lastAgentSessionSyncAttemptAt)` (is a desktop ATTEMPTING?). The ATTEMPT
 * watermark is what separates a live-but-not-landing fleet (genuine stall) from
 * an idle-but-open desktop; the heartbeat is carried as a diagnostic dimension
 * only (see `OrgIngestionRow.lastSeenAgoMs`). Both come from ONE grouped scan
 * over the same non-sentinel target set as the ingest group, so adding the
 * attempt signal costs no extra round-trip.
 *
 * `lastSeenAt` is non-nullable, so a group here always has a resolvable max;
 * `lastAgentSessionSyncAttemptAt` is nullable and stays absent for an org whose
 * targets have never had a batch accepted. The classifier degrades safely for
 * both — an org missing from this map, or missing an attempt timestamp, is
 * treated as "not attempting", the non-paging side.
 *
 * INDEX COVERAGE (ISS-4832). Backed by the PARTIAL
 * `compute_targets_presence_group_idx` (organization_id, last_seen_at) INCLUDE
 * (last_agent_session_sync_attempt_at) WHERE is_cloud_sentinel = false, so the
 * grouped maxes are an index-ordered, index-only scan per org instead of a heap
 * visit per registered target. Before it, `compute_targets` carried no index on
 * `last_seen_at` at all and this sampler's cost grew with fleet size (wongk,
 * PR #4187). See migration
 * 20260802190000_iss4832_compute_target_heartbeat_group_index.
 *
 * CHUNKED for the same bind-parameter reason as `loadPolicyByOrg` (ISS-4708):
 * the org-id array is fleet-sized, so a single `organizationId IN (...)` could
 * cross the 65535-placeholder ceiling. The chunks run through the same bounded
 * fan-out, and the merged map is exact — every org present in any chunk is
 * represented.
 */
async function loadPresenceByOrg(
  organizationIds: string[]
): Promise<Map<string, OrgPresence>> {
  if (organizationIds.length === 0) {
    return new Map();
  }

  const idChunks = chunkOrgIds(organizationIds);
  const chunkResults = await mapWithDbConcurrency(idChunks, (idChunk) =>
    withDb((db) =>
      db.computeTarget.groupBy({
        by: ["organizationId"],
        where: {
          isCloudSentinel: false,
          organizationId: { in: idChunk },
        },
        _max: { lastSeenAt: true, lastAgentSessionSyncAttemptAt: true },
      })
    )
  );

  const presenceByOrg = new Map<string, OrgPresence>();
  for (const grouped of chunkResults) {
    for (const group of grouped) {
      presenceByOrg.set(group.organizationId, {
        lastSeenAt: group._max.lastSeenAt,
        lastAttemptAt: group._max.lastAgentSessionSyncAttemptAt,
      });
    }
  }

  return presenceByOrg;
}

function buildOrgIngestionRows({
  lastIngestByOrg,
  now,
  policyByOrg,
  presenceByOrg,
}: {
  lastIngestByOrg: Array<{ organizationId: string; lastIngestedAt: Date }>;
  now: Date;
  policyByOrg: Map<string, boolean>;
  presenceByOrg: Map<string, OrgPresence>;
}): OrgIngestionRow[] {
  const rows: OrgIngestionRow[] = [];

  for (const entry of lastIngestByOrg) {
    const policyEnabled = policyByOrg.get(entry.organizationId);
    // An org missing from the policy lookup is deactivated or deleted. Its
    // devices cannot ingest by design, so it is not an ingestion stall.
    if (policyEnabled === undefined) {
      continue;
    }

    const presence = presenceByOrg.get(entry.organizationId);

    rows.push({
      organizationId: entry.organizationId,
      lastIngestedAt: entry.lastIngestedAt,
      policyEnabled,
      // Clamped at 0: a clock skew between the DB and the runtime can put a
      // sync timestamp marginally in the future, and a negative staleness
      // would read as a bogus gauge rather than "just ingested".
      stalenessMs: Math.max(0, now.getTime() - entry.lastIngestedAt.getTime()),
      // ISS-4678/ISS-4827: null when the signal does not resolve — the
      // non-paging side for the attempt watermark. Clamped at 0 for the same
      // future-skew reason as staleness.
      lastSeenAgoMs: elapsedMsSince(presence?.lastSeenAt, now),
      lastAttemptAgoMs: elapsedMsSince(presence?.lastAttemptAt, now),
    });
  }

  return rows;
}

function summarizeOrgIngestionRows(
  rows: OrgIngestionRow[],
  neverIngestedTargetCount: number
): SessionIngestionHealthSummary {
  const stallThresholdMs =
    SESSION_INGESTION_STALL_THRESHOLD_HOURS * MS_PER_HOUR;
  const dormantThresholdMs =
    SESSION_INGESTION_DORMANT_AFTER_HOURS * MS_PER_HOUR;
  const activityWindowMs =
    SESSION_INGESTION_ACTIVITY_WINDOW_HOURS * MS_PER_HOUR;

  const counts = { active: 0, stalled: 0, quiet: 0, dormant: 0 };
  let fleetPresentOrgCount = 0;
  // ISS-4830: only ACTIVE and STALLED orgs get a per-org staleness gauge.
  //
  // Dormant orgs were already excluded, for the same reason they are excluded
  // from `stalled_orgs`: they are not an ingestion problem, and being by
  // definition the MOST stale rows they would let a long tail of churned orgs
  // consume the whole sample budget and push the genuinely-stalled orgs out of
  // the emission an operator reads.
  //
  // Quiet orgs are now excluded too. `session.ingestion.staleness` carries only
  // (orgId, policyEnabled, value), so a quiet row and a stalled row emitted the
  // SAME payload shape and an operator drilling into an aggregate
  // `stalled_orgs` page could not tell which org was actually stalled and which
  // was merely idle (wongk, PR #4187). Carrying the classification as a metric
  // LABEL would need a paired `datadog_logs_metric` + monitor change in
  // `closedloop-ai/cl-tofu-aws-live` (PRD-159) that cannot be made from this
  // repo, so the emission is narrowed instead: every org named by this metric is
  // one the page is about. The quiet population stays visible as
  // `SessionIngestionHealthSummary.quietOrgCount` and in the cron's log line.
  const reportableRows: ClassifiedOrgIngestionRow[] = [];

  for (const row of rows) {
    const classification = classifyOrgIngestionRow(row, {
      stallThresholdMs,
      dormantThresholdMs,
      activityWindowMs,
    });
    counts[classification]++;
    // ISS-4827/ISS-4829: presence is counted for EVERY row regardless of
    // classification. It is the platform-reach signal, not a classifier input.
    if (row.lastSeenAgoMs !== null && row.lastSeenAgoMs <= activityWindowMs) {
      fleetPresentOrgCount++;
    }
    if (classification === "active" || classification === "stalled") {
      reportableRows.push({ ...row, classification });
    }
  }

  const stalenessSamplesEmitted = emitBoundedStalenessSamples(reportableRows);

  return {
    orgsWithIngestHistory: rows.length,
    activeOrgCount: counts.active,
    stalledOrgCount: counts.stalled,
    quietOrgCount: counts.quiet,
    dormantOrgCount: counts.dormant,
    neverIngestedTargetCount,
    stalenessSamplesEmitted,
    fleetPresentOrgCount,
    // ISS-4829: a quiet PERIOD, not a zero-active outage — nothing is ingesting
    // and nothing is stalled, but at least one org is quiet AND the fleet is
    // demonstrably reachable (a live population that simply has no work right
    // now). All four conjuncts are load-bearing: zero active AND zero quiet is
    // either a dark platform or a churned one; a non-zero stalled count is a
    // real outage that must still page; and a "quiet" population whose devices
    // are ALSO not checking in is not a weekend lull but a platform nothing can
    // reach — the exact case `active_orgs` exists to catch — so presence must be
    // positively observed before the page is withheld.
    platformQuiet:
      counts.active === 0 &&
      counts.stalled === 0 &&
      counts.quiet > 0 &&
      fleetPresentOrgCount > 0,
  };
}

type OrgIngestionClassification = "active" | "stalled" | "quiet" | "dormant";

/**
 * ISS-4678 / ISS-4827 / ISS-4831: classify one org's ingest age.
 *
 * The order of the checks IS the contract:
 *
 * 1. Inside the freshness window → ACTIVE. Nothing else matters.
 * 2. ISS-4827 — a recent ingest ATTEMPT (`lastAttemptAgoMs` inside the activity
 *    window) with a stale ingest watermark → STALLED. A desktop reached the
 *    cloud but no session rows landed: an all-foreign-chunk loop, a desktop
 *    resyncing empty batches, or a batch that was accepted and then failed
 *    inside its transaction (an `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS` timeout on
 *    a large batch — `stampIngestAttemptAfterFailedBatch` records the attempt
 *    from outside the rolled-back transaction so that case reaches this branch).
 *    This deliberately keys off the attempt watermark and NOT `lastSeenAgoMs`:
 *    the device heartbeat is refreshed by registration/heartbeat/online
 *    check-ins with no ingest attempt behind them, so an idle-but-open desktop
 *    presented a fresh heartbeat next to an old ingest watermark and paged.
 *    Presence is not an attempt.
 * 3. ISS-4831 — the attempt check runs BEFORE the dormant cutoff, so a customer
 *    returning after 7+ days whose fleet immediately hits a real ingest failure
 *    RE-ENTERS the monitored population instead of being short-circuited to
 *    dormant on a watermark that is old precisely because they were away. The
 *    dormant branch used to win first, which excluded exactly the org whose
 *    first day back is broken. It is safe to promote the attempt check above it
 *    only because the check is now attempt-based: doing this with the heartbeat
 *    would have re-admitted every idle-but-open desktop as a false page.
 * 4. Otherwise the ingest age decides: past the dormant cutoff → DORMANT (a
 *    trial that ended, a churned customer, an abandoned demo org — not attempting
 *    and long gone), else QUIET (a weekend/overnight gap in a live org).
 *
 * A null `lastAttemptAgoMs` — no accepted batch on record, including the
 * pre-backfill migration window — is treated as "not attempting": the classifier
 * only pages on POSITIVE evidence of an attempting-but-failing fleet, so a
 * missing signal degrades to the non-paging side.
 *
 * KNOWN LIMIT OF THE ATTEMPT SIGNAL (review, PR #4256). The attempt watermark
 * advances only on a batch the server ACCEPTED, so its absence is not evidence
 * that nothing was trying. Two failure classes therefore never reach the STALLED
 * branch, and fall to QUIET at the same instant the org stops being ACTIVE:
 *
 *   • refused BEFORE acceptance — auth, org session-sync policy, validation.
 *     The policy case, the one that caused ISS-4537, is covered far faster and
 *     more precisely by `session.ingestion.policy_denied`, which fires on the
 *     FIRST denied request rather than after this six-hour threshold.
 *   • failed before the request reached the ingest service — a 5xx from an
 *     infrastructure fault or a broken route. Nothing server-side attributes
 *     those to a compute target, so no per-target watermark can carry them;
 *     they are an API error-rate signal, not an ingestion-freshness one.
 *
 * This is narrower than the ISS-4678 heartbeat rule, which counted any org with
 * a checked-in device as stalled. That breadth is exactly what made it page
 * every weekend on idle-but-open desktops, and it was never real coverage: a
 * heartbeat proves a device is powered on, not that ingest works. The trade is
 * deliberate — page only on positive evidence of an attempting-but-failing
 * fleet, and let the two classes above be caught by the faster, more specific
 * signals named next to them. `stampIngestSyncWatermark` carries the same list.
 */
function classifyOrgIngestionRow(
  row: OrgIngestionRow,
  thresholds: {
    stallThresholdMs: number;
    dormantThresholdMs: number;
    activityWindowMs: number;
  }
): OrgIngestionClassification {
  if (row.stalenessMs <= thresholds.stallThresholdMs) {
    return "active";
  }

  const recentlyAttempting =
    row.lastAttemptAgoMs !== null &&
    row.lastAttemptAgoMs <= thresholds.activityWindowMs;
  if (recentlyAttempting) {
    return "stalled";
  }

  if (row.stalenessMs > thresholds.dormantThresholdMs) {
    return "dormant";
  }
  return "quiet";
}

/**
 * ISS-4678 (codex review, PR #4187): rank STALLED rows ahead of active ones
 * before the sample cap, so a long tail of orgs can never consume the entire
 * budget and omit the very orgs `stalled_orgs` is paging on — leaving an
 * operator unable to name them. Rank stalled first, then break ties
 * most-stale-first within each class. (ISS-4830 removed `quiet` from the
 * reportable set entirely, so it no longer needs a rank.)
 */
const STALENESS_SAMPLE_RANK: Record<
  ClassifiedOrgIngestionRow["classification"],
  number
> = {
  stalled: 0,
  active: 1,
};

function emitBoundedStalenessSamples(
  rows: ClassifiedOrgIngestionRow[]
): number {
  // Select the top-N reportable rows with a bounded heap instead of copying and
  // sorting the whole reportable set (ISS-4708): the heap holds at most
  // `MAX_ORG_STALENESS_SAMPLES` rows regardless of fleet size, so neither a full
  // copy nor a full O(n log n) sort of every reportable org crosses into memory.
  // The heap ranks by the SAME composite key the full sort used — class rank,
  // then most-stale-first, then input ordinal — so the bounded selection emits
  // the identical set and order the unbounded sort would have.
  const sampled = selectTopSamples(rows, MAX_ORG_STALENESS_SAMPLES);

  for (const row of sampled) {
    emitSessionIngestionStaleness(
      row.organizationId,
      row.stalenessMs,
      row.policyEnabled
    );
  }

  return sampled.length;
}

function chunkOrgIds(organizationIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let start = 0;
    start < organizationIds.length;
    start += POLICY_LOOKUP_ID_CHUNK_SIZE
  ) {
    chunks.push(
      organizationIds.slice(start, start + POLICY_LOOKUP_ID_CHUNK_SIZE)
    );
  }
  return chunks;
}

/**
 * A reportable row paired with its input ordinal, so the selection heap can
 * carry a STABLE tie-break through the (non-stable) heap ordering.
 */
type RankedSampleRow = {
  ordinal: number;
  row: ClassifiedOrgIngestionRow;
};

/**
 * Total order over reportable rows used to select and order the capped samples.
 *
 * Returns a negative number when `left` should rank AHEAD of `right` in the
 * emitted set. The key is, in priority order:
 *   1. classification rank (stalled < quiet < active) — a genuinely-stalled org
 *      never loses a capped slot to a more-stale quiet/active org;
 *   2. most-stale-first within a class;
 *   3. the input ordinal, ascending — a STABLE tie-break so equal (rank,
 *      staleness) rows keep their input order. `Array#sort` is stable, but a
 *      heap is not; carrying the ordinal makes the bounded selection emit the
 *      exact set and order the previous full `sort().slice()` did, including at
 *      the top-N cutoff where a bare heap would otherwise drop an earlier tied
 *      org in favor of a later one (wongk, PR #4212).
 */
function compareSampleRows(
  left: RankedSampleRow,
  right: RankedSampleRow
): number {
  const rankDelta =
    STALENESS_SAMPLE_RANK[left.row.classification] -
    STALENESS_SAMPLE_RANK[right.row.classification];
  if (rankDelta !== 0) {
    return rankDelta;
  }
  const stalenessDelta = right.row.stalenessMs - left.row.stalenessMs;
  if (stalenessDelta !== 0) {
    return stalenessDelta;
  }
  return left.ordinal - right.ordinal;
}

/**
 * Return the top `limit` reportable rows by `compareSampleRows`, in that order,
 * using a bounded heap so peak memory is `limit` rather than the input length
 * (ISS-4708).
 *
 * The heap keeps the `limit` BEST rows (by `compareSampleRows`) seen so far. Its
 * root is the WORST of those kept, so a new row displaces the root only when it
 * ranks strictly ahead of the current worst-kept row. The kept rows are then
 * sorted into final order — a bounded sort over at most `limit` rows — so the
 * result is identical to a full `sort().slice(0, limit)` of the whole input.
 */
function selectTopSamples(
  rows: ClassifiedOrgIngestionRow[],
  limit: number
): ClassifiedOrgIngestionRow[] {
  if (limit <= 0) {
    return [];
  }

  const heap = new SampleRowMaxHeap(limit);
  for (let ordinal = 0; ordinal < rows.length; ordinal++) {
    heap.offer({ ordinal, row: rows[ordinal] });
  }
  return heap.drainInOrder().map((entry) => entry.row);
}

/**
 * A fixed-capacity "worst-first" heap over `compareSampleRows`, used to keep the
 * top-N reportable rows without materializing a sorted copy of the full input.
 * The root is the WORST row currently kept — the one first evicted when a better
 * row arrives — so the invariant is "every child ranks no better than its
 * parent" (the mirror of a min-heap under `compareSampleRows`).
 */
class SampleRowMaxHeap {
  private readonly capacity: number;
  private readonly items: RankedSampleRow[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  offer(entry: RankedSampleRow): void {
    if (this.items.length < this.capacity) {
      this.items.push(entry);
      this.siftUp(this.items.length - 1);
      return;
    }
    // Heap is full: the root is the worst-ranked kept row. Replace it only if
    // the incoming row ranks strictly ahead of it, so the heap always holds the
    // best rows seen so far.
    if (compareSampleRows(entry, this.items[0]) < 0) {
      this.items[0] = entry;
      this.siftDown(0);
    }
  }

  drainInOrder(): RankedSampleRow[] {
    // Copy so a caller re-draining a reused heap still sees the full set, and
    // sort into final emit order: at most `capacity` (100) rows, so this is a
    // bounded sort, not a full-fleet one.
    return [...this.items].sort(compareSampleRows);
  }

  private siftUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      // Worst-first: a child that ranks AHEAD of its parent (emits earlier)
      // must not sit below it, so bubble it up.
      if (compareSampleRows(this.items[index], this.items[parent]) >= 0) {
        break;
      }
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(startIndex: number): void {
    let index = startIndex;
    const size = this.items.length;
    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let worst = index;
      if (
        left < size &&
        compareSampleRows(this.items[left], this.items[worst]) > 0
      ) {
        worst = left;
      }
      if (
        right < size &&
        compareSampleRows(this.items[right], this.items[worst]) > 0
      ) {
        worst = right;
      }
      if (worst === index) {
        break;
      }
      this.swap(index, worst);
      index = worst;
    }
  }

  private swap(left: number, right: number): void {
    const temp = this.items[left];
    this.items[left] = this.items[right];
    this.items[right] = temp;
  }
}

/**
 * Milliseconds elapsed since `timestamp`, or `null` when the signal is absent.
 *
 * Clamped at 0 for the same future-skew reason as `stalenessMs`: a clock skew
 * between the DB and the runtime can put a timestamp marginally in the future,
 * and a negative age would read as a bogus signal rather than "just now". `null`
 * in, `null` out — an absent signal is never coerced into a number the
 * classifier would treat as evidence.
 */
function elapsedMsSince(
  timestamp: Date | null | undefined,
  now: Date
): number | null {
  if (timestamp === null || timestamp === undefined) {
    return null;
  }
  return Math.max(0, now.getTime() - timestamp.getTime());
}
