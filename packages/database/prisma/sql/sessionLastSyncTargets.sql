-- ISS-8554 / PLN-1853 statement 7 — the "Compute Target Freshness" card.
--
-- The ORDERING is the load-bearing part and is carried over verbatim from
-- `last-sync-targets.ts` (ISS-4828), not re-derived:
--
--   * Lead on last_agent_session_sync_attempt_at — the ACCEPTED-sync watermark.
--     It used to lead on last_agent_session_sync_at, the LANDED-DATA watermark,
--     which ISS-4678 narrowed to advance only when session rows actually
--     persist. A live target with nothing new to send therefore sank every hour
--     it stayed idle and was eventually truncated off the page, so a card titled
--     "Freshness" could omit the machines that were syncing fine.
--   * Presence is a TIE-BREAK ONLY, never the lead. A presence-led ordering was
--     tried and rejected in review (PR #4256): the headline "Last Sync" column
--     stopped reading monotonically down the table, and a laptop whose batch was
--     accepted 30 seconds ago and then disconnected ranked below every
--     online-but-idle machine — so on an org with 20+ online targets the
--     freshest sync could be truncated off the page invisibly.
--
-- Both watermarks are selected so the card can label each by what it measures:
-- the attempt clock for "did this target sync", the landed clock for "when did
-- its data last land". A flag chooses which is DISPLAYED; this ordering is
-- server-side and unconditional, and must stay so.
--
-- NULLS LAST in both directions, matching FEA-4330 everywhere else here: a
-- target that has never synced sorts to the end rather than above real maxima.
--
-- The page is deliberately narrow — 20, LAST_SYNC_TARGET_PAGE_SIZE. The card is
-- a freshness affordance, not a fleet inventory, which is exactly why the
-- ordering above has to put the machines an operator cares about inside it.
--
-- SCOPE: models the organisation scope, the cloud-sentinel exclusion, and the
-- team-membership narrowing `buildLastSyncTargetWhere` applies when a teamId is
-- present -- that arm is $4, in the EXISTS below.
--
-- @param {String} $1:organizationId
-- @param {Int} $2:pageSize
-- @param {String} $3:userId?
-- @param {String} $4:teamId?
SELECT
  ct.id,
  ct.machine_name,
  ct.is_online,
  ct.last_seen_at,
  ct.last_agent_session_sync_at,
  ct.last_agent_session_sync_attempt_at,
  u.id    AS user_id,
  u.email AS user_email,
  u.first_name,
  u.last_name,
  u.avatar_url
FROM compute_targets ct
-- INNER, not LEFT: compute_targets.user_id is NOT NULL, and
-- AgentSessionLastSyncTarget.owner is non-nullable. A LEFT JOIN would invite a
-- null the contract cannot carry, and the only ways to publish it are a
-- fabricated placeholder owner or a silently dropped row.
JOIN users u ON u.id = ct.user_id
WHERE ct.organization_id = $1::uuid
  -- FEA-2923: the synthetic per-org "cloud" sentinel is not a synced device.
  AND ct.is_cloud_sentinel = false
  AND ($3::uuid IS NULL OR ct.user_id = $3::uuid)
  AND (
    $4::uuid IS NULL
    OR EXISTS (
      SELECT 1
      FROM team_members tm
      WHERE tm.user_id = ct.user_id
        AND tm.team_id = $4::uuid
    )
  )
ORDER BY
  ct.last_agent_session_sync_attempt_at DESC NULLS LAST,
  -- The LANDED-DATA watermark, second. An earlier revision of this statement
  -- dropped it and went straight to presence, which reshuffles the 20-row page
  -- whenever two targets share an attempt timestamp — exactly the truncation
  -- ISS-4828 fixed, reintroduced through the tiebreak instead of the lead.
  ct.last_agent_session_sync_at DESC NULLS LAST,
  ct.is_online DESC,
  -- last_seen_at is NOT NULL; no nulls-last pin needed.
  ct.last_seen_at DESC,
  -- ISS-10165 (review, whitlockk): ASC, matching the live query's terminal
  -- `{ id: "asc" }`. The four keys above are all non-unique, so the terminal key
  -- is what makes the page reproducible -- and it only agrees with the live
  -- ordering if it agrees in DIRECTION too. While this ended DESC, a tied bucket
  -- wider than the 20-row page resolved to a DIFFERENT page here than in the
  -- Prisma query the card is still served from, so the shadow comparison would
  -- report a defect that is an artifact of this line, and a cutover would change
  -- which 20 targets the card shows.
  ct.id ASC
LIMIT $2
