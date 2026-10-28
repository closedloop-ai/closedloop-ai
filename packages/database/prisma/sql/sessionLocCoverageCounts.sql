-- ISS-8554 / PLN-1853 statement 8 — the four counts behind the LOC/$ coverage
-- gate, replacing `readLocPerDollarCoverageCounts`.
--
-- The gate answers "does the divisor we published cover the numerator we
-- divided into it". `foldLocPerDollarCoverage` is pure and is REUSED unchanged;
-- only these counts move to SQL.
--
-- THE POPULATION HERE IS STILL WIDER THAN STATEMENT 6's, though less so since
-- ISS-9904 added the merged-PR requirement below: the LINK ARMS remain wider,
-- and that width is the deliberate part. ISS-7905:
-- `sessionLinkedPopulationArms` is the Metric session->PR arms PLUS a non-prose
-- session->branch link, never the PR arms alone. On lanes where the session<->PR
-- association stays derived via the branch link, the only evidence at rest is
-- the branch link; selecting on the PR arms alone made this card's population
-- empty for those orgs while Insights Delivery, reading the canonical population
-- over the very same rows, rendered a count. A confident null beside live
-- evidence is the defect that ticket fixed, so do not "simplify" this to match
-- statement 6.
--
-- THE PROSE GUARD IS THE SUBTLE PART. "Not prose" must ADMIT a link carrying no
-- `method` key at all — the desktop lane's own at-rest shape, and the majority
-- of the branch arm's population. A bare NOT cannot say that: `metadata->>'method'`
-- is SQL NULL on an absent key, so `NOT (NULL = 'branch_mention_in_prose')` is
-- NULL and Postgres drops the row. The arm would then select only links that
-- spell a non-prose method out — almost nothing — while every in-memory mirror
-- went on admitting them. Hence `COALESCE(metadata ? 'method', FALSE) AND ...`,
-- which is the shape `commandDerivedSessionBranchLinkSql` in
-- apps/api/lib/pull-request-population.ts already uses. Keep the three in
-- lockstep: this, that raw-SQL twin, and `isNonProseSessionBranchLink`.
--
-- The four counts, all over the numerator cohort:
--   numerator            sessions carrying a delivery link (the arms above)
--                        whose linked branch has a MERGED pull request
--                        (ISS-9904). Still not identical to the LOC numerator —
--                        the identity ladder is not applied — see the caveat;
--   covered_numerator    of those, how many the DENOMINATOR's predicate matches
--                        — i.e. sessions the published divisor actually summed.
--                        EQUAL to numerator by construction; see D3 below;
--   migration_pending    of those, how many have a chunked replacement STAGED
--                        and uncommitted (pending_chunk_revision IS NOT NULL);
--   unrevisioned         of those, how many carry no data_revision at all —
--                        derived cost never stamped with a parser revision.
--
-- `covered_numerator` EQUALS `numerator`, and that is the correct answer under
-- D3 (ISS-9754). This is the SESSIONS page: every filter it offers, the date
-- range included, selects SESSIONS. `base` therefore windows on
-- `sd.last_activity_at`, exactly as the three sibling statements that build this
-- card do -- sessionMergedPrLoc, sessionUsageTotals and sessionCostSplit. Since
-- `covered_numerator` re-states the divisor's own predicate over a cohort that
-- has ALREADY passed it, the two counts cannot differ.
--
-- `Missing` is defined by `foldLocPerDollarCoverage` as "numerator sessions the
-- divisor does not sum", derived as numerator - covered. Over one windowed
-- cohort that difference is identically 0, so the state is unreachable BY
-- CONSTRUCTION. Unreachable is the right outcome here, not a bug to engineer
-- around. The state stays in the enum and the field stays on the wire for older
-- clients; it simply never fires (Cosimo, 2026-09-09).
--
-- TWO THINGS THIS DOES NOT CLAIM, because earlier revisions of this comment
-- claimed both and neither is true:
--
--   1. It does NOT claim `numerator` is the LOC numerator. Since ISS-9904 the
--      CTE below DOES read pull_request_detail and DOES require
--      pr_state = 'MERGED', so the 50-branch-linked-sessions-with-no-merged-PR
--      case that used to publish numeratorSessionCount = 51 now publishes 1.
--      What it still does NOT apply is sessionMergedPrLoc's three-arm identity
--      ladder, so a session on a branch that HAS a merged PR but whose link the
--      ladder would not admit is counted here and is not counted by live.
--
--      That residue is structural rather than unfinished work: `scoped_links`
--      discards the session id and `admitted` is DISTINCT ON (identity_key), so
--      the ladder's population is PR-keyed by design and there is no
--      session-level admitted set to reuse. Closing it means restructuring
--      statement 6. Tracked in ISS-9904.
--
--      The equality proved above is still base = base, which is why it is
--      stated as covered = numerator and not as "numerator = divisor".
--
--   2. It does NOT claim a divisor that sums no dollars is impossible.
--      `estimated_cost` is nullable (ISS-8515) and the divisors are
--      `sum(sd.estimated_cost)`, which skips NULLs -- so a windowed,
--      delivery-linked, never-priced session contributes lines and zero dollars
--      while `covered` (a ROW count, not a dollar count) still matches. Live has
--      the same hole; this statement does not close it.
--
-- An earlier revision stripped the window off `base` so the two counts could
-- differ. The observation behind it was correct -- `Missing` WAS unreachable
-- (marisolashgrove on #6281) -- but the remedy inverted the semantics: it made the
-- numerator every delivery-linked session in the org for ALL TIME, so `excluded`
-- became "history minus the selected range" and, since `resolveCoverageState`
-- fires on `excludedSessionCount > 0` with no ratio, an org with one linked
-- session outside the range read `Missing` on every request that did not first
-- trip MigrationPending or Stale, which outrank it. It also cost the index:
-- an unwindowed `base` seq-scans every session row in the table (measured on
-- ISS-9754 at 60k rows -- Seq Scan, 2267 buffers, vs Bitmap Index Scan, 654).
--
-- WHY LIVE STILL REACHES `Missing`, stated correctly. It is NOT the merge
-- window: `resolveNumeratorBranchCohort` only chooses which branches enter the
-- cohort, and it narrows the numerator and the covered count EQUALLY, so it
-- cannot open a gap -- delete it and live reports `Missing` MORE, not never.
-- The gap comes from live reading the two counts over two different session
-- predicates: `deliveryWhere` is built by `stripDateWindow`
-- (in `collectDeliveryPrScope`, delivery-metrics.ts) so an out-of-window session still reaches the
-- numerator scan, while `coveredNumeratorSessionCount` is counted over the
-- windowed `denominatorWhere` (loc-per-dollar-coverage.ts:197-214). D3 says the
-- date range selects sessions, so the numerator must be windowed too -- which is
-- what `base` now does, and what collapses the gap. The differ carries the
-- disagreement as expected movement rather than as a defect.
--
-- migration_pending and unrevisioned move with it, and this is a REAL BEHAVIOUR
-- CHANGE worth stating rather than a footnote: live folds both from the
-- UNWINDOWED `deliveryWhere` rows, this statement counts them over the WINDOWED
-- numerator. Because MigrationPending and Stale both OUTRANK Missing in
-- `resolveCoverageState`, the published state can differ from live for a session
-- whose chunk replacement is staged but whose activity falls outside the range.
-- That divergence is intended under D3 -- the range selects sessions -- but it is
-- NOT covered by the `Missing` reasoning above, and the differ cannot see it
-- (see the note on EXPECTED_MOVEMENT in usage-summary-differ.ts).
--
-- @param {String} $1:organizationId
-- The window bounds are OPTIONAL. `AgentSessionUsageQuery.startDate` and
-- `endDate` are both optional strings, so an unbounded read is a real request
-- and not a caller error; a required bound would have forced a sentinel date,
-- which is a fabricated value pretending to be a filter.
-- @param {DateTime} $2:windowStart?
-- @param {DateTime} $3:windowEnd?
-- $4..$18 are the SHARED facet tuple; see the header of sessionUsageTotals.sql.
-- They narrow `base`, which is BOTH the denominator population and the source of
-- the numerator cohort — so a filtered view's coverage gate is computed over the
-- filtered population, not the org's.
-- @param $4:ownerUserIds
-- @param {DateTime} $5:completedAfter?
-- @param $6:repositories
-- @param $7:harnesses
-- @param $8:models
-- @param $9:projectIds
-- @param {String} $10:teamId?
-- @param $11:changePresence
-- @param $12:prAssociation
-- @param $13:autonomyLowerBounds
-- @param $14:autonomyUpperBounds
-- @param {Boolean} $15:autonomyIncludesNull
-- $16 is THREE-VALUED: NULL is no selection, a non-empty array is the
-- equality set, and an EMPTY array is a selection of display-only statuses no
-- producer persists, which must match nothing. See the facet-common region.
-- @param $16:statuses?
-- @param {String} $17:projectId?
-- @param {String} $18:qualityMode?
-- @param $19:costBucketLowerBounds
-- @param $20:costBucketUpperBounds
-- @param {Boolean} $21:costBucketIncludesUnknown
-- @param $22:subscriptionBillingModes
-- ISS-10332: the priority facet, split into the two arms it resolves to —
-- `= ANY($23)` can never match a NULL priority, so the unset token is its own
-- boolean rather than a member of the list.
-- @param $23:priorityMembers
-- @param {Boolean} $24:priorityIncludesUnset
-- ISS-12251 (PLN-2176 D-4): the `viewerScope=self` scope, matched against
-- Created by, apart from the Owner facet at $4 (which also carries the singular
-- `userId` deep link). See the facet-common region.
-- @param $25:creatorUserIds
-- MATERIALIZED is load-bearing: without it Postgres can inline `base` under the
-- delivery-link EXISTS, probe `session_detail` once per linked session, and
-- apply `last_activity_at` only as a post-lookup filter.
WITH base AS MATERIALIZED (
  SELECT
    sd.artifact_id,
    sd.pending_chunk_revision,
    sd.data_revision
  FROM session_detail sd
  JOIN artifacts a ON a.id = sd.artifact_id
  WHERE a.organization_id = $1::uuid
    -- THE SESSION WINDOW, same predicate as sessionMergedPrLoc and the two cost
    -- statements. Half-open, and NULL-guarded rather than defaulted: an
    -- unbounded read is a real request (see the $2/$3 param notes above).
    AND ($2::timestamp IS NULL OR sd.last_activity_at >= $2)
    AND ($3::timestamp IS NULL OR sd.last_activity_at < $3)
    -- >>> FRAGMENT facet-dimensions (generated — edit prisma/sql-fragments/facet-dimensions.sql)
    -- The four column-valued facet dimensions plus the linked-document Project
    -- facet, as WHERE conjuncts.
    --
    -- NOT spliced into sessionFacetCounts. That statement needs each dimension as a
    -- NAMED BOOLEAN rather than a conjunct, because a facet's own counts must be
    -- computed with its own selection RELAXED and every other selection applied —
    -- cross-filtering. Splicing these there would filter the owner counts by the
    -- owner selection, which reduces every unselected owner to zero and makes the
    -- facet unusable for widening a search. Its flags carry the same column-to-
    -- parameter pairing and `check:typed-sql-fragments` asserts that pairing.
    -- ISS-12251 (PLN-2176 D-1): the Owner facet is the session artifact's assignee,
    -- not `session_detail.user_id`.
    AND (cardinality($4::uuid[]) = 0 OR a.assignee_id = ANY($4::uuid[]))
    AND (cardinality($6::text[]) = 0 OR sd.repository_full_name = ANY($6::text[]))
    AND (cardinality($7::text[]) = 0 OR sd.harness = ANY($7::text[]))
    AND (cardinality($8::text[]) = 0 OR sd.model = ANY($8::text[]))
    -- ISS-5355: the Project facet is the session->document link, NOT
    -- `artifacts.project_id`. Session artifacts are normally unparented, so keying
    -- on the column would exclude every ordinary session.
    --
    -- ISS-9903: BOTH sides of this reach carry the organisation predicate. The
    -- driving `session_detail` row is already org-scoped by the statement's own
    -- WHERE, but this walks a LINK to a SECOND artifact, and neither the link nor
    -- that artifact was constrained. `sessionMergedPrLoc.sql` re-asserts org on
    -- every table it reaches through a link (`p.organization_id = $1::uuid` on the
    -- joined `pull_request_detail`); this dimension was the one that did not, and
    -- the convention is worth more than the redundancy.
    --
    -- It was only ever safe because `artifactLinksService.createLink` asserts both
    -- endpoints of a RELATES_TO link share an org. That is a property of SOME write
    -- paths, not of the schema — `documents/document-service.ts` creates an
    -- ArtifactLink from a caller-supplied `sourceId` with no org check on it — so
    -- the read side should not depend on it. A cross-org link would otherwise pull
    -- another tenant's `project_id` into this org's Project facet.
    --
    -- BOTH PREDICATES ARE COVERED, and each guards a different shape:
    --
    --   `pd.organization_id` catches a link stamped with the CALLER's org whose
    --   target document belongs to another — what a writer that stamps from its
    --   source and never validates its target produces. A confidentiality leak:
    --   another tenant's project_id enters this org's facet.
    --
    --   `pl.organization_id` catches the mirror — a document that IS this org's,
    --   reached by a link row owned by another. Not confidentiality (the project is
    --   ours) but INTEGRITY: another tenant could otherwise place a project into
    --   this org's facet by writing a link this org never created.
    --
    -- An earlier revision of this comment called the second one "defence in depth
    -- with no isolating fixture". That was wrong — the mirror shape isolates it
    -- perfectly well, and `usage-typed-sql-statements.integration.test.ts` now
    -- seeds both. Deleting either line fails that case (whitlockk on #6967).
    AND (
      cardinality($9::uuid[]) = 0
      OR EXISTS (
        SELECT 1
        FROM artifact_links pl
        JOIN artifacts pd
          ON pd.id = pl.target_id
         AND pd.organization_id = $1::uuid
        WHERE pl.source_id = sd.artifact_id
          AND pl.organization_id = $1::uuid
          AND pl.link_type = 'RELATES_TO'
          AND pd.type = 'DOCUMENT'
          AND pd.project_id = ANY($9::uuid[])
      )
    )
    -- <<< FRAGMENT facet-dimensions
    -- >>> FRAGMENT facet-common (generated — edit prisma/sql-fragments/facet-common.sql)
    -- The facets that are plain WHERE conjuncts on EVERY statement, including
    -- sessionFacetCounts: none of them is a counted dimension, so none is
    -- cross-filtered and all of them apply to every arm.
    -- FEA-3009: a completion-time lower bound, on the recorded end.
    AND ($5::timestamp IS NULL OR sd.session_ended_at >= $5)
    -- ISS-12251 (PLN-2176 AC-005, D-4): team scope is whose session it is, so the
    -- member is matched against Created by, not `session_detail.user_id`.
    AND (
      $10::uuid IS NULL
      OR EXISTS (
        SELECT 1
        FROM team_members tm
        WHERE tm.user_id = a.created_by_id
          AND tm.team_id = $10::uuid
      )
    )
    -- FEA-2505 Changes facet. Selecting both options is P OR NOT P, which the
    -- disjunction expresses without a special case.
    AND (
      cardinality($11::text[]) = 0
      OR (
        ('has_changes' = ANY($11::text[]) AND (
          coalesce(sd.files_changed, 0) > 0
          OR coalesce(sd.lines_added, 0) > 0
          OR coalesce(sd.lines_removed, 0) > 0
          OR coalesce(sd.branch_files_changed, 0) > 0
          OR coalesce(sd.branch_lines_added, 0) > 0
          OR coalesce(sd.branch_lines_removed, 0) > 0
        ))
        OR ('no_changes' = ANY($11::text[]) AND (
          coalesce(sd.files_changed, 0) <= 0
          AND coalesce(sd.lines_added, 0) <= 0
          AND coalesce(sd.lines_removed, 0) <= 0
          AND coalesce(sd.branch_files_changed, 0) <= 0
          AND coalesce(sd.branch_lines_added, 0) <= 0
          AND coalesce(sd.branch_lines_removed, 0) <= 0
        ))
      )
    )
    -- FEA-2505 Pull request facet. "Has PR" is the legacy JSON column OR the
    -- canonical session->PR link. ISS-5823 Metric audience: a prose mention is not
    -- the session having a PR, so the two strong arms only — the same pair
    -- `sessionPrLinkKindWhere(Metric)` returns. The `jsonb_typeof(...) = 'array'`
    -- guard is the spelling statement 8 already uses; keep them in lockstep.
    AND (
      cardinality($12::text[]) = 0
      OR (
        ('has_pr' = ANY($12::text[]) AND (
          (sd.pull_requests IS NOT NULL AND sd.pull_requests <> '[]'::jsonb)
          OR EXISTS (
            SELECT 1
            FROM artifact_links prl
            WHERE prl.source_id = sd.artifact_id
              AND prl.link_type = 'RELATES_TO'
              AND (
                prl.metadata ->> 'linkKind' = 'session_pr'
                OR COALESCE(
                     jsonb_typeof(prl.metadata -> 'linkKinds') = 'array'
                     AND prl.metadata -> 'linkKinds' ? 'session_pr_set',
                     FALSE
                   )
              )
          )
        ))
        OR ('no_pr' = ANY($12::text[]) AND NOT (
          (sd.pull_requests IS NOT NULL AND sd.pull_requests <> '[]'::jsonb)
          OR EXISTS (
            SELECT 1
            FROM artifact_links prl
            WHERE prl.source_id = sd.artifact_id
              AND prl.link_type = 'RELATES_TO'
              AND (
                prl.metadata ->> 'linkKind' = 'session_pr'
                OR COALESCE(
                     jsonb_typeof(prl.metadata -> 'linkKinds') = 'array'
                     AND prl.metadata -> 'linkKinds' ? 'session_pr_set',
                     FALSE
                   )
              )
          )
        ))
      )
    )
    -- Autonomy tiers as resolved half-open ranges, paired by position.
    -- `autonomyTierRange` is a TypeScript vocabulary lookup, so the BOUNDS arrive as
    -- parameters and the label set stays in one place — the same reason the
    -- billing-mode vocabularies are parameters on statement 4.
    --
    -- AN ABSENT BOUND ARRIVES AS SQL NULL AND MEANS UNBOUNDED, so each comparison
    -- is guarded rather than written bare. `autonomyTierRange("high")` is `{ gte }`
    -- with no ceiling and `resolveAutonomyTierBounds` spells that
    -- `Number.POSITIVE_INFINITY`, which does not survive serialisation into a
    -- `float8[]` — it arrives NULL, a bare `sd.autonomy < tier.hi` is then NULL
    -- rather than TRUE, and the whole tier selects nothing (tamsinb on #7684).
    -- The guard is also correct if a future driver carries the infinity value
    -- itself, because `x < 'Infinity'::float8` is TRUE.
    AND (
      (cardinality($13::float8[]) = 0 AND NOT $15::boolean)
      OR ($15::boolean AND sd.autonomy IS NULL)
      OR EXISTS (
        SELECT 1
        FROM unnest($13::float8[], $14::float8[]) AS tier(lo, hi)
        WHERE sd.autonomy IS NOT NULL
          AND (tier.lo IS NULL OR sd.autonomy >= tier.lo)
          AND (tier.hi IS NULL OR sd.autonomy < tier.hi)
      )
    )
    -- ISS-10629 / PLN-1853 D13: `statuses` graduated off the TypeScript-resolved
    -- cohort onto a plain equality on the persisted `artifacts.status` column —
    -- the FILTER collapsed to exactly this on the live path in #7603, and there is
    -- no longer a displayed-status projection for this to fork.
    --
    -- THREE-VALUED, unlike every other array facet here, and NULL rather than
    -- empty is the no-op. `resolvePersistedStatusFilter` — the same helper
    -- `applyStatusFacetFilter` builds the live predicate from — returns NULL for
    -- no selection and an EMPTY array when every requested value was a display-only
    -- status no producer persists (`waiting`/`unknown`/`stale`). `= ANY('{}')` is
    -- FALSE for every row, which is this statement's spelling of the live path's
    -- `status: { in: [] }`. Reading empty as "no narrowing" here would return the
    -- whole org for a stale bookmarked `?status=waiting` while the served endpoint
    -- returns nothing, and `artifacts.status` is freeform so rows literally storing
    -- `waiting` exist to be matched (three reviewers on #7684).
    AND (
      $16::text[] IS NULL
      OR a.status = ANY($16::text[])
    )
    -- ISS-10150 / PLN-1853 D13 amendment: `quality` graduated off the cohort above
    -- onto a real predicate. `$18` is "substantive" | "idle" | NULL ("all", no
    -- narrowing). The substantive definition has ONE source —
    -- `SESSION_SUBSTANTIVE_SIGNALS` in `session-substantive-predicate.ts` — and this
    -- region is spliced TWICE from the SAME fragment (once plain, once negated for
    -- the idle complement), so a signal added there cannot leave one arm behind.
    -- Marked `SUBSTANTIVE` rather than `FRAGMENT session-substantive`: the shared
    -- splicer's own markers may not nest (`findRegionEnd` in
    -- splice-sql-fragments-core.mjs rejects an OPEN before the matching CLOSE), so
    -- this region is spliced by hand and verified — both against
    -- `session-substantive.sql` and against `sessionSubstantiveSql("sd")`'s
    -- rendered SQL — by `session-substantive-sql-fragment.test.ts` in `apps/api`,
    -- not by `check:typed-sql-fragments`.
    --
    -- NULL-safe by construction: `turns` is COALESCEd and every other signal column
    -- is NOT NULL, so the OR-chain never evaluates to SQL NULL and `NOT (...)` is a
    -- safe idle complement — no separate hand-written idle predicate to drift from
    -- this one, unlike the Prisma-side `SESSION_IDLE_WHERE`.
    AND (
      $18::text IS NULL
      OR ($18::text = 'substantive' AND (
        -- >>> SUBSTANTIVE (hand-spliced from prisma/sql-fragments/session-substantive.sql — edit there, copy here, verified by session-substantive-sql-fragment.test.ts)
        COALESCE(sd.turns, 0) > 0
        OR sd.input_tokens > 0
        OR sd.output_tokens > 0
        OR sd.cache_read_tokens > 0
        OR sd.cache_write_tokens > 0
        OR sd.tool_use_count > 0
        OR sd.component_invocation_count > 0
        -- <<< SUBSTANTIVE
      ))
      OR ($18::text = 'idle' AND NOT (
        -- >>> SUBSTANTIVE (hand-spliced from prisma/sql-fragments/session-substantive.sql — edit there, copy here, verified by session-substantive-sql-fragment.test.ts)
        COALESCE(sd.turns, 0) > 0
        OR sd.input_tokens > 0
        OR sd.output_tokens > 0
        OR sd.cache_read_tokens > 0
        OR sd.cache_write_tokens > 0
        OR sd.tool_use_count > 0
        OR sd.component_invocation_count > 0
        -- <<< SUBSTANTIVE
      ))
    )
    -- ISS-5355: `projectId` (singular) is a DIFFERENT dimension from `projectIds`,
    -- not another spelling of it — sending both ANDs them. This one is the session
    -- artifact's OWN parent (`artifacts.project_id`), which is null for essentially
    -- every desktop-synced session; the plural walks the session->document link.
    -- Both are kept because the analytics scope callers still send the singular.
    AND ($17::uuid IS NULL OR a.project_id = $17::uuid)
    -- ISS-7176 / ISS-10753 / PLN-1853 D13: `costBuckets` graduated off the
    -- TypeScript-resolved cohort onto a real predicate, mirroring
    -- `buildCostBucketWhere` in `query-builder.ts`. The numeric buckets arrive as
    -- PARALLEL `float8[]` bound arrays for only the SELECTED buckets, exactly like
    -- the autonomy-tier facet above: `costBucketRawBounds` stays the vocabulary's
    -- single source of truth (bucket edges, half-cent-shifted so the RAW column
    -- predicate matches the 2dp-rounded DISPLAYED cost, FEA-4293) and only its
    -- OUTPUT crosses into SQL. `$21` is whether the caller selected the "Unknown"
    -- pseudo-bucket, which is not a numeric range. No selection at all
    -- (`$19` empty AND `$21` false) means NO cost-bucket narrowing — and so does an
    -- EXHAUSTIVE one, which `resolveCostBucketBounds` resolves to the same empty
    -- bounds because `buildCostBucketWhere` returns a null clause for it and this
    -- predicate is not total enough to stand in for one.
    --
    -- `$20`'s NULL means "this bucket has no ceiling" (the `$50+` bucket, whose
    -- `costBucketRawBounds().lt` is null), which is why the comparison below is
    -- guarded exactly as the autonomy one is — same absent-bound hazard, same fix.
    --
    -- The KNOWN/UNKNOWN split is the SQL twin of `SESSION_COST_KNOWN_WHERE` /
    -- `SESSION_COST_UNKNOWN_WHERE`: a cost is KNOWN when it is a positive priced
    -- amount OR a subscription session that did measurable work (a $0.00
    -- subscription with no work is UNKNOWN, not "≤ $1" — ISS-4481/ISS-4418). Each
    -- copy of the measurable-work test is hand-spliced from the SAME
    -- `session-substantive.sql` source `quality` already splices above, so a
    -- signal added there cannot leave one of these four arms behind — verified by
    -- `session-substantive-sql-fragment.test.ts`, which this amendment widens from
    -- two expected occurrences to four.
    AND (
      (cardinality($19::float8[]) = 0 AND NOT $21::boolean)
      OR (
        $21::boolean
        AND (
          COALESCE(sd.estimated_cost, 0) <= 0
          AND (
            sd.billing_mode IS NULL
            OR NOT (sd.billing_mode = ANY($22::text[]))
            OR (
              sd.billing_mode = ANY($22::text[])
              AND NOT (
                -- >>> SUBSTANTIVE (hand-spliced from prisma/sql-fragments/session-substantive.sql — edit there, copy here, verified by session-substantive-sql-fragment.test.ts)
                COALESCE(sd.turns, 0) > 0
                OR sd.input_tokens > 0
                OR sd.output_tokens > 0
                OR sd.cache_read_tokens > 0
                OR sd.cache_write_tokens > 0
                OR sd.tool_use_count > 0
                OR sd.component_invocation_count > 0
                -- <<< SUBSTANTIVE
              )
            )
          )
        )
      )
      OR EXISTS (
        SELECT 1
        FROM unnest($19::float8[], $20::float8[]) AS bucket(lo, hi)
        WHERE sd.estimated_cost IS NOT NULL
          AND (bucket.lo IS NULL OR sd.estimated_cost >= bucket.lo)
          AND (bucket.hi IS NULL OR sd.estimated_cost < bucket.hi)
          AND (
            sd.estimated_cost > 0
            OR (
              sd.billing_mode = ANY($22::text[])
              AND (
                -- >>> SUBSTANTIVE (hand-spliced from prisma/sql-fragments/session-substantive.sql — edit there, copy here, verified by session-substantive-sql-fragment.test.ts)
                COALESCE(sd.turns, 0) > 0
                OR sd.input_tokens > 0
                OR sd.output_tokens > 0
                OR sd.cache_read_tokens > 0
                OR sd.cache_write_tokens > 0
                OR sd.tool_use_count > 0
                OR sd.component_invocation_count > 0
                -- <<< SUBSTANTIVE
              )
            )
          )
      )
    )
    -- ISS-10332 / ISS-10753: the priority facet, as a predicate rather than a
    -- cohort conjunct. It landed on `main` while this port was open and rode the
    -- D13 artifact-id cohort, which this change deletes — so the narrowing has to be
    -- restated here or a priority-filtered read silently widens to every priority.
    --
    -- Shape mirrors `buildPriorityFacetWhere`: `$23` is the selected MEMBERS and
    -- `$24` whether the caller also picked the unset token. The two cannot share one
    -- list, because `= ANY(...)` never matches NULL — folding "unset" into the
    -- members would select nothing for it. `artifacts.priority` is a Postgres enum,
    -- so the comparison is made on its text rendering to keep this parameter the
    -- same `text[]` shape every other vocabulary facet here uses.
    AND (
      (cardinality($23::text[]) = 0 AND NOT $24::boolean)
      OR ($24::boolean AND a.priority IS NULL)
      OR a.priority::text = ANY($23::text[])
    )
    -- ISS-12251 (PLN-2176 D-4): the `viewerScope=self` scope is Created by. A plain
    -- conjunct rather than a counted dimension, so it narrows every arm, the Owner
    -- arm included.
    AND (cardinality($25::uuid[]) = 0 OR a.created_by_id = ANY($25::uuid[]))
    -- <<< FRAGMENT facet-common
),
numerator AS (
  SELECT b.*
  FROM base b
  WHERE EXISTS (
    SELECT 1
    FROM artifact_links al
    WHERE al.source_id = b.artifact_id
      AND al.link_type = 'RELATES_TO'
      AND (
        -- Metric session->PR arms.
        al.metadata ->> 'linkKind' = 'session_pr'
        OR COALESCE(
             jsonb_typeof(al.metadata -> 'linkKinds') = 'array'
             AND al.metadata -> 'linkKinds' ? 'session_pr_set',
             FALSE
           )
        -- ISS-7905 branch arm, with the prose guard spelled out.
        OR (
          (
            al.metadata ->> 'linkKind' = 'session_branch'
            OR COALESCE(
                 jsonb_typeof(al.metadata -> 'linkKinds') = 'array'
                 AND al.metadata -> 'linkKinds' ? 'session_branch',
                 FALSE
               )
          )
          AND NOT (
            COALESCE(al.metadata ? 'method', FALSE)
            AND al.metadata ->> 'method' IN (
              'pr_mention_in_prose',
              'branch_mention_in_prose'
            )
          )
        )
      )
      -- ISS-9904: the linked branch must actually carry a MERGED pull request.
      --
      -- Without this the cohort was "every session carrying a delivery link",
      -- which is strictly wider than the sessions whose PRs produced the lines
      -- this card divides. That matters because `resolveCoverageState` reports
      -- MigrationPending when ANY numerator session has a staged chunk revision
      -- and Stale when any carries no data_revision, and both OUTRANK the rest --
      -- so a session that contributed no lines could fault a ratio that is in
      -- fact fully covered. `loc-per-dollar-coverage.ts:26-32` names exactly that
      -- failure; live avoids it by scoping to the admitted cohort.
      --
      -- The predicate is `sessionMergedPrLoc.sql`'s own, character for character
      -- (org, MERGED, merged_at, last_verified_at), so the two statements agree
      -- on what "merged" means. D3 is not violated: this is an EXISTENCE check,
      -- and `merged_at IS NOT NULL` bounds nothing -- see ISS-8554 rule 3, which
      -- was clarified for precisely this distinction.
      --
      -- THREE of the four conjuncts have their own fixture in
      -- `usage-typed-sql-statements.integration.test.ts` and are separately
      -- mutation-visible; the shapes exist because the conjuncts otherwise mask
      -- one another (an open PR with no merge timestamp is excluded twice over,
      -- so either check could be deleted unnoticed). `p.organization_id` is the
      -- exception: it is defence in depth with no isolating fixture, since a
      -- foreign-org PR hanging off this org's branch is not a shape any write
      -- path produces. Kept for the same reason ISS-9903 kept its pair -- it can
      -- only narrow -- but it is NOT covered, and a reader should not assume so.
      --
      -- WHAT THIS DOES NOT DO, so nobody reads it as full parity with live: it
      -- does NOT apply the three-arm identity ladder. A session on a branch that
      -- HAS a merged PR but whose link the ladder would not admit is still
      -- counted here and is not counted by live. That residue cannot be closed
      -- from this statement -- `scoped_links` discards the session id and
      -- `admitted` is `DISTINCT ON (identity_key)`, so the ladder's population is
      -- PR-keyed by design and there is no session-level admitted set to reuse.
      -- Closing it means restructuring statement 6, which is tracked separately.
      AND EXISTS (
        SELECT 1
        FROM pull_request_detail p
        WHERE p.branch_artifact_id = al.target_id
          AND p.organization_id = $1::uuid
          AND p.pr_state = 'MERGED'
          AND p.merged_at IS NOT NULL
          AND p.last_verified_at IS NOT NULL
      )
  )
)
SELECT
  count(*)                                                       AS numerator_session_count,
  -- Every numerator row is covered: `base` applied the divisor's own window, so
  -- `excludedSessionCount` (numerator - covered) is identically 0. Kept as a
  -- column rather than dropped so the reader, the fold and the wire contract are
  -- untouched -- the field ships, `Missing` just never fires.
  count(*)                                                       AS covered_numerator_session_count,
  count(*) FILTER (WHERE pending_chunk_revision IS NOT NULL)      AS migration_pending_session_count,
  count(*) FILTER (WHERE data_revision IS NULL)                   AS unrevisioned_session_count
FROM numerator
