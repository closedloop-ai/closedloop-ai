import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import {
  BRANCH_PUSH_METHOD_VALUES,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { Prisma } from "@repo/database";
import { branchListTextCollationSql } from "../branch-list-sql/branch-list-filter-sql";

/**
 * The Postgres half of `resolveBranchIdentities`
 * (`branch-read-service/identity-attribution.ts`), so the Branches list can
 * compute its Collaborator facet in SQL instead of folding the whole corpus in
 * JavaScript. The branch Owner is the branch's assignee (ISS-12463) and is not
 * read here; the observed-push rung below also opens the chain the assignee is
 * seeded from (`branch-owner-seed/branch-owner-seed-sql.ts`).
 *
 * Both fragments are LATERAL join bodies for a query whose FROM already binds
 * `a` (the BRANCH `artifacts` row) and `b` (its `branch_detail` row); every
 * predicate is correlated on `a.id` / `a.organization_id` / `b.first_pushed_at`.
 */

/**
 * The observed-push rung: `observed_owner_key text`, `observed_owner_label
 * text`, `observed_owner_availability text`.
 *
 * `earliest_count = count(*)` and `resolved_count = count(<person key>)` are
 * spelled inline rather than aliased because a SELECT list cannot reference its
 * own output names, and pushing them one level down would move the correlated
 * `a`/`b` references with them.
 *
 * ISS-11737: `b.first_pushed_at` is a TIEBREAK input, not a precondition. The
 * rung used to return NULL whenever it was unset, which is the defect
 * `projectOwner` was fixed for — a branch whose push evidence never reached the
 * column named nobody while branch detail named the person.
 */
export function branchOwnerIdentityLateralSql(): Prisma.Sql {
  return Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT
        observed_push.owner_key AS observed_owner_key,
        observed_push.owner_label AS observed_owner_label,
        observed_push.owner_availability AS observed_owner_availability
      FROM (${observedPushOwnerSql()}) observed_push
    ) branch_owner_identity ON TRUE
  `;
}

/** `stablePersonKey` (`branch-identity.ts:131`) — every person here has a `userId`. */
export function closedloopPersonKeySql(userIdColumn: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${BranchPersonProvider.ClosedLoop}::text || ':' || ${userIdColumn}::text)`;
}

/** `displayUserName` (`apps/api/lib/user-display-name.ts`) over a `users` join, `u` by default. */
export function displayUserNameSql(
  user: Prisma.Sql = Prisma.sql`u`
): Prisma.Sql {
  return Prisma.sql`COALESCE(NULLIF(btrim(concat_ws(' ', ${user}.first_name, ${user}.last_name)), ''), ${user}.email)`;
}

function branchPushMethodSql(): Prisma.Sql {
  return Prisma.sql`al.branch_participation_method IN (${Prisma.join([
    ...BRANCH_PUSH_METHOD_VALUES,
  ])})`;
}

/** Shared Branch evidence join; callers bind the Branch artifact as `a`. */
export function sessionEvidenceLinkJoinSql(): Prisma.Sql {
  return Prisma.sql`
    FROM artifact_links al
    INNER JOIN artifacts session_artifact
      ON session_artifact.id = al.source_id
    INNER JOIN session_detail sd
      ON sd.artifact_id = session_artifact.id
  `;
}

/** Same org, artifact kinds and supported link metadata for Owner and linked comments. */
export function sessionEvidenceLinkPredicateSql(): Prisma.Sql {
  return Prisma.sql`(
    al.organization_id = a.organization_id
    AND al.target_id = a.id
    AND (al.branch_participation IS NULL OR al.branch_participation IN (${BranchParticipationKind.Wrote}, ${BranchParticipationKind.Reviewed}))
    AND al.link_type = ${LinkType.RelatesTo}::"LinkType"
    AND session_artifact.organization_id = a.organization_id
    AND session_artifact.type = ${ArtifactType.Session}::"ArtifactType"
    AND (
      al.metadata ->> 'linkKind' IN (
        ${SessionArtifactLinkKind.SessionPr},
        ${SessionArtifactLinkKind.SessionBranch}
      )
      OR al.metadata -> 'linkKinds' @> ${JSON.stringify([
        SessionArtifactLinkKind.SessionPrSet,
      ])}::jsonb
    )
  )`;
}

/**
 * `authoritativeOwnerLinks` — a SOLE dated push link is authoritative whatever
 * it observed, so the earliest-instant equality applies only once a second one
 * exists. ISS-11737: with no `first_pushed_at` stamp the pin is the links' own
 * earliest observed instant, matching `earliestObservedPush`.
 */
function authoritativeOwnerLinkSql(): Prisma.Sql {
  return Prisma.sql`(
    ${datedPushLinkCountSql()} <= 1
    OR al.branch_participation_observed_at = COALESCE(
      b.first_pushed_at,
      ${earliestObservedPushSql()}
    )
  )`;
}

/**
 * `ownerPersonForLink` (identity-attribution.ts:734) resolves to nobody unless one of the two rows exists.
 *
 * The person behind a push is the pushing session's creator,
 * `session_artifact.created_by_id`, never its assignee: reassigning the session
 * must not move the Branch Owner (ISS-12251, operator ruling 2026-10-13). The
 * JS twin reads the same column through `readPushSessionCreators`.
 */
function ownerPersonKeySql(): Prisma.Sql {
  return Prisma.sql`(
    CASE
      WHEN gc.user_id IS NOT NULL OR u.id IS NOT NULL
        THEN ${closedloopPersonKeySql(Prisma.sql`session_artifact.created_by_id`)}
    END
  )`;
}

