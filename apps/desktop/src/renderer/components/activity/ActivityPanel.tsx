import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { Checkbox } from "@closedloop-ai/design-system/components/ui/checkbox";
import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { formatTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { ActivityIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
// Canonical IPC-payload shape from the renderer-safe contract module, so this
// view stays honest against the payload it renders WITHOUT following a
// type-only edge into main-process implementation files.
import type { ActivityEvent } from "../../../shared/activity-panel-contract.js";
import { DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY } from "../../../shared/desktop-requests-live-refresh-flag";
import { useCancelledRef } from "../../hooks/use-cancelled-ref";
import { pageTitleForNav } from "../../navigation/nav-config";
import { NavId } from "../../navigation/route-table";
import { PageShell } from "../layout/page-shell";

export function ActivityPanel() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [readFailures, setReadFailures] =
    useState<ReadFailures>(NO_READ_FAILURES);
  const [showRegular, setShowRegular] = useState(true);
  const [showSecurity, setShowSecurity] = useState(true);

  const liveRefreshEnabled = useFeatureFlagEnabled(
    DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY
  );

  /**
   * Monotonic id of the most recently STARTED load. A response whose id is no
   * longer current is dropped whole, so a slow poll cannot finish after a load
   * that started later and resurrect the request rows the operator had just
   * cleared (whitlockk, #4783). Ignoring superseded responses is cheaper than
   * serializing the loads and keeps Clear/Refresh instant.
   */
  const loadSequenceRef = useRef(0);

  /**
   * ADDITIVE to `loadSequenceRef`, which orders concurrent loads but is never
   * invalidated: nothing bumps it on unmount, so the last load in flight still
   * matches its own sequence and commits. This says "the panel is gone" and
   * nothing about ordering.
   */
  const cancelled = useCancelledRef();

  /**
   * Re-reads events. NEVER rejects — a failed read is recorded in
   * `readFailures`, which is why no call site attaches a rejection handler.
   *
   * `background` distinguishes a poll from a load the user is waiting on. Only
   * a foreground load raises the blocking `loading` state: that state replaces
   * the whole request log with "Loading...", and doing so on every poll made
   * the log flash its rows away on a cadence (review #4783). A background
   * refresh swaps the data in underneath instead.
   */
  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      if (!background) {
        setLoading(true);
      }
      loadSequenceRef.current += 1;
      const sequence = loadSequenceRef.current;
      const [eventsResult] = await Promise.allSettled([
        window.desktopApi.getActivityEvents(),
      ]);
      if (sequence !== loadSequenceRef.current) {
        // A newer load already answered. Committing now would move the view
        // BACKWARDS, so this response is discarded entirely — including its
        // `loading` release, which the newer load owns.
        return;
      }
      if (cancelled.current) {
        return;
      }
      // A failed read is NOT an empty list: the last good rows are left in
      // place and the failure is surfaced next to the log.
      setReadFailures({
        events: !commitRead<ActivityEvent>(eventsResult, setEvents),
      });
      setLoading(false);
    },
    [cancelled]
  );

  useEffect(() => {
    // `load` resolves even on failure (it records `readFailures` itself), so
    // the handler is a belt-and-braces guard, not the error path. Same shape as
    // the sibling Gateway panel, ApprovalsPanel.tsx.
    load().catch(() => {});
  }, [load]);

  useEffect(() => {
    // Requests arrive while this view is open with nothing in the renderer to
    // announce them. Poll while mounted so the view reflects the store rather
    // than the moment it was opened.
    if (!liveRefreshEnabled) {
      return;
    }
    const timer = setInterval(() => {
      load({ background: true }).catch(() => {});
    }, ACTIVITY_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, liveRefreshEnabled]);

  const handleClear = async () => {
    try {
      await window.desktopApi.clearActivityEvents();
    } catch {
      /* reload will pick up current state */
    }
    await load();
  };

  // Failures are only SHOWN behind the Labs gate; `load` tracks them either way
  // so turning the flag on mid-session reports the current state, not a stale
  // one. With the gate closed every flag reads false and each branch below
  // renders exactly what it rendered before the flag existed.
  const failures = liveRefreshEnabled ? readFailures : NO_READ_FAILURES;

  const filtered = events.filter((e) =>
    e.type === "security" ? showSecurity : showRegular
  );

  // FEA-3989: nav label ("Requests") and page heading must name the same
  // destination. This Gateway view was titled "Activity" while its nav entry
  // reads "Requests"; derive the page <h1> from the nav label (pageTitleForNav)
  // so the breadcrumb → title is one source and cannot drift.
  return (
    <PageShell
      actions={
        <div className="flex gap-2">
          <Button
            onClick={() => {
              load().catch(() => {});
            }}
            size="sm"
            variant="outline"
          >
            Refresh
          </Button>
          <Button onClick={handleClear} size="sm" variant="outline">
            Clear Request Log
          </Button>
        </div>
      }
      title={pageTitleForNav(NavId.Requests)}
    >
      <Card>
        <CardHeader>
          <CardTitle>Gateway Request Log</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-4 text-sm">
            <label
              className="flex cursor-pointer items-center gap-2"
              htmlFor="show-regular-events"
            >
              <Checkbox
                checked={showRegular}
                id="show-regular-events"
                onCheckedChange={(checked) => setShowRegular(checked === true)}
              />
              Show Regular Events
            </label>
            <label
              className="flex cursor-pointer items-center gap-2"
              htmlFor="show-security-events"
            >
              <Checkbox
                checked={showSecurity}
                id="show-security-events"
                onCheckedChange={(checked) => setShowSecurity(checked === true)}
              />
              Show Security Events
            </label>
          </div>
          {loading ? (
            <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
              Loading...
            </p>
          ) : filtered.length === 0 ? (
            <ActivityLogEmptyState
              hasHiddenByFilter={events.length > 0}
              readFailed={failures.events}
            />
          ) : (
            <div className="space-y-1">
              {filtered.map((e) => (
                <div
                  className="flex items-start gap-2 border-b p-1.5 text-xs last:border-0"
                  key={e.id}
                >
                  <span className="w-16 shrink-0 text-[var(--muted-foreground)]">
                    {formatActivityTimestamp(e.timestamp)}
                  </span>
                  <span className="w-20 shrink-0 truncate font-medium">
                    {e.method}
                  </span>
                  <span
                    className={`w-9 shrink-0 text-right font-medium tabular-nums ${statusCodeTextClass(e.statusCode)}`}
                  >
                    {e.statusCode}
                  </span>
                  <span className="truncate text-[var(--muted-foreground)]">
                    {e.path}
                    {e.detail ? ` — ${e.detail}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

/**
 * Empty state for the Gateway Request Log. Distinguishes a genuinely
 * empty log from one where every loaded event is hidden behind an unchecked
 * category filter, so the copy never claims "nothing has arrived" while events
 * sit behind a toggle — or, when the read itself failed, that any of it is
 * known at all. The three are different facts and none of them may borrow
 * another's copy.
 */
function ActivityLogEmptyState({
  hasHiddenByFilter,
  readFailed,
}: {
  hasHiddenByFilter: boolean;
  readFailed: boolean;
}) {
  // Checked first: a failed read tells us nothing about whether requests
  // exist, so neither the onboarding nor the filtered copy is true yet.
  if (readFailed) {
    return (
      <EmptyState
        description="The gateway request log could not be read. Retrying automatically."
        icon={ActivityIcon}
        size="compact"
        title={REQUESTS_UNAVAILABLE_TITLE}
      />
    );
  }
  if (hasHiddenByFilter) {
    return (
      <EmptyState
        description="Requests are hidden by the event filters above. Re-enable a category to see them."
        icon={ActivityIcon}
        size="compact"
        title="No requests match the filters"
      />
    );
  }
  return (
    <EmptyState
      description="Gateway requests will appear here as agents make them."
      icon={ActivityIcon}
      size="compact"
      title="No gateway requests yet"
    />
  );
}

function formatActivityTimestamp(timestamp: string | undefined): string {
  return timestamp
    ? formatTimeOrFallback(timestamp, { includeSeconds: true })
    : "";
}

/** Semantic severity bucket for an HTTP status code on a gateway event. */
export function statusCodeSeverity(
  statusCode: number
): "error" | "warning" | "success" | "neutral" {
  if (statusCode >= 500) {
    return "error";
  }
  if (statusCode >= 400) {
    return "warning";
  }
  if (statusCode >= 200 && statusCode < 300) {
    return "success";
  }
  return "neutral";
}

/**
 * Tokenized text-color class for an HTTP status code. The dense gateway log
 * gives the status code weight with color, not a per-row pill — a lighter,
 * faster scan in a tight list. Reuses the success/warning/destructive tokens.
 */
export function statusCodeTextClass(statusCode: number): string {
  switch (statusCodeSeverity(statusCode)) {
    case "error":
      return "text-destructive";
    case "warning":
      return "text-warning-foreground";
    case "success":
      return "text-success";
    default:
      return "text-[var(--muted-foreground)]";
  }
}

/**
 * How often the mounted view re-reads events.
 *
 * These are local IPC reads against an in-process store, not network calls, so
 * the cost is small; the interval only has to be short enough that a request
 * made while someone is looking at the page shows up while they are still
 * looking. Cleared on unmount, and only armed behind the Labs gate.
 */
export const ACTIVITY_REFRESH_INTERVAL_MS = 5000;

/**
 * Title for the request log's read-failure empty state. Kept distinct from the
 * "No gateway requests yet" onboarding copy: a failed read is not evidence that
 * no request has arrived.
 */
export const REQUESTS_UNAVAILABLE_TITLE = "Couldn't read the request log";

/** Whether the events read failed on the last load that was allowed to commit. */
type ReadFailures = {
  events: boolean;
};

/** Nothing failed — also what the closed Labs gate renders. */
const NO_READ_FAILURES: ReadFailures = {
  events: false,
};

/**
 * Commits one settled read into its own state slot, returning whether it
 * succeeded.
 *
 * A rejected read leaves its slot ALONE rather than clearing it, so the last
 * good rows survive instead of vanishing.
 */
function commitRead<T>(
  result: PromiseSettledResult<unknown>,
  apply: (value: T[]) => void
): boolean {
  if (result.status !== "fulfilled") {
    return false;
  }
  apply((result.value as T[]) ?? []);
  return true;
}
