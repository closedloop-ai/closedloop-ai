import { type ProfilerOnRenderCallback, useCallback, useRef } from "react";
import {
  RendererRenderCause,
  RendererRenderPhase,
  type RendererRenderView,
} from "../../../shared/render-commit-event";
import { useRenderCommitReporter } from "./render-commit-telemetry-context";

// FEA-1998: turns a React `<Profiler>` commit into a render-commit wide event.
//
// The interaction `cause` is derived by diffing the view's tracked inputs — but
// the diff runs INSIDE `onRender` (the commit phase), against a ref written only
// there. Render-phase only does idempotent ref writes (`latestRef.current = x`),
// never a non-idempotent prev/next comparison. That ordering is what keeps the
// hook correct under StrictMode's double-rendered render phase (and concurrent
// rendering generally): `onRender` fires once per real commit, so the diff is
// order-correct and never sees a half-applied previous value.

/** Comparable snapshot of the inputs whose change attributes a sessions-list
 * commit to an interaction cause. */
export type SessionsListCauseInputs = {
  page: number;
  search: string | undefined;
  statuses: readonly string[];
  repositories: readonly string[];
  sortKey: string | null;
  sortDir: string;
  dateRange: string;
  isBackgroundRefetch: boolean;
};

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Resolve a single cause for a sessions-list commit from what changed since the
 * previous commit. Specific interactions are checked before pagination on
 * purpose: `SessionsView`'s filter/sort/date-range handlers all reset the page
 * to 0 (`setPage(0)`), so from any non-first page those gestures change `page`
 * together with their own input in the same commit. Checking `page` first would
 * mislabel every such commit as `paginate`; checking it last attributes the
 * commit to the real gesture while a genuine page change (nothing else moved)
 * still falls through to `paginate`. Returns null when nothing tracked changed
 * (a plain rerender). */
export function resolveSessionsListCause(
  prev: SessionsListCauseInputs,
  next: SessionsListCauseInputs
): RendererRenderCause | null {
  if (prev.search !== next.search) {
    return RendererRenderCause.Search;
  }
  if (
    !(
      arraysEqual(prev.statuses, next.statuses) &&
      arraysEqual(prev.repositories, next.repositories)
    )
  ) {
    return RendererRenderCause.Filter;
  }
  if (prev.sortKey !== next.sortKey || prev.sortDir !== next.sortDir) {
    return RendererRenderCause.Sort;
  }
  if (prev.dateRange !== next.dateRange) {
    return RendererRenderCause.DateRange;
  }
  if (prev.page !== next.page) {
    return RendererRenderCause.Paginate;
  }
  // Rising edge only: the placeholder-still-shown commit. The subsequent
  // data-arrival commit (refetch flag falls true→false) is a plain rerender —
  // a best-effort limitation, since that later commit carries the real cost.
  if (next.isBackgroundRefetch && !prev.isBackgroundRefetch) {
    return RendererRenderCause.Refresh;
  }
  return null;
}

/** Tracked input for a session-detail commit. The detail view is keyed by
 * `sessionId` and has no first-class interaction inputs of its own. */
export type SessionsDetailCauseInputs = { sessionId: string };

/** Session detail has no interaction causes of its own: its commits are the
 * first `mount` and then data-arrival/in-place rerenders (including switching to
 * another session, which updates the `sessionId` prop in place). Always returns
 * null (⇒ `rerender`) for non-mount commits. */
export function resolveSessionsDetailCause(): RendererRenderCause | null {
  return null;
}

function normalizeProfilerPhase(
  phase: "mount" | "update" | "nested-update"
): RendererRenderPhase {
  if (phase === "mount") {
    return RendererRenderPhase.Mount;
  }
  if (phase === "nested-update") {
    return RendererRenderPhase.NestedUpdate;
  }
  return RendererRenderPhase.Update;
}

export type UseRenderCommitInstrumentationArgs<TInputs> = {
  view: RendererRenderView;
  itemCount: number;
  causeInputs: TInputs;
  /** Maps (previous, current) tracked inputs to a cause, or null for a plain
   * rerender. Not called on the first commit (always `mount`). */
  resolveCause: (prev: TInputs, next: TInputs) => RendererRenderCause | null;
};

/** Returns a `<Profiler onRender>` callback that emits one render-commit wide
 * event per commit, attributing the interaction cause and rendered item count. */
export function useRenderCommitInstrumentation<TInputs>({
  view,
  itemCount,
  causeInputs,
  resolveCause,
}: UseRenderCommitInstrumentationArgs<TInputs>): ProfilerOnRenderCallback {
  const report = useRenderCommitReporter();

  // Idempotent render-phase writes: capture the latest inputs/count + view +
  // resolver so the stable `onRender` callback reads current values without
  // re-subscribing. Writing the same value N times in a doubled render phase is
  // a no-op, so this is StrictMode-safe.
  const latestRef = useRef<{ itemCount: number; causeInputs: TInputs }>({
    itemCount,
    causeInputs,
  });
  latestRef.current = { itemCount, causeInputs };
  const viewRef = useRef(view);
  viewRef.current = view;
  const resolveCauseRef = useRef(resolveCause);
  resolveCauseRef.current = resolveCause;

  // Written only inside onRender (commit phase) — the previous commit's inputs.
  const committedInputsRef = useRef<TInputs | null>(null);

  return useCallback<ProfilerOnRenderCallback>(
    (_id, phase, actualDuration, baseDuration) => {
      const { itemCount: currentCount, causeInputs: currentInputs } =
        latestRef.current;
      const prevInputs = committedInputsRef.current;
      committedInputsRef.current = currentInputs;

      const cause =
        phase === "mount" || prevInputs === null
          ? RendererRenderCause.Mount
          : (resolveCauseRef.current(prevInputs, currentInputs) ??
            RendererRenderCause.Rerender);

      report({
        view: viewRef.current,
        phase: normalizeProfilerPhase(phase),
        cause,
        itemCount: currentCount,
        actualMs: actualDuration,
        baseMs: baseDuration,
      });
    },
    [report]
  );
}
