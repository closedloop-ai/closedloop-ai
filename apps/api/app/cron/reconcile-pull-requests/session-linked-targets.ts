import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { Prisma, withDb } from "@repo/database";
import { DESKTOP_PR_FETCHABLE_FACT_COLUMNS } from "@/lib/desktop-pull-request-facts";
import {
  RECONCILE_COVERAGE_GAP_BATCH,
  RECONCILE_DESKTOP_STUB_ATTEMPT_DEBOUNCE_MS,
  RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS,
} from "./constants";
import { DELIVERY_COVERAGE_LOC_FIELDS } from "./delivery-coverage-predicate";

export const RECONCILE_SESSION_LINKED_TARGET_BATCH = 25;

/**
 * Rows of every batch the desktop-stub arm may NOT take (ISS-8423, whitlockk +
 * davetho review; Perrin's call 2026-08-28). The rows {@link
 * stubOnlyAttemptEligibilitySql} selects sort first under `last_verified_at ASC
 * NULLS FIRST`, and a stub the provider will never resolve keeps that position
 * for the life of the row — so without a floor a large enough stub population
 * takes the whole batch on every tick, forever.
 *
 * WHAT IT ACTUALLY RESERVES, which is narrower than the name. The floor caps
 * the PREVIOUSLY-ATTEMPTED stub cohort — the rows the stub arm selects, each
 * already carrying a `last_refresh_attempt_at` inside the 24h window. It hands
 * the remainder to the ORDINARY batch, and it does not order that batch. A stub
 * this same PR's producer writes has BOTH clocks null, so the stub arm's
 * `last_refresh_attempt_at < …` cannot admit it at all: it enters through the
 * ordinary arm's `IS NULL` and sorts ahead of the verified tail INSIDE the
 * reserved rows. Measured on a seeded Postgres — 30 factless post-fix stubs
 * plus 5 verified rows due under the 24h arm returns 25 never-attempted stubs
 * and 0 verified rows. That displacement is transient and bounded, because each
 * such row is attempted once and then belongs to the 24h or 1h cohort, so it
 * delays the tail by ceil(N/25) ticks instead of holding it off forever — which
 * is the difference between it and the defect this floor fixes. Ordering the
 * ordinary batch is a separate change.
 *
 * DERIVATION, from the measured capacity model. One batch is
 * {@link RECONCILE_SESSION_LINKED_TARGET_BATCH} rows per (org, repo) per
 * 15-minute tick = 100 row-selections/hour IN TICKS THAT SWEEP THIS REPO —
 * `selectDueRepos` takes `RECONCILE_REPO_BATCH` repos per tick ordered by
 * `lastSweptAt`, so an org with more due repos than that sees every figure
 * below stretched by its own queueing. At the 1h
 * `RECONCILE_DESKTOP_STUB_ATTEMPT_DEBOUNCE_MS`, S stubs demand S
 * selections/hour, i.e. S/4 per tick.
 *
 *   - The tail must keep a MAJORITY whenever this floor binds: reserve >= 13
 *     (13/25 = 52%). Starvation is the defect being fixed, so the fix must not
 *     mirror it onto the stubs.
 *   - The floor must not throttle the reported population (S ~= 37), which
 *     needs ceil(37/4) = 10 stub rows per tick: reserve <= 25 - 10 = 15.
 *   - 13 is the smallest value satisfying the first, which leaves the most
 *     headroom under the second.
 *
 * AS S GROWS PAST THE CLIFF. The stub arm's share is 25 - 13 = 12 per tick, so
 * stubs stop queueing behind the tail and start queueing behind EACH OTHER at
 * S = 4 x 12 = 48. Past that the per-stub retry interval is S/12 ticks
 * (S x 1.25 minutes) and the 1h debounce stops being what binds — at S = 100 it
 * is ~125 minutes. The tail's 13 is unaffected at any S, which is the point.
 * Per-row backoff (filed separately) only lengthens D for rows that keep
 * failing, which lowers demand and makes this floor bind less often; it does
 * not interact with the split.
 */
