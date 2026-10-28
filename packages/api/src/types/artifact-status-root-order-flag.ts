/**
 * ISS-9437 (ISS-4779 closed-by-default policy): gates root-first status ordering on
 * every artifact status sort and status grouping — the Documents table on all four of
 * its render sites (project detail, My Tasks, and the org Documents index in both its
 * v1 and v2 bodies), the Branches list, and the Sessions list on cloud and Desktop.
 * Default OFF, and an unresolved assignment is also OFF.
 *
 * OFF is today's order exactly, including the pre-existing quirk where a Branches row
 * carrying an unrecognized status floats to the TOP on a descending sort. ON, all of
 * those surfaces order by the canonical root rank first
 * (`todo < in_progress < in_review < done < canceled`, unknown last in BOTH directions)
 * with the existing per-vocabulary rank as the tiebreak, so one row sits in the same
 * band wherever it is rendered.
 *
 * ONE key for every surface and both shells. THREE processes resolve it independently,
 * and that is deliberate rather than a gap: `apps/api` through the ISS-7778 server
 * registry, the desktop main process from the flag assignment it already fetches, and
 * each renderer through PostHog. The ordering is decided in three places, so it is read
 * in three places. Desktop main passes the additive, clone-safe `statusOrdering`
 * name to its DB host; omission or an unknown future name keeps vocabulary order.
 * No public request field or external wire contract changes.
 */
export const ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY =
  "artifact-status-root-order" as const;
