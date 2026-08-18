import type { BranchRow } from "@repo/api/src/types/branch";
import type { SharedBranchesQuery } from "../../shared/shared-branches-contract.js";
import type { BranchUsageEventWindowBounds } from "../database/branch-usage-event-window-sql.js";

/**
 * Request SCOPING for the shared branches reads: which slice of the local corpus
 * a `SharedBranchesQuery` addresses. Owns the fail-closed cloud-filter guard, the
 * date-window predicates (branch rows by canonical Last-active, usage events by
 * their own `createdAt`), and the session-id set that window selects.
 *
 * Split out of `shared-branches-api.ts` (ISS-4737) so the read ops keep the query
 * orchestration and these pure request predicates stay one small, separately
 * readable responsibility. Pure and dependency-free by design — it must stay
 * importable from a plain node test with no Electron runtime.
 */

/**
 * Cloud-only filters have no meaning for the local (self-scoped) source — mirror
 * the agent-sessions fail-closed: a present cloud filter yields the empty
 * canonical response rather than silently ignoring the constraint.
 *
 * DEFERRAL (v1): the facet filters (owner / repo / status / search) are still
 * applied client-side over the full local corpus by the renderer
 * (`useBranchFilterState`); server-side facet filtering lands with the authed
 * REST source. The TIME WINDOW (`startDate` / `endDate`) is honored here over
 * the full canonical Branch corpus before list pagination and by usage and
 * analytics, so every consumer selects the same population.
 */
export function hasUnsupportedCloudFilter(
  request: SharedBranchesQuery
): boolean {
  return Boolean(
    request.userId ||
      request.teamId ||
      request.projectId ||
      request.contributorUserId
  );
}

/** Parse a window bound to epoch ms; absent / unparseable → null (not applied). */
function parseWindowBoundMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Window the projected branch rows to those last active within
 * [`startDate`, `endDate`]. Compares by true INSTANT via `Date.parse` —
 * mirroring the renderer's `filterBranchRowsByWindow` and the wire-side
 * `isoEpoch` sort — because the canonical value may be a mixed timestamp format
 * (space- vs `T`-separated), where a
 * byte-wise compare would mis-drop a recent row (a space `0x20` sorts before
 * `T` `0x54`). A bound that is absent or unparseable is simply not applied; a
 * row whose canonical value is unavailable or unparseable is KEPT rather than
 * silently dropped. With NEITHER bound set (the "All time" window) the rows pass
 * through unchanged, so the all-time output is byte-for-byte intact.
 */
export function filterBranchItemsByWindow(
  items: BranchRow[],
  request: SharedBranchesQuery
): BranchRow[] {
  const startMs = parseWindowBoundMs(request.startDate);
  const endMs = parseWindowBoundMs(request.endDate);
  if (startMs == null && endMs == null) {
    return items;
  }
  return items.filter((item) => {
    const ms = Date.parse(item.canonicalLastActiveAt?.value ?? "");
    if (Number.isNaN(ms)) {
      return true;
    }
    if (startMs != null && ms < startMs) {
      return false;
    }
    return endMs == null || ms <= endMs;
  });
}

/** Union of the session ids across a set of branch rows. */
export function collectSessionIds(items: BranchRow[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    for (const sessionId of item.sessionIds) {
      ids.add(sessionId);
    }
  }
  return ids;
}

/**
 * FEA-4270: window branch AI-SPEND per-EVENT by each usage event's OWN
 * `createdAt` (`token_events.created_at`) so the desktop producer matches the
 * cloud API — a windowed spend read counts ONLY the cost/tokens from turns that
 * actually happened inside the range. A long-running session whose events
 * straddle the boundary contributes exactly its in-window turns, not its whole
 * lifetime spend (the old session-start gate was all-or-nothing and, worse,
 * counted a pre-window session's ENTIRE cost against a recently-active branch).
 * This is what makes the ONE shared Branches card report the SAME windowed AI
 * spend on both adapters (P1 chatgpt-codex #3667842014, reworked to per-event on
 * shafty023's P1).
 *
 * With NEITHER bound set (the "All time" window) rows pass through unchanged — and
 * the caller takes the aggregate lifetime path, never these per-event rows. Under
 * an active window a row whose `createdAt` is null/unparseable is EXCLUDED (an
 * unknown event instant cannot be proven inside a bounded window), mirroring the
 * cloud `tokenEventInDateWindow` null-exclusion so the two producers reconcile
 * AND the windowed total stays equal to the sum of the events shown.
 */
export function filterEventRowsByEventWindow<
  Row extends { createdAt: string | null },
>(rows: Row[], request: SharedBranchesQuery): Row[] {
  const startMs = parseWindowBoundMs(request.startDate);
  const endMs = parseWindowBoundMs(request.endDate);
  if (startMs == null && endMs == null) {
    return rows;
  }
  return rows.filter((row) => {
    if (!row.createdAt) {
      return false;
    }
    const ms = Date.parse(row.createdAt);
    if (Number.isNaN(ms)) {
      return false;
    }
    if (startMs != null && ms < startMs) {
      return false;
    }
    return endMs == null || ms <= endMs;
  });
}

/**
 * FEA-4270: is a date window active? When NO window is set, branch spend uses the
 * aggregate per-`(session, model)` `token_usage` totals (the lifetime fast path —
 * so legacy sessions that have totals but no per-event `token_events` rows still
 * count, matching the cloud lifetime path). When a window IS set, spend is summed
 * from per-event `token_events` rows windowed by each event's `created_at`.
 */
export function isDateWindowActive(request: SharedBranchesQuery): boolean {
  return (
    parseWindowBoundMs(request.startDate) != null ||
    parseWindowBoundMs(request.endDate) != null
  );
}

/**
 * ISS-4941: the active window as canonical ISO bounds the per-event
 * `token_events` read pushes into SQL, so a windowed usage render scans only its
 * own slice instead of hydrating the whole event corpus into the heap-capped
 * db-host. Normalizing through `Date.parse` → `toISOString()` is what makes the
 * SQLite string comparison chronological: the request may carry any parseable
 * form (`2026-06-20`, an offset instant), while the column only ever holds
 * `toISOString()` output.
 *
 * `undefined` when NO bound parses — exactly `!isDateWindowActive(request)`, the
 * all-time path, where the read stays unbounded because the hourly chart needs
 * every event's own timestamp.
 */
export function eventWindowSqlBounds(
  request: SharedBranchesQuery
): BranchUsageEventWindowBounds | undefined {
  const startMs = parseWindowBoundMs(request.startDate);
  const endMs = parseWindowBoundMs(request.endDate);
  if (startMs == null && endMs == null) {
    return;
  }
  return {
    ...(startMs == null ? {} : { startIso: new Date(startMs).toISOString() }),
    ...(endMs == null ? {} : { endIso: new Date(endMs).toISOString() }),
  };
}
