-- ISS-8554 / PLN-1853 statement 5 — the five facet dimensions, in one pass.
--
-- Replaces `facet-count-where.ts` (234 lines) plus the five separate groupBy
-- calls in `usage-summary.ts`. Those five reads become one round trip.
--
-- The rows are BOTH halves of what those groupBys produced: the option list a
-- filter dropdown offers, AND the per-option token/cost breakdown that
-- `AgentSessionUsageByUser` and its siblings publish. An earlier revision of
-- this statement returned counts alone, which silently dropped every `_sum` the
-- Prisma groupBys carried.
--
-- The counts are SELF-EXCLUDING (ISS-5283): each dimension applies every OTHER
-- active filter but not its own, so a filtered facet still lists the options you
-- can widen to instead of collapsing to the one already chosen.
--
-- That rule is why this is a CTE plus a UNION ALL rather than one grouped scan.
-- The CTE evaluates each dimension's predicate ONCE into a named boolean, and
-- each branch below then reads as a plain sentence: "everything except my own".
-- Written as five repeated WHERE clauses instead, the exclusion would be a
-- diff-the-predicate-lists exercise, which is exactly how it became 234 lines of
-- TypeScript.
--
-- EVERY BRANCH RETURNS THE SAME COLUMNS, including sums a given dimension's
-- response type does not publish — `byUser` ignores error_count, `byRepository`
-- ignores the cache columns. A uniform row is what lets the UNION ALL stay
-- readable and the consumer stay a plain mapping; the alternative is five
-- different column lists padded with NULLs, which reads worse and hides which
-- dimension forgot what. The cost is a few unread sums on one scan.
--
-- No coalesce (D10): a null sum means no rows landed in that option.
--
-- An empty array means "no filter on this dimension", matching
-- `cardinality(...) = 0` throughout the rest of these statements.
--
-- SCOPE: this models the five ARRAY facets. `AgentSessionUsageQuery` also
-- carries a SCALAR `projectId`, which `facet-count-where.ts` deliberately does
-- NOT strip for the Project dimension ("`projectId` intentionally survives —
-- see `isFacetDimensionFiltered`"). That asymmetry is viewer scope rather than a
-- facet selection, and it must be carried over when this statement replaces the
-- TypeScript. It is not modelled here yet.
--
-- @param {String} $1:organizationId
-- The window bounds are OPTIONAL. `AgentSessionUsageQuery.startDate` and
-- `endDate` are both optional strings, so an unbounded read is a real request
-- and not a caller error; a required bound would have forced a sentinel date,
-- which is a fabricated value pretending to be a filter.
-- @param {DateTime} $2:windowStart?
-- @param {DateTime} $3:windowEnd?
-- $4..$18 are the SHARED facet tuple; see the header of sessionUsageTotals.sql.
-- The five DIMENSION positions ($4, $6, $7, $8, $9) appear above as `matches_*`
-- flags rather than as conjuncts, for the cross-filtering reason spelled out at
-- the base WHERE. The column-to-parameter pairing is asserted against
-- facet-dimensions.sql by `check:typed-sql-fragments`.
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
WITH base AS (
  SELECT
    a.assignee_id,
    sd.harness,
    sd.repository_full_name,
    sd.model,
    -- A session belongs to a project by its LINKED DOCUMENT, never by the
    -- artifact's own project column. Session artifacts are normally UNPARENTED,
    -- so that column is null for them: keying the Project facet on it leaves the
    -- branch permanently empty AND makes a projectIds filter exclude every
    -- ordinary session. The real edge is the session->document link the detail
    -- view renders as "linked artifacts" (ISS-5236); the definition is
    -- buildProjectLinkWhere in project-link-where.ts — a RELATES_TO link
    -- whose TARGET is a DOCUMENT carrying a project.
    --
    -- AGGREGATED, not joined row-per-project, so `base` is ONE ROW PER SESSION.
    -- A bare `SELECT DISTINCT doc.project_id ... ON TRUE` fanned the session out
    -- across its projects, and every NON-project arm then counted it once per
    -- project -- both the session_count and all six sums (tamsinb on #6281).
    -- DISTINCT still applies INSIDE the aggregate, so five documents in one
    -- project contribute that project once.
    linked.project_ids,
    sd.input_tokens,
    sd.output_tokens,
    sd.cache_read_tokens,
    sd.cache_write_tokens,
    sd.estimated_cost,
    sd.error_count,
    (cardinality($4::uuid[]) = 0 OR a.assignee_id           = ANY($4::uuid[])) AS matches_owner,
    (cardinality($7::text[]) = 0 OR sd.harness              = ANY($7::text[])) AS matches_harness,
    (cardinality($6::text[]) = 0 OR sd.repository_full_name = ANY($6::text[])) AS matches_repository,
    (cardinality($8::text[]) = 0 OR sd.model                = ANY($8::text[])) AS matches_model,
    (cardinality($9::uuid[]) = 0
      OR COALESCE(linked.project_ids && $9::uuid[], FALSE))         AS matches_project
  FROM session_detail sd
  JOIN artifacts a ON a.id = sd.artifact_id
  -- ISS-9903: org-scoped on BOTH the link and the joined artifact. This is the
  -- flag-dialect twin of the fragment's Project conjunct and has the same reach
  -- into a SECOND artifact, so it needs the same predicate — see the fragment's
  -- header for why the write-path invariant is not enough to lean on, and for
  -- the two distinct shapes the two predicates catch. Both are covered by
  -- `usage-typed-sql-statements.integration.test.ts`; deleting either fails it.
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT doc.project_id) AS project_ids
    FROM artifact_links al
    JOIN artifacts doc
      ON doc.id = al.target_id
     AND doc.organization_id = $1::uuid
     AND doc.type = 'DOCUMENT'
     AND doc.project_id IS NOT NULL
    WHERE al.source_id = sd.artifact_id
      AND al.organization_id = $1::uuid
      AND al.link_type = 'RELATES_TO'
  ) linked ON TRUE
  WHERE a.organization_id = $1::uuid
    AND ($2::timestamp IS NULL OR sd.last_activity_at >= $2)
    AND ($3::timestamp IS NULL OR sd.last_activity_at < $3)
    -- The NON-dimension facets narrow `base` for every arm. The five DIMENSION
    -- facets deliberately do not: each is carried as a `matches_*` flag above so
    -- an arm can relax its OWN dimension while applying the other four. That is
    -- cross-filtering, and it is why prisma/sql-fragments/facet-dimensions.sql is
    -- NOT spliced here — as a conjunct it would zero every unselected value and
    -- make the facet useless for widening a search.
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
)
SELECT
  'owner' AS dimension,
  -- ISS-12251 (PLN-2176 D-1): keyed on the assignee, the column the Owner
  -- filter above matches, so an option's count is what selecting it returns.
  assignee_id::text AS value,
  count(*) AS session_count,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(cache_read_tokens) AS cache_read_tokens,
  sum(cache_write_tokens) AS cache_write_tokens,
  sum(estimated_cost) AS estimated_cost,
  sum(error_count) AS error_count