export const RECONCILE_VERIFIED_TAIL_BATCH_RESERVE = 13;

export type SessionLinkedPullRequestTarget = {
  pullRequestDetailId: string;
  branchArtifactId: string;
  number: number;
};

export type SelectSessionLinkedPullRequestTargetsInput = {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  now: Date;
  limit?: number;
  branchArtifactId?: string;
  pullRequestDetailId?: string;
  ignoreAttemptDebounce?: boolean;
};

type SessionLinkedPullRequestTargetRow = {
  id: string;
  branchArtifactId: string;
  number: number;
};

/**
 * PRD-683 P0-A: enumerate only PR rows tied to exact session PR evidence.
 * This is deliberately not a repository-history reader; zero qualifying rows
 * means zero provider fetches from this arm (ISS-12292's unlinked-open arm can
 * still add numbers to the targeted tier's point read).
 */
export async function selectSessionLinkedPullRequestTargets(
  input: SelectSessionLinkedPullRequestTargetsInput
): Promise<SessionLinkedPullRequestTarget[]> {
  const repositoryFullName = normalizeRepoFullName(input.repositoryFullName);
  const staleBefore = new Date(
    input.now.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS
  );
  const batch = Math.max(
    1,
    input.limit ?? RECONCILE_SESSION_LINKED_TARGET_BATCH
  );
  // The stub cohort draws first, against its own allowance, so the ordinary
  // arms are always left at least the reserve. Drawing the other way round
  // would hand stubs only the leftover and mirror the starvation onto them.
  const stubBudget = Math.max(0, batch - RECONCILE_VERIFIED_TAIL_BATCH_RESERVE);
  const stubs =
    stubBudget === 0 || input.ignoreAttemptDebounce
      ? []
      : await selectTargetRows(
          input,
          repositoryFullName,
          stubOnlyAttemptEligibilitySql(input, staleBefore),
          stubBudget
        );
  const ordinary = await selectTargetRows(
    input,
    repositoryFullName,
    ordinaryAttemptEligibilitySql(input, staleBefore),
    batch - stubs.length
  );
  // Deliberate ceiling: a short ordinary batch leaves its unused rows idle
  // rather than returning them to the stubs. Worth a second stub query only if
  // a repo is measured draining slowly with a small tail.
  return [...stubs, ...ordinary].map((row) => ({
    pullRequestDetailId: row.id,
    branchArtifactId: row.branchArtifactId,
    number: row.number,
  }));
}

/** One batch of targets under `eligibilitySql`, highest priority first. */
async function selectTargetRows(
  input: SelectSessionLinkedPullRequestTargetsInput,
  repositoryFullName: string,
  eligibilitySql: Prisma.Sql,
  limit: number
): Promise<SessionLinkedPullRequestTargetRow[]> {
  if (limit <= 0) {
    return [];
  }
  return await withDb((db) =>
    db.$queryRaw<SessionLinkedPullRequestTargetRow[]>(Prisma.sql`
      SELECT
        prd.id,
        prd.branch_artifact_id AS "branchArtifactId",
        prd.number
      FROM pull_request_detail prd
      INNER JOIN artifacts branch
        ON branch.id = prd.branch_artifact_id
        AND branch.organization_id = ${input.organizationId}::uuid
        AND branch.type = ${ArtifactType.Branch}::"ArtifactType"
      WHERE prd.organization_id = ${input.organizationId}::uuid
        AND ${repositoryScopeSql(input.repositoryId, repositoryFullName)}
        AND ${exactTargetScopeSql(input)}
        AND ${eligibilitySql}
        AND ${sessionLinkEvidenceSql(input.organizationId, repositoryFullName)}
      ORDER BY
        prd.last_verified_at ASC NULLS FIRST,
        prd.last_refresh_attempt_at ASC NULLS FIRST,
        prd.github_updated_at DESC NULLS LAST,
        prd.id ASC
      LIMIT ${limit}
    `)
  );
}

