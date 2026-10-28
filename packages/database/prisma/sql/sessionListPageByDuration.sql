-- ISS-8554 / PLN-1853 Phase 3 (revision 12) — ordered Session list page for the
-- `duration` single-rule sort (D15: single-rule requests only; a compound
-- `sorts` chain keeps the existing in-memory path).
--
-- THE FACET FILTER IS SHARED with the Phase 2 summary statements and with
-- the `updated`/`user` siblings — see sessionUsageTotals.sql's header for the
-- full contract. Same 22-slot prefix ($1-$22) plus the priority facet
-- ($23/$24) and the creator scope ($25, ISS-12251), then this statement's own
-- direction/pagination parameters.
--
-- `duration` mirrors `resolveDisplayDurationMs`/`resolveDisplayDurationEndMs`
-- (`session-display-sort.ts`) byte-for-byte, and the mirror is small because
-- `resolveDisplayedSessionStatus` has no branch left but the 3-way lifecycle
-- fold: ISS-10364 deleted its staleness cutoff and ISS-12430 its end-instant
-- reconciliation, so it reads neither a clock nor a second column.
--
-- The LATERAL computes the DISPLAYED-STATUS-DEPENDENT end instant ONCE per
-- row so it is not repeated across the three places duration_ms needs it
-- (the null-span check, the non-positive-span check, and the value itself) —
-- there is no local-variable syntax in a bare SELECT, and tripling the nested
-- CASE would be the kind of divergence risk this phase exists to close, not
-- a readability trade worth taking.
--
-- `now()` is cast through `AT TIME ZONE 'UTC'` to a naive `timestamp`, the
-- same type `session_ended_at`/`session_started_at` are stored as and the
-- same style every window bound in this statement family compares against —
-- `now()` alone is `timestamptz` and would silently shift under a session
-- time zone other than UTC. `date_trunc` is applied AFTER that cast for the
-- same reason: truncating the `timestamptz` would floor to a minute of the
-- session time zone.
--
-- The running-row clock is FLOORED to the minute, the quantum
-- `durationSortClockMs` applies for drift ACROSS page requests — pinning one
-- `now()` per statement covers one page, not a traversal. The shadow diffs
-- this order against a live page measured on that floored clock, so sharing
-- the quantum is also what keeps a correct order from reading as a mismatch
-- (tamsinb on #8691).
--
-- @param {String} $1:organizationId
-- @param {DateTime} $2:windowStart?
-- @param {DateTime} $3:windowEnd?
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
-- @param $16:statuses?
-- @param {String} $17:projectId?
-- @param {String} $18:qualityMode?
-- @param $19:costBucketLowerBounds
-- @param $20:costBucketUpperBounds
-- @param {Boolean} $21:costBucketIncludesUnknown
-- @param $22:subscriptionBillingModes
-- @param $23:priorityMembers
-- @param {Boolean} $24:priorityIncludesUnset
-- ISS-12251 (PLN-2176 D-4): the `viewerScope=self` scope, matched against
-- Created by, apart from the Owner facet at $4 (which also carries the singular
-- `userId` deep link). See the facet-common region.
-- @param $25:creatorUserIds
-- @param {Boolean} $26:sortDescending
-- @param {Int} $27:pageOffset
-- @param {Int} $28:pageLimit
SELECT
  sd.artifact_id AS artifact_id
FROM session_detail sd
JOIN artifacts a ON a.id = sd.artifact_id
CROSS JOIN LATERAL (
  SELECT
    -- >>> FRAGMENT session-display-duration-end (generated — edit prisma/sql-fragments/session-display-duration-end.sql)
    -- The DISPLAYED-STATUS-DEPENDENT end instant a duration sort key measures to —
    -- `now()` while the row reads as running, its recorded end once terminal.
    -- The live comparator measures running rows against the minute-floored
    -- `durationSortClockMs`, so an unfloored clock here logs a divergence on every
    -- chain carrying `duration` and a running session.
    --
    -- `now()` is cast through `AT TIME ZONE 'UTC'` to a naive `timestamp`, the type
    -- `session_ended_at`/`session_started_at` are stored as — `now()` alone is
    -- `timestamptz` and would shift under a session time zone other than UTC.
    -- `date_trunc` is applied AFTER that cast for the same reason: truncating the
    -- `timestamptz` would floor to a minute of the session time zone.
    CASE
      WHEN (
        -- ISS-10364: every status folds to itself if recognized, and fails
        -- OPEN to 'active' otherwise — the same fold `normalizeSessionStatus`
        -- applies. No other input: a stored 'active' reads as running whatever
        -- `session_ended_at` holds (ISS-12430).
        CASE
          WHEN a.status IN ('active', 'inactive', 'error') THEN a.status
          ELSE 'active'
        END
      ) = 'active'
      THEN date_trunc('minute', now() AT TIME ZONE 'UTC')
      ELSE sd.session_ended_at
    END AS display_duration_end_at
    -- <<< FRAGMENT session-display-duration-end
) dd
WHERE a.organization_id = $1::uuid
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
ORDER BY
  (CASE WHEN $26::boolean THEN -1.0 ELSE 1.0 END)
    * (
      CASE
        WHEN sd.session_started_at IS NULL THEN NULL
        WHEN dd.display_duration_end_at IS NULL THEN NULL
        WHEN EXTRACT(EPOCH FROM (dd.display_duration_end_at - sd.session_started_at)) <= 0
          THEN NULL
        ELSE EXTRACT(EPOCH FROM (dd.display_duration_end_at - sd.session_started_at)) * 1000
      END
    ) ASC NULLS LAST,
  sd.artifact_id DESC
LIMIT $28::int
OFFSET $27::int