function ownerPersonLabelSql(): Prisma.Sql {
  return Prisma.sql`COALESCE(${displayUserNameSql()}, gc.login)`;
}

/**
 * `projectOwner`'s availability, arm for arm: a branch with no push evidence on
 * either input has a COMPLETE corpus that names nobody, and every other branch
 * is complete only once every authoritative link resolved AND the earliest push
 * is identifiable at all.
 */
function ownerAvailabilitySql(): Prisma.Sql {
  return Prisma.sql`(
    CASE
      WHEN b.first_pushed_at IS NULL AND ${branchPushLinkCountSql()} = 0
        THEN ${BranchIdentityAvailability.Complete}::text
      WHEN count(${ownerPersonKeySql()}) > 0
        AND count(${ownerPersonKeySql()}) = count(*)
        AND ${earliestPushIdentifiedSql()}
        THEN ${BranchIdentityAvailability.Complete}::text
      ELSE ${BranchIdentityAvailability.Incomplete}::text
    END
  )`;
}

/**
 * Rung 1 of the Owner chain: the pushing session's creator at the earliest
 * OBSERVED push. Aggregate with no GROUP BY, so it yields exactly one row per
 * branch even when the branch has no push evidence at all — which is what lets
 * the seed's inferred rungs hang off it as a LEFT JOIN rather than a second
 * UNION arm.
 */
export function observedPushOwnerSql(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      (
        array_agg(${ownerPersonKeySql()} ORDER BY ${ownerPersonKeySql()} ${branchListTextCollationSql()})
          FILTER (WHERE ${ownerPersonKeySql()} IS NOT NULL)
      )[1] AS owner_key,
      (
        array_agg(${ownerPersonLabelSql()} ORDER BY ${ownerPersonKeySql()} ${branchListTextCollationSql()})
          FILTER (WHERE ${ownerPersonKeySql()} IS NOT NULL)
      )[1] AS owner_label,
      ${ownerAvailabilitySql()} AS owner_availability
    ${branchKeyedSessionEvidenceLinkJoinSql()}
    LEFT JOIN github_user_connections gc
      ON gc.organization_id = a.organization_id
      AND gc.user_id = session_artifact.created_by_id
    LEFT JOIN users u
      ON u.organization_id = a.organization_id
      AND u.id = session_artifact.created_by_id
    WHERE ${sessionEvidenceLinkPredicateSql()}
      AND ${branchPushMethodSql()}
      AND al.branch_participation_observed_at IS NOT NULL
      AND ${authoritativeOwnerLinkSql()}
  `;
}

/**
 * `earliestPushIdentified` (identity-attribution.ts) — an UNDATED push link is
 * dropped before the earliest-push decision, so with no `first_pushed_at` to pin
 * against, a branch carrying both a dated and an undated push cannot prove the
 * dated one was first.
 */
function earliestPushIdentifiedSql(): Prisma.Sql {
  return Prisma.sql`(
    b.first_pushed_at IS NOT NULL
    OR ${branchPushLinkCountSql()} = ${datedPushLinkCountSql()}
  )`;
}

/** `branchPushLinks` — every push-method evidence link, dated or not. */
function branchPushLinkCountSql(): Prisma.Sql {
  return Prisma.sql`(
    SELECT count(*)
    ${branchKeyedSessionEvidenceLinkJoinSql()}
    WHERE ${sessionEvidenceLinkPredicateSql()}
      AND ${branchPushMethodSql()}
  )`;
}

/** `pushLinks` — the push-method evidence links that carry their instant. */
function datedPushLinkCountSql(): Prisma.Sql {
  return Prisma.sql`(
    SELECT count(*)
    ${branchKeyedSessionEvidenceLinkJoinSql()}
    WHERE ${sessionEvidenceLinkPredicateSql()}
      AND ${branchPushMethodSql()}
      AND al.branch_participation_observed_at IS NOT NULL
  )`;
}

/** `earliestObservedPush` — the pin when `first_pushed_at` was never stamped. */
function earliestObservedPushSql(): Prisma.Sql {
  return Prisma.sql`(
    SELECT min(al.branch_participation_observed_at)
    ${branchKeyedSessionEvidenceLinkJoinSql()}
    WHERE ${sessionEvidenceLinkPredicateSql()}
      AND ${branchPushMethodSql()}
      AND al.branch_participation_observed_at IS NOT NULL
  )`;
}

/**
 * `sessionEvidenceLinkJoinSql` for the observed-push rung, which runs once per
 * branch: each linked session is reached from the branch's own links by its
 * primary key. The `OFFSET 0` fence keeps the planner from driving the join
 * from the organization's SESSION artifacts instead, which stale statistics
 * that put a large organization at one row made it do once per branch, scanning
 * every session the organization has (ISS-12463 C6). The organization and type
 * checks in `sessionEvidenceLinkPredicateSql` still apply, on top.
 */
function branchKeyedSessionEvidenceLinkJoinSql(): Prisma.Sql {
  return Prisma.sql`
    FROM artifact_links al
    CROSS JOIN LATERAL (
      SELECT linked.id, linked.organization_id, linked.type, linked.created_by_id
      FROM artifacts linked
      WHERE linked.id = al.source_id
      OFFSET 0
    ) session_artifact
    INNER JOIN session_detail sd
      ON sd.artifact_id = session_artifact.id
  `;
}