function exactTargetScopeSql(
  input: SelectSessionLinkedPullRequestTargetsInput
): Prisma.Sql {
  if (input.branchArtifactId && input.pullRequestDetailId) {
    return Prisma.sql`prd.branch_artifact_id = ${input.branchArtifactId}::uuid
      AND branch.id = ${input.branchArtifactId}::uuid
      AND prd.id = ${input.pullRequestDetailId}::uuid`;
  }
  if (input.branchArtifactId) {
    return Prisma.sql`prd.branch_artifact_id = ${input.branchArtifactId}::uuid
      AND branch.id = ${input.branchArtifactId}::uuid`;
  }
  if (input.pullRequestDetailId) {
    return Prisma.sql`prd.id = ${input.pullRequestDetailId}::uuid`;
  }
  return Prisma.sql`TRUE`;
}

/**
 * Arms 1 and 2 — the ordinary attempt debounce, and everything that is not the
 * stub cohort. Together with {@link stubOnlyAttemptEligibilitySql} this exactly
 * partitions the eligible set: the two are disjoint by construction (the stub
 * arm subtracts this one) and their union is the predicate that used to be one
 * `OR`. Nothing is dropped or double-counted by running them as two batches.
 */
function ordinaryAttemptEligibilitySql(
  input: SelectSessionLinkedPullRequestTargetsInput,
  staleBefore: Date
): Prisma.Sql {
  if (input.ignoreAttemptDebounce) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.sql`(
    prd.last_refresh_attempt_at IS NULL
    OR prd.last_refresh_attempt_at < ${staleBefore}
  )`;
}

/**
 * Arm 3 alone: a desktop stub inside its own shorter window that the ordinary
 * arms do NOT already admit. The subtraction is what makes the reserved split
 * safe — a row reachable both ways is charged to the ordinary batch, so it can
 * never consume the stub allowance and appear twice.
 *
 * Empty under `ignoreAttemptDebounce`, because `TRUE` already admits every row;
 * the caller skips the query entirely in that case.
 */
function stubOnlyAttemptEligibilitySql(
  input: SelectSessionLinkedPullRequestTargetsInput,
  staleBefore: Date
): Prisma.Sql {
  const stubStaleBefore = new Date(
    input.now.getTime() - RECONCILE_DESKTOP_STUB_ATTEMPT_DEBOUNCE_MS
  );
  return Prisma.sql`(
    prd.fetch_mechanism = ${GitHubFetchMechanism.DesktopSync}
    AND ${desktopRowWithNoFetchableFactsSql()}
    AND prd.last_refresh_attempt_at < ${stubStaleBefore}
    AND NOT ${ordinaryAttemptEligibilitySql(input, staleBefore)}
  )`;
}

/**
 * A `desktop_sync` row on which every column this reconciler could FILL is
 * still empty — the identity-only stub the desktop lane leaves when a
 * `pull_request` ref carries no facts (ISS-8423).
 *
 * The column list is rendered from `DESKTOP_PR_FETCHABLE_FACT_COLUMNS`, the
 * same map the desktop producer reads to decide whether a write may advance
 * `last_refresh_attempt_at`. That sharing is load-bearing, not tidiness: the
 * producer must decline to move this arm's clock for exactly the rows this arm
 * selects, and a hand-copied list here drifts out of that agreement silently
 * (whitlockk review, 2026-08-28 — a `state`-only ref hit this predicate while its
 * producer kept resetting the clock, so the row never drained).
 *
 * Wider than "the desktop observed nothing", deliberately: `pr_state` and
 * `is_draft` are NOT NULL with column defaults, so no predicate here can tell a
 * state the desktop measured from the default `OPEN` no one measured, and both
 * are therefore absent from the shared map. A ref carrying only `state` is
 * verified by the producer AND still selected here — the right answer for it,
 * because a row with no title, no LOC and none of the twelve
 * `head_repository_default_branch_*` columns still fails cloud branch
 * eligibility. Read this as "nothing to lose by fetching it".
 *
 * Keyed on the emptiness itself rather than on `last_verified_at IS NULL` so
 * that stubs written before the producer stopped claiming verification are
 * selected too; that predicate matched no row in production.
 */
