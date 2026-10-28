/**
 * ISS-12552: `branchLaneParticipationKind` (provenance-eligibility.ts) as SQL
 * over an `artifact_links` row aliased `al`, so the flag-on Related Sessions
 * batch read can rank and count per target in the statement instead of
 * loading every link. It yields the link's `BranchParticipationKind`, or NULL
 * where the TypeScript classifier yields none.
 *
 * Each predicate mirrors one persisted-read schema in `@repo/api`
 * (`sessionPrIdentityMetadataSchema`, `sessionPrLinkMetadataSchema`, the
 * `linkKinds` parse) because a failed parse there takes the whole row's
 * participation with it. One divergence is inherent: a lifecycle event's
 * `observedAt` is checked with Postgres' timestamp parser, not `Date.parse`.
 * `link-participation-sql.integration.test.ts` holds the two to each
 * other shape by shape.
 */
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { Prisma } from "@repo/database";

/** The participation `al` states on the branch or pull request lane. */
export function branchLaneParticipationSql(): Prisma.Sql {
  const metadata = Prisma.sql`al.metadata`;
  const stated = Prisma.sql`al.branch_participation IN (${BranchParticipationKind.Wrote}, ${BranchParticipationKind.Reviewed})`;
  return Prisma.sql`CASE
    WHEN ${stated} THEN al.branch_participation
    WHEN NOT (
      (${hasSessionPrLinkKindSql(metadata)} OR ${hasBranchLinkKindSql(metadata)})
      AND ${sessionPrLinkMetadataValidSql(metadata)}
    ) THEN NULL
    WHEN ${metadata}->>'branchParticipation' IN (${BranchParticipationKind.Wrote}, ${BranchParticipationKind.Reviewed})
      THEN ${metadata}->>'branchParticipation'
    WHEN ${metadata}->'relationTypes' ? ${SessionPrRelationType.Created}
      THEN ${BranchParticipationKind.Wrote}
    WHEN ${metadata}->'relationTypes' ? ${SessionPrRelationType.Reviewed}
      THEN ${BranchParticipationKind.Reviewed}
    WHEN ${metadata}->>'relation' IN (${ArtifactRefRelation.Created}, ${ArtifactRefRelation.Output})
      THEN ${BranchParticipationKind.Wrote}
    WHEN ${metadata}->>'method' = ${ArtifactRefMethod.PrReviewFeedbackCommand}
      OR ${metadata}->>'relation' = ${ArtifactRefRelation.Reviewed}
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(${arrayOrEmptySql(Prisma.sql`${metadata}->'branchLifecycleEvents'`)}) AS lifecycle_event
        WHERE lifecycle_event->>'kind' = ${BranchLifecycleBoundaryKind.ReviewFeedback}
      )
      THEN ${BranchParticipationKind.Reviewed}
    ELSE NULL
  END`;
}

/** `hasSessionPrLinkKind`: a valid legacy PR row or a canonical PR set. */
function hasSessionPrLinkKindSql(metadata: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${sessionPrIdentityValidSql(metadata)} AND (
    ${metadata} ? 'prRefs'
    OR (
      NOT COALESCE(${metadata}->'linkKinds' ? ${SessionArtifactLinkKind.SessionPrSet}, false)
      AND COALESCE(${metadata}->>'linkKind' = ${SessionArtifactLinkKind.SessionPr}, false)
      AND (${metadata} ? 'repositoryFullName') = (${metadata} ? 'prNumber')
    )
  ))`;
}

/** The `linkKinds` parse in `branchLaneParticipationKind`, naming the branch lane. */
function hasBranchLinkKindSql(metadata: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE(
    jsonb_typeof(${metadata}) = 'object'
    AND (NOT (${metadata} ? 'linkKind') OR jsonb_typeof(${metadata}->'linkKind') IN ('string', 'null'))
    AND (
      NOT (${metadata} ? 'linkKinds')
      OR jsonb_typeof(${metadata}->'linkKinds') = 'null'
      OR (
        jsonb_typeof(${metadata}->'linkKinds') = 'array'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(${arrayOrEmptySql(Prisma.sql`${metadata}->'linkKinds'`)}) AS link_kind
          WHERE jsonb_typeof(link_kind) <> 'string'
        )
      )
    )
    AND (
      ${metadata}->>'linkKind' = ${SessionArtifactLinkKind.SessionBranch}
      OR COALESCE(${metadata}->'linkKinds' ? ${SessionArtifactLinkKind.SessionBranch}, false)
    ),
    false
  )`;
}