FROM base
WHERE matches_harness AND matches_repository AND matches_model AND matches_project
GROUP BY value

UNION ALL
SELECT 'harness', harness, count(*),
  sum(input_tokens), sum(output_tokens), sum(cache_read_tokens),
  sum(cache_write_tokens), sum(estimated_cost), sum(error_count)
FROM base
WHERE matches_owner AND matches_repository AND matches_model AND matches_project
GROUP BY 2

UNION ALL
SELECT 'repository', repository_full_name, count(*),
  sum(input_tokens), sum(output_tokens), sum(cache_read_tokens),
  sum(cache_write_tokens), sum(estimated_cost), sum(error_count)
FROM base
WHERE matches_owner AND matches_harness AND matches_model AND matches_project
GROUP BY 2

UNION ALL
SELECT 'model', model, count(*),
  sum(input_tokens), sum(output_tokens), sum(cache_read_tokens),
  sum(cache_write_tokens), sum(estimated_cost), sum(error_count)
FROM base
WHERE matches_owner AND matches_harness AND matches_repository AND matches_project
GROUP BY 2

UNION ALL
-- The project arm is the ONE place the fan-out is correct: a session linked to
-- two projects belongs in both buckets. COALESCE keeps the session with NO
-- linked project as a real NULL bucket, which `UsageSqlFacetCount.value`
-- documents as a genuine option rather than an absence.
SELECT 'project', p.project_id::text, count(*),
  sum(input_tokens), sum(output_tokens), sum(cache_read_tokens),
  sum(cache_write_tokens), sum(estimated_cost), sum(error_count)
FROM base
CROSS JOIN LATERAL unnest(
  COALESCE(base.project_ids, ARRAY[NULL]::uuid[])
) AS p(project_id)
WHERE matches_owner AND matches_harness AND matches_repository AND matches_model
GROUP BY 2