function desktopRowWithNoFetchableFactsSql(): Prisma.Sql {
  // `Prisma.raw` over module constants, never caller input — these are column
  // identifiers, which cannot be bound as parameters.
  return Prisma.sql`(${Prisma.join(
    DESKTOP_PR_FETCHABLE_FACT_COLUMNS.map(
      (column) => Prisma.sql`prd.${Prisma.raw(column)} IS NULL`
    ),
    " AND "
  )})`;
}

function repositoryScopeSql(
  repositoryId: string | null,
  repositoryFullName: string
): Prisma.Sql {
  if (repositoryId) {
    return Prisma.sql`(
      prd.repository_id = ${repositoryId}::uuid
      OR (
        prd.repository_id IS NULL
        AND prd.repository_full_name = ${repositoryFullName}
      )
    )`;
  }
  return Prisma.sql`prd.repository_id IS NULL AND prd.repository_full_name = ${repositoryFullName}`;
}

function commandDerivedPrIdentitySql(repositoryFullName: string): Prisma.Sql {
  return Prisma.sql`(
    (
      link.metadata ->> 'linkKind' = ${SessionArtifactLinkKind.SessionPr}
      AND lower(trim(link.metadata ->> 'repositoryFullName')) = ${repositoryFullName}
      AND ${prNumberMatchesPullRequestSql(Prisma.sql`link.metadata ->> 'prNumber'`)}
      AND NOT (
        COALESCE(link.metadata ? 'method', FALSE)
        AND link.metadata ->> 'method' IN (
          ${ArtifactRefMethod.PrMentionInProse},
          ${ArtifactRefMethod.BranchMentionInProse}
        )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(link.metadata -> 'prRefs') = 'array'
            THEN link.metadata -> 'prRefs'
          ELSE '[]'::jsonb
        END
      ) AS pr_ref(value)
      WHERE lower(trim(pr_ref.value ->> 'repositoryFullName')) = ${repositoryFullName}
        AND ${prNumberMatchesPullRequestSql(Prisma.sql`pr_ref.value ->> 'prNumber'`)}
        AND NOT (
          COALESCE(pr_ref.value ? 'method', FALSE)
          AND pr_ref.value ->> 'method' IN (
            ${ArtifactRefMethod.PrMentionInProse},
            ${ArtifactRefMethod.BranchMentionInProse}
          )
        )
    )
  )`;
}

function sessionBranchLinkSql(organizationId: string): Prisma.Sql {
  return Prisma.sql`link.organization_id = ${organizationId}::uuid
    AND link.target_id = branch.id
    AND link.link_type = ${LinkType.RelatesTo}::"LinkType"
    AND (
      link.branch_participation IS NULL
      OR link.branch_participation = ${BranchParticipationKind.Wrote}
    )`;
}

function sessionBranchPushLinkSql(): Prisma.Sql {
  return Prisma.sql`(
    link.metadata ->> 'linkKind' = ${SessionArtifactLinkKind.SessionBranch}
    OR COALESCE(
      jsonb_typeof(link.metadata -> 'linkKinds') = 'array'
      AND (link.metadata -> 'linkKinds') ? ${SessionArtifactLinkKind.SessionBranch},
      FALSE
    )
  )
  AND NOT (
    COALESCE(link.metadata ? 'method', FALSE)
    AND link.metadata ->> 'method' IN (
      ${ArtifactRefMethod.PrMentionInProse},
      ${ArtifactRefMethod.BranchMentionInProse}
    )
  )`;
}