/** `sessionPrIdentityMetadataSchema` parses. */
function sessionPrIdentityValidSql(metadata: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE(
    jsonb_typeof(${metadata}) = 'object'
    AND (
      NOT (${metadata} ? 'linkKind')
      OR ${metadata}->>'linkKind' IN (
        ${SessionArtifactLinkKind.SessionPr},
        ${SessionArtifactLinkKind.SessionPrProse},
        ${SessionArtifactLinkKind.SessionBranch}
      )
    )
    AND (NOT (${metadata} ? 'linkKinds') OR jsonb_typeof(${metadata}->'linkKinds') = 'array')
    AND (NOT (${metadata} ? 'repositoryFullName') OR ${nonEmptyStringSql(Prisma.sql`${metadata}->'repositoryFullName'`)})
    AND (NOT (${metadata} ? 'prNumber') OR ${positiveSafeIntegerSql(Prisma.sql`${metadata}->'prNumber'`)})
    AND (
      NOT (${metadata} ? 'prRefs')
      OR (
        jsonb_typeof(${metadata}->'prRefs') = 'array'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(${arrayOrEmptySql(Prisma.sql`${metadata}->'prRefs'`)}) AS pr_ref
          WHERE NOT ${prRefValidSql(Prisma.sql`pr_ref`)}
        )
      )
    )
    AND (NOT (${metadata} ? 'relationTypes') OR jsonb_typeof(${metadata}->'relationTypes') = 'array'),
    false
  )`;
}

/** `sessionPrLinkMetadataSchema` parses. */
function sessionPrLinkMetadataValidSql(metadata: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${sessionPrIdentityValidSql(metadata)} AND COALESCE(
    (
      NOT (${metadata} ? 'confidence')
      OR CASE
        WHEN jsonb_typeof(${metadata}->'confidence') = 'number'
          THEN (${metadata}->'confidence')::numeric BETWEEN 0 AND 1
        ELSE false
      END
    )
    AND (NOT (${metadata} ? 'method') OR ${nonEmptyStringSql(Prisma.sql`${metadata}->'method'`)})
    AND (
      NOT (${metadata} ? 'branchLifecycleEvents')
      OR (
        jsonb_typeof(${metadata}->'branchLifecycleEvents') = 'array'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(${arrayOrEmptySql(Prisma.sql`${metadata}->'branchLifecycleEvents'`)}) AS lifecycle_event
          WHERE NOT ${lifecycleEventValidSql(Prisma.sql`lifecycle_event`)}
        )
      )
    ),
    false
  ))`;
}

/** `persistedSessionPrRefSchema` parses. */
function prRefValidSql(ref: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE(
    jsonb_typeof(${ref}) = 'object'
    AND ${nonEmptyStringSql(Prisma.sql`${ref}->'repositoryFullName'`)}
    AND ${positiveSafeIntegerSql(Prisma.sql`${ref}->'prNumber'`)}
    AND jsonb_typeof(${ref}->'relationTypes') = 'array'
    AND (NOT (${ref} ? 'method') OR ${nonEmptyStringSql(Prisma.sql`${ref}->'method'`)}),
    false
  )`;
}

/** `syncedBranchLifecycleEventSchema` parses; its `kind` falls back rather than fails. */
function lifecycleEventValidSql(event: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE(
    jsonb_typeof(${event}) = 'object'
    AND (
      NOT (${event} ? 'observedAt')
      OR CASE
        WHEN jsonb_typeof(${event}->'observedAt') = 'string'
          THEN pg_input_is_valid(btrim(${event}->>'observedAt', ' ' || chr(9) || chr(10) || chr(13)), 'timestamptz')
        ELSE false
      END
    )
    AND (NOT (${event} ? 'evidenceId') OR ${nonEmptyStringSql(Prisma.sql`${event}->'evidenceId'`)}),
    false
  )`;
}

function nonEmptyStringSql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(jsonb_typeof(${value}) = 'string' AND ${value}#>>'{}' <> '')`;
}

/** `z.number().int().positive()`, which admits only safe integers. */
function positiveSafeIntegerSql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN jsonb_typeof(${value}) = 'number'
      THEN (${value})::numeric > 0
        AND (${value})::numeric = trunc((${value})::numeric)
        AND (${value})::numeric <= ${Number.MAX_SAFE_INTEGER}
    ELSE false
  END`;
}

/** The array, or an empty one, so `jsonb_array_elements` never sees a scalar. */
function arrayOrEmptySql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END`;
}
