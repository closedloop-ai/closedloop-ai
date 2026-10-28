import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  type BranchTraceSessionHydration,
  BranchTraceSessionHydrationState,
  type BranchTraceState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";

/**
 * ISS-9723: the trace as its producer served it — a Session that lost items to
 * the merged-trace contract keeps every item that parsed, and carries the count
 * of what it lost.
 *
 * The producers always serve this shape and the per-Session drop counts that
 * describe it, so the two halves of the ruling — keep the readable items, and
 * say how many were dropped — arrive together or not at all. Its sibling below
 * reverses it for the closed gate.
 *
 * Two entry points rather than one taking the flag, because the flag must be
 * read once and swapped at the read site — `no-threaded-feature-flag`, and the
 * same shape `buildTraceGroups`/`buildTraceGroupsWithIdleRows` already uses.
 */
export function branchTraceWithPartialSessions(
  result: BranchTraceResult | null | undefined
): BranchTraceResult | null {
  return result ?? null;
}

/**
 * The pre-ISS-9723 shape: a Session that lost items is withheld WHOLE and
 * reported `Malformed`, which is what the producers themselves did before this
 * change and what the existing unavailable-Sessions notice already knows how to
 * say.
 *
 * Reversing here rather than gating the producers is what keeps the surfaces in
 * agreement: the cloud read path and the Desktop main-process builder have no
 * common flag source, so a producer-side gate could resolve differently on each
 * and leave one surface silently partial.
 *
 * WHAT WITHHOLDING CANNOT REPRODUCE. `idle` markers are SYNTHESIZED by the
 * builder over the population it merged, so a marker attributed to a retained
 * Session may have been sized against a withheld Session's activity — a gap the
 * producer, building without that Session, would have measured differently.
 * Reversal cannot recover the number, only refuse to state it, so every
 * synthesized marker is dropped alongside the withheld items rather than
 * carried forward mis-sized. The swimlane is unaffected: `activeIdleSpans`
 * re-derives its own spans from the retained items.
 *
 * `partitionReadableTraceItems` now withdraws those markers at the producer for
 * the same reason, so on a current payload this filter has nothing left to
 * remove. It is NOT dead: this bundle can outrun the deploy it talks to, and a
 * producer predating that withdrawal still serves a drop count alongside the
 * markers it sized over the dropped items. Removing it would reintroduce the
 * mis-sized pause for exactly the skew window it covers.
 */
export function branchTraceWithoutPartialSessions(
  result: BranchTraceResult | null | undefined
): BranchTraceResult | null {
  if (!result) {
    return null;
  }
  const withheldSessionIds = partialSessionIds(result.sessions);
  if (withheldSessionIds.size === 0) {
    return result;
  }
  const sessions = result.sessions.map((session) =>
    withheldSessionIds.has(session.identity.artifactId)
      ? withheldSession(session)
      : session
  );
  const loadedCount = sessions.filter(
    (session) => session.state === BranchTraceSessionHydrationState.Loaded
  ).length;
  return {
    ...result,
    items: result.items.filter(
      (item) => item.type !== "idle" && !withheldSessionIds.has(item.sessionId)
    ),
    sessions,
    completeness: withheldCompleteness(result.completeness, loadedCount),
    aggregateCompleteness: withheldCompleteness(
      result.aggregateCompleteness,
      loadedCount
    ),
  };
}

/**
 * How many items the served trace dropped, across every retained Session.
 *
 * Derived from the per-Session counts rather than carried beside them, so the
 * heading's number and the Sessions it describes cannot disagree.
 */
export function unreadableTraceItemCount(
  // The Session inventory alone, so the page's `BranchTraceResult` and the
  // trace component's `BranchTraceState` both answer this without a cast.
  traceState: Pick<BranchTraceState, "sessions"> | null | undefined
): number {
  if (!traceState) {
    return 0;
  }
  let total = 0;
  for (const session of traceState.sessions) {
    if (session.state === BranchTraceSessionHydrationState.Loaded) {
      total += session.unreadableItemCount ?? 0;
    }
  }
  return total;
}

function partialSessionIds(
  sessions: readonly BranchTraceSessionHydration[]
): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (
      session.state === BranchTraceSessionHydrationState.Loaded &&
      (session.unreadableItemCount ?? 0) > 0
    ) {
      ids.add(session.identity.artifactId);
    }
  }
  return ids;
}

function withheldSession(
  session: BranchTraceSessionHydration
): BranchTraceSessionHydration {
  return {
    identity: session.identity,
    state: BranchTraceSessionHydrationState.Unavailable,
    reason: BranchTraceUnavailableReason.Malformed,
  };
}

/**
 * A withheld Session can only make the trace less complete, never more, so this
 * downgrades and never promotes: `Complete` is unreachable once something was
 * withheld, and a trace with nothing left to draw is `Unavailable` rather than a
 * partial one.
 */
function withheldCompleteness(
  completeness: BranchTraceResult["completeness"],
  loadedCount: number
): BranchTraceResult["completeness"] {
  if (loadedCount === 0) {
    return {
      ...completeness,
      state: BranchTraceCompletenessState.Unavailable,
      reason: completeness.reason ?? BranchTraceUnavailableReason.Malformed,
    };
  }
  return {
    ...completeness,
    state: BranchTraceCompletenessState.Incomplete,
  };
}