function commandDerivedPrLinkSql(repositoryFullName: string): Prisma.Sql {
  return Prisma.sql`(
    link.metadata ->> 'linkKind' = ${SessionArtifactLinkKind.SessionPr}
    OR COALESCE(
      jsonb_typeof(link.metadata -> 'linkKinds') = 'array'
      AND (link.metadata -> 'linkKinds') ? ${SessionArtifactLinkKind.SessionPrSet},
      FALSE
    )
  )
  AND ${commandDerivedPrIdentitySql(repositoryFullName)}`;
}

function sessionProsePrLinkSql(
  organizationId: string,
  repositoryFullName: string
): Prisma.Sql {
  return Prisma.sql`prose_link.organization_id = ${organizationId}::uuid
    AND prose_link.target_id = branch.id
    AND prose_link.link_type = ${LinkType.RelatesTo}::"LinkType"
    AND (
      prose_link.metadata ->> 'linkKind' = ${SessionArtifactLinkKind.SessionPrProse}
      OR COALESCE(
        jsonb_typeof(prose_link.metadata -> 'linkKinds') = 'array'
        AND (prose_link.metadata -> 'linkKinds') ? ${SessionArtifactLinkKind.SessionPrProse},
        FALSE
      )
    )
    AND (
      (
        lower(trim(prose_link.metadata ->> 'repositoryFullName')) = ${repositoryFullName}
        AND ${prNumberMatchesPullRequestSql(Prisma.sql`prose_link.metadata ->> 'prNumber'`)}
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(prose_link.metadata -> 'prRefs') = 'array'
              THEN prose_link.metadata -> 'prRefs'
            ELSE '[]'::jsonb
          END
        ) AS prose_ref(value)
        WHERE lower(trim(prose_ref.value ->> 'repositoryFullName')) = ${repositoryFullName}
          AND ${prNumberMatchesPullRequestSql(Prisma.sql`prose_ref.value ->> 'prNumber'`)}
          AND (
            NOT COALESCE(prose_ref.value ? 'method', FALSE)
            OR prose_ref.value ->> 'method' IN (
              ${ArtifactRefMethod.PrMentionInProse},
              ${ArtifactRefMethod.BranchMentionInProse}
            )
          )
      )
    )`;
}

function prNumberMatchesPullRequestSql(valueSql: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${valueSql}) ~ '^[0-9]{1,10}$'
    AND (${valueSql})::bigint <= ${POSTGRES_INT4_MAX}
    AND (${valueSql})::bigint = prd.number`;
}

const POSTGRES_INT4_MAX = 2_147_483_647;

/**
 * Membership test for the tier-2 desktop arm: durable origin, OR the legacy
 * last-writer literal it replaced.
 *
 * `desktop_originated` is the answer (ISS-8462) — `fetch_mechanism` records only
 * how the row was LAST written, so a successful reconcile relabelled it
 * `graphql` and the row fell out of its own arm forever.
 *
 * THE `OR` IS A ROLLOUT COMPATIBILITY SHIM, NOT A SECOND SOURCE OF TRUTH
 * (chatgpt-codex-connector review on #6214). Cloud migrations run in the
 * database package's build-time `prebuild`, so the previous API deployment is
 * still writing to the same database while the new column lands. An old
 * instance that inserts or updates a `desktop_sync` row after the backfill has
 * taken its snapshot leaves `desktop_originated = false`, and without this
 * disjunct the new selector drops that row on its first tick — permanently, if
 * the session never syncs again. Keeping the literal makes the arm's membership
 * a SUPERSET of what `main` admits today, so the change cannot narrow it on any
 * row in any deploy order.
 *
 * DO NOT DELETE THIS WITHOUT EXPLICIT HUMAN APPROVAL (repo Compatibility
 * Guardrail). It is removable only once every writer of this table is on a
 * build that stamps the column and the skew window has drained; that is a
 * separate, human-approved change.
 */
function desktopOriginArmSql(): Prisma.Sql {
  return Prisma.sql`(
    prd.desktop_originated
    OR prd.fetch_mechanism = ${GitHubFetchMechanism.DesktopSync}
  )`;
}

/**
 * Arm 1 alone: an exact command-derived session→PR identity for this row, from
 * a session that wrote to the branch. The coverage-gap selector does not use
 * it: its audience is the coverage reader's, see
 * {@link coverageSessionPrEvidenceSql}.
 */
function commandDerivedSessionPrEvidenceSql(
  organizationId: string,
  repositoryFullName: string
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM artifact_links link
    INNER JOIN artifacts source
      ON source.id = link.source_id
      AND source.organization_id = ${organizationId}::uuid
      AND source.type = ${ArtifactType.Session}::"ArtifactType"
    INNER JOIN session_detail session
      ON session.artifact_id = source.id
    WHERE ${sessionBranchLinkSql(organizationId)}
      AND ${commandDerivedPrLinkSql(repositoryFullName)}
  )`;
}

/**
 * The session→PR evidence a TARGETED tier-2 reconcile target must carry: arm 1
 * above, or the ISS-8462 desktop-origin arm. Extracted (ISS-12034) from the
 * targeted selector's inline `WHERE`; the predicate itself is unchanged.
 */
export function sessionLinkEvidenceSql(
  organizationId: string,
  repositoryFullName: string
): Prisma.Sql {
  return Prisma.sql`(
    ${commandDerivedSessionPrEvidenceSql(organizationId, repositoryFullName)}
    OR (
      ${desktopOriginArmSql()}
      AND EXISTS (
        SELECT 1
        FROM artifact_links link
        INNER JOIN artifacts source
          ON source.id = link.source_id
          AND source.organization_id = ${organizationId}::uuid
          AND source.type = ${ArtifactType.Session}::"ArtifactType"
        INNER JOIN session_detail session
          ON session.artifact_id = source.id
        WHERE ${sessionBranchLinkSql(organizationId)}
          AND ${sessionBranchPushLinkSql()}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM artifact_links prose_link
        INNER JOIN artifacts source
          ON source.id = prose_link.source_id
          AND source.organization_id = ${organizationId}::uuid
          AND source.type = ${ArtifactType.Session}::"ArtifactType"
        INNER JOIN session_detail session
          ON session.artifact_id = source.id
        WHERE ${sessionProsePrLinkSql(organizationId, repositoryFullName)}
      )
    )
  )`;
}

/**
 * The negation of `isDeliveryCoverageCovered`, as SQL — a row the coverage
 * numerator does NOT count.
 *
 * The LOC disjuncts are RENDERED from {@link DELIVERY_COVERAGE_LOC_FIELDS}, not
 * written out, so this predicate cannot drift from the TypeScript numerator that
 * decides the monitored ratio. `Prisma.raw` over that module constant only —
 * these are column identifiers, which cannot be bound as parameters.
 */
function deliveryCoverageGapSql(): Prisma.Sql {
  return Prisma.sql`(
    NOT prd.is_current
    AND (${Prisma.join(
      DELIVERY_COVERAGE_LOC_FIELDS.map(
        ({ column }) => Prisma.sql`prd.${Prisma.raw(column)} IS NULL`
      ),
      " OR "
    )})
  )`;
}

/**
 * ISS-12034: the session-linked PR rows the delivery-coverage numerator does not
 * count, for the INSTALLED tier's by-number refresh.
 *
 * WHY THIS ARM HAD TO EXIST. The installed tier never calls
 * {@link selectSessionLinkedPullRequestTargets} — `reconcileRepo` routes only
 * `UserToken` to the targeted path — so it had two write paths, and neither
 * could reach an uncovered row:
 *
 *   - the windowed history walk passes `stopAtUpdatedAt: watermark` in steady
 *     state, so a PR older than the watermark is never re-read; and
 *   - `selectSelfHealTargets` requires `is_current = true`, while the numerator
 *     counts ANY `is_current` row as covered — so the self-heal population and
 *     the uncovered population are disjoint by construction, and the one arm
 *     that could have healed these rows can never select one.
 *
 * The repo therefore reported `Swept` with `writtenCount 0` and
 * `fetchFailureCount 0` on every tick while its ratio stayed below 1, which is
 * exactly what monitor 316977438 pages on every ~4.5h.
 *
 * WHY THE SESSION→PR ARM ALONE, not the full `sessionLinkEvidenceSql`. The
 * monitored ratio is defined over session→PR links: delivery coverage reads its
 * links with `sessionPrLinkFromSessions`, whose Metric audience admits
 * `session_pr` / `session_pr_set` and nothing else, and
 * `buildSessionPrAdmissionIndex` documents that this caller therefore gets
 * `branchEvidence: false` on every branch. Composing the desktop-origin arm here
 * would select rows the ratio does not measure — measured on a real Postgres: a
 * desktop-synced PR whose session wrote only a `session_branch` link is admitted
 * by that arm while `readGitHubDeliveryCoverageCounts` reports
 * `sessionLinkedPrCount: 0` for the same repo. Those rows may well deserve a
 * refresh, but they are not this monitor's shortfall and healing them here would
 * spend a provider read per tick on coverage no series is watching.
 *
 * SCOPE, stated plainly: this heals a row that EXISTS. A session link naming
 * `repo#N` with no `pull_request_detail` row at all is also counted in the
 * denominator (deliberately — `delivery-coverage-metrics.test.ts` pins it), and
 * nothing here creates one; `readReconcileTargetRows` skips a number with no
 * row, never creates it. That half is untouched and still paging.
 */
export async function selectCoverageGapPullRequestTargets(input: {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  now: Date;
  limit?: number;
}): Promise<SessionLinkedPullRequestTarget[]> {
  const repositoryFullName = normalizeRepoFullName(input.repositoryFullName);
  const staleBefore = new Date(
    input.now.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS
  );
  const limit = Math.max(1, input.limit ?? RECONCILE_COVERAGE_GAP_BATCH);
  const rows = await withDb((db) =>
    db.$queryRaw<SessionLinkedPullRequestTargetRow[]>(Prisma.sql`
      SELECT
        prd.id,
        prd.branch_artifact_id AS "branchArtifactId",
        prd.number
      FROM pull_request_detail prd
      INNER JOIN artifacts branch
        ON branch.id = prd.branch_artifact_id
        AND branch.organization_id = ${input.organizationId}::uuid
        AND branch.type = ${ArtifactType.Branch}::"ArtifactType"
      WHERE prd.organization_id = ${input.organizationId}::uuid
        AND ${coverageGapRepositoryScopeSql(
          input.repositoryId,
          repositoryFullName
        )}
        AND ${deliveryCoverageGapSql()}
        AND (
          prd.last_refresh_attempt_at IS NULL
          OR prd.last_refresh_attempt_at < ${staleBefore}
        )
        AND ${coverageSessionPrEvidenceSql({
          organizationId: input.organizationId,
          repositoryId: input.repositoryId,
          repositoryFullName,
        })}
      ORDER BY
        prd.last_verified_at ASC NULLS FIRST,
        prd.last_refresh_attempt_at ASC NULLS FIRST,
        prd.github_updated_at DESC NULLS LAST,
        prd.id ASC
      LIMIT ${limit}
    `)
  );
  return rows.map((row) => ({
    pullRequestDetailId: row.id,
    branchArtifactId: row.branchArtifactId,
    number: row.number,
  }));
}

/**
 * ISS-12034: the repo scope of the delivery-coverage numerator
 * (`detailRepoScopeWhere`), not the targeted tier's {@link repositoryScopeSql}.
 * With a `repositoryId` the installed tier's write (`readReconcileTargetRows`)
 * and attempt stamp both scope on that id alone, so a repo-less legacy row
 * matched by full name here would be re-selected every tick, never written,
 * never stamped, and sort first under `last_verified_at ASC NULLS FIRST`.
 * ISS-12292's unlinked-open selector uses it for the same reason: it is the
 * write's scope.
 */
export function coverageGapRepositoryScopeSql(
  repositoryId: string | null,
  repositoryFullName: string
): Prisma.Sql {
  if (repositoryId) {
    return Prisma.sql`prd.repository_id = ${repositoryId}::uuid`;
  }
  return Prisma.sql`prd.repository_id IS NULL AND prd.repository_full_name = ${repositoryFullName}`;
}

/**
 * ISS-12034: a session→PR link as the delivery-coverage link reader admits it.
 * That reader (`sessionPrLinkFromSessions`) has no `branch_participation`
 * filter, so a PR linked only by a reviewing session is in the denominator and
 * must be reachable here too, unlike {@link sessionBranchLinkSql}.
 */
function coverageSessionLinkSql(organizationId: string): Prisma.Sql {
  return Prisma.sql`link.organization_id = ${organizationId}::uuid
    AND link.target_id = branch.id
    AND link.link_type = ${LinkType.RelatesTo}::"LinkType"`;
}

/**
 * ISS-12034: the session→PR evidence behind every row the delivery-coverage
 * denominator admits (`buildSessionPrAdmissionIndex` + `sessionLinkedBranches`
 * under the Metric audience): an exact command-derived identity, or the legacy
 * unique-Branch fallback, a `session_pr` link that names no PR on a branch
 * holding exactly one PR row (`allowsUniqueBranchPrFallback`). The legacy link
 * reaches that reader only through its branch's repo scope, so that scope is
 * required here too. The tier-two fallback is not composed: it needs
 * `prd.repository_id IS NULL`, which the installed scope above excludes.
 */
function coverageSessionPrEvidenceSql(input: {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
}): Prisma.Sql {
  const linkSource = Prisma.sql`FROM artifact_links link
    INNER JOIN artifacts source
      ON source.id = link.source_id
      AND source.organization_id = ${input.organizationId}::uuid
      AND source.type = ${ArtifactType.Session}::"ArtifactType"
    INNER JOIN session_detail session
      ON session.artifact_id = source.id`;
  return Prisma.sql`(
    EXISTS (
      SELECT 1
      ${linkSource}
      WHERE ${coverageSessionLinkSql(input.organizationId)}
        AND ${commandDerivedPrLinkSql(input.repositoryFullName)}
    )
    OR (
      (
        SELECT count(*)
        FROM pull_request_detail sibling
        WHERE sibling.branch_artifact_id = branch.id
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM branch_detail branch_scope
        WHERE branch_scope.artifact_id = branch.id
          AND ${branchDetailRepositoryScopeSql(
            input.repositoryId,
            input.repositoryFullName
          )}
      )
      AND EXISTS (
        SELECT 1
        ${linkSource}
        WHERE ${coverageSessionLinkSql(input.organizationId)}
          AND ${legacyUniqueBranchPrLinkSql()}
      )
    )
  )`;
}

/** The SQL twin of `allowsUniqueBranchPrFallback` for a `session_pr` link. */
function legacyUniqueBranchPrLinkSql(): Prisma.Sql {
  return Prisma.sql`(
    link.metadata ->> 'linkKind' = ${SessionArtifactLinkKind.SessionPr}
    AND NOT (link.metadata ? 'prRefs')
    AND NOT (link.metadata ? 'prNumber')
    AND NOT (link.metadata ? 'repositoryFullName')
    AND NOT COALESCE(
      jsonb_typeof(link.metadata -> 'linkKinds') = 'array'
      AND (link.metadata -> 'linkKinds') ? ${SessionArtifactLinkKind.SessionPrSet},
      FALSE
    )
  )`;
}

/** `branchRepoScopeWhere` in the delivery-coverage link reader, as SQL. */
function branchDetailRepositoryScopeSql(
  repositoryId: string | null,
  repositoryFullName: string
): Prisma.Sql {
  if (repositoryId) {
    return Prisma.sql`branch_scope.repository_id = ${repositoryId}::uuid`;
  }
  return Prisma.sql`branch_scope.repository_full_name = ${repositoryFullName}`;
}
