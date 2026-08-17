import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { formatTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import { Checkbox } from "@closedloop-ai/design-system/components/ui/checkbox";
import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import { ActivityIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
// Canonical IPC-payload shapes from the renderer-safe contract module. These
// are the single source of truth (the main/server stores re-export them), so
// this view stays honest against the payload it renders WITHOUT following a
// type-only edge into main/server-only implementation files (which would pull
// electron-store, @closedloop-ai/loops-api, and telemetry into the renderer TS program).
import type {
  ActivityEvent,
  ActivityJob,
  ActivityJobSnapshot,
  LocalJobCommand,
  LocalJobStatus,
} from "../../../shared/activity-panel-contract.js";
import { DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY } from "../../../shared/desktop-requests-live-refresh-flag";
import { pageTitleForNav } from "../../navigation/nav-config";
import { NavId } from "../../navigation/route-table";
import { PageShell } from "../layout/page-shell";

// desktop:list-running-jobs returns ActivityJobSnapshot (job + live fields);
// desktop:list-completed-jobs returns ActivityJob. Both render through the same
// row, so the union of the two is the honest renderer view.
type Job = ActivityJobSnapshot | ActivityJob;

export function ActivityPanel() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [runningJobs, setRunningJobs] = useState<Job[]>([]);
  const [completedJobs, setCompletedJobs] = useState<Job[]>([]);
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
   * longer current is dropped whole.
   *
   * The three reads are independent IPC calls and `listRunningJobs` awaits
   * snapshot enrichment and filesystem work before it answers, so a poll can
   * easily finish after a load that started later — the classic out-of-order
   * overwrite. Left unguarded, a slow poll could resurrect the request rows the
   * operator had just cleared (wongk, #4783). Ignoring superseded responses is
   * cheaper than serializing the loads and keeps Clear/Refresh instant.
   */
  const loadSequenceRef = useRef(0);

  /**
   * Re-reads events and jobs. NEVER rejects — every failure it can observe is
   * recorded in `readFailures`, which is why no call site attaches a rejection
   * handler.
   *
   * Each read is COMMITTED INDEPENDENTLY (`allSettled`, not `all`). A single
   * rejection used to discard the other two fulfilled results and then report
   * the loss as a jobs-read failure whatever had actually failed — so an
   * activity-log outage threw away a perfectly good running-jobs list and told
   * the operator we could not read their jobs (wongk, #4783). Failure is now
   * tracked per source and rendered only where that source is displayed.
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
      const [eventsResult, runningResult, completedResult] =
        await Promise.allSettled([
          window.desktopApi.getActivityEvents(),
          window.desktopApi.listRunningJobs(),
          window.desktopApi.listCompletedJobs(),
        ]);
      if (sequence !== loadSequenceRef.current) {
        // A newer load already answered. Committing now would move the view
        // BACKWARDS, so this response is discarded entirely — including its
        // `loading` release, which the newer load owns.
        return;
      }
      // A failed read is NOT an empty list. Swallowing it rendered "No running
      // jobs" while a loop was demonstrably running, which is the
      // loading/unavailable/true-zero conflation this view must not make. The
      // last good rows for a failed source are left in place and the failure is
      // surfaced next to that source.
      setReadFailures({
        completedJobs: !commitRead<Job>(completedResult, setCompletedJobs),
        events: !commitRead<ActivityEvent>(eventsResult, setEvents),
        runningJobs: !commitRead<Job>(runningResult, setRunningJobs),
      });
      setLoading(false);
    },
    []
  );

  useEffect(() => {
    // `load` resolves even on failure (it records `readFailures` itself), so
    // the handler is a belt-and-braces guard, not the error path. Same shape as
    // the sibling Gateway panel, ApprovalsPanel.tsx.
    load().catch(() => {});
  }, [load]);

  useEffect(() => {
    // Jobs start and finish while this view is open — a web-dispatched loop
    // arrives over the cloud socket with nothing in the renderer to announce
    // it. Loading once on mount meant the page showed its mount-time snapshot
    // forever: with a PLAN loop running and present in the job store, this card
    // still read "No running jobs". Poll while mounted so the view reflects the
    // store rather than the moment it was opened.
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
  // so the breadcrumb → title is one source and cannot drift. The Gateway
  // Request Log leads the page so someone who clicked "Requests" sees the
  // requests first; the running/completed job cards follow. "Clear Request Log"
  // names exactly what the button clears (the request-event log), not the jobs
  // above it.
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
      description="Gateway request log and local job activity."
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
            <div className="max-h-64 space-y-1 overflow-y-auto">
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

      <Card>
        <CardHeader>
          <CardTitle>Running Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {/* A failed read with rows already on screen is the dangerous case:
              the rows stay badged "Running" and nothing says they are a
              snapshot from before the failure. Surfacing this independently of
              whether the list is empty is what stops the panel presenting
              stale state as current (review #4783). */}
          {failures.runningJobs && runningJobs.length > 0 ? (
            <p
              className="mb-3 text-warning-foreground text-xs"
              data-testid="running-jobs-stale-notice"
              role="status"
            >
              {JOBS_STALE_LABEL}
            </p>
          ) : null}
          {runningJobs.length === 0 ? (
            <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
              {failures.runningJobs
                ? JOBS_UNAVAILABLE_LABEL
                : "No running jobs"}
            </p>
          ) : (
            <div className="space-y-2">
              {runningJobs.map((j) => (
                <div
                  className="flex items-center justify-between rounded border p-3 text-sm"
                  key={j.id}
                >
                  <span className="truncate">{deriveJobLabel(j)}</span>
                  <Badge variant={jobStatusVariant(j.status)}>
                    {formatJobStatus(j.status)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <details className="group">
        <summary className="mb-2 cursor-pointer font-medium text-[var(--foreground)] text-sm">
          Completed Jobs ({completedJobs.length})
        </summary>
        <Card className="mt-2">
          <CardContent>
            {completedJobs.length === 0 ? (
              <p className="py-4 text-center text-[var(--muted-foreground)] text-sm">
                {failures.completedJobs
                  ? JOBS_UNAVAILABLE_LABEL
                  : "No completed jobs"}
              </p>
            ) : (
              <div className="max-h-48 space-y-2 overflow-y-auto">
                {completedJobs.map((j) => (
                  <div
                    className="flex items-center justify-between rounded border p-3 text-sm"
                    key={j.id}
                  >
                    <span className="truncate">{deriveJobLabel(j)}</span>
                    <Badge variant={jobStatusVariant(j.status)}>
                      {formatJobStatus(j.status)}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </details>
    </PageShell>
  );
}

/**
 * Empty state for the Gateway Request Log — the page's primary content, so it
 * keeps the full `EmptyState` treatment (the running/completed job sub-panels
 * get a single muted line instead, per review #3663). Distinguishes a genuinely
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

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

/**
 * Human-readable label for a loop command. Sibling desktop views humanize enums
 * before rendering (PlansView → getLightPlanStatusLabel), so the SCREAMING_SNAKE
 * command never reaches the row's loudest text. Exhaustive over LocalJobCommand
 * so a new command must be labeled here to compile.
 */
const COMMAND_LABELS: Record<LocalJobCommand, string> = {
  PLAN: "Plan",
  EXECUTE: "Execute",
  REQUEST_CHANGES: "Request changes",
  DECOMPOSE: "Decompose",
  GENERATE_PRD: "Generate PRD",
};

/**
 * Human-readable label for a job status. Exhaustive over LocalJobStatus so the
 * badge shows "Awaiting user" / "Timed out", never the raw AWAITING_USER enum.
 */
const STATUS_LABELS: Record<LocalJobStatus, string> = {
  QUEUED: "Queued",
  STARTING: "Starting",
  RUNNING: "Running",
  AWAITING_USER: "Awaiting user",
  STOPPED: "Stopped",
  CANCEL_PENDING: "Cancelling",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  UNKNOWN: "Unknown",
  TIMED_OUT: "Timed out",
};

/**
 * Human-readable job label derived from the fields the IPC payload actually
 * carries (a humanized `command` + the first available scope id), falling back
 * to the raw id only when no descriptive field is present. LocalJob/JobSnapshot
 * have no `description` field — rendering one always yielded the opaque id.
 */
export function deriveJobLabel(job: Job): string {
  const command = job.command ? COMMAND_LABELS[job.command] : undefined;
  const scope = job.ticketId ?? job.artifactSlug ?? job.loopId;
  if (command && scope) {
    return `${command} · ${scope}`;
  }
  return command ?? scope ?? job.id;
}

/** Human-readable badge text for a job status. */
export function formatJobStatus(status: LocalJobStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/** Badge variant for a LocalJobStatus (uppercase) or legacy lowercase status. */
export function jobStatusVariant(status?: string): BadgeVariant {
  switch (status?.toUpperCase()) {
    case "RUNNING":
    case "STARTING":
    case "QUEUED":
    case "ACTIVE":
      return "default";
    case "COMPLETED":
    case "SUCCESS":
      return "success";
    case "FAILED":
    case "CANCELLED":
    case "STOPPED":
    case "TIMED_OUT":
      return "error";
    default:
      return "outline";
  }
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
 * faster scan in a tight list. Reuses the same success/warning/destructive
 * tokens the Badge variants use.
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
 * How often the mounted view re-reads events and jobs.
 *
 * These are local IPC reads against an in-process store, not network calls, so
 * the cost is small; the interval only has to be short enough that a job which
 * starts while someone is looking at the page shows up while they are still
 * looking. Cleared on unmount, and only armed behind the Labs gate.
 */
export const ACTIVITY_REFRESH_INTERVAL_MS = 5000;

/**
 * Shown in place of "No running jobs" when the read itself failed and there is
 * nothing cached to show. An empty list and an unavailable list are different
 * facts and must not share copy — the desktop's db-host can exit mid-session
 * (ISS-5808) and take these IPC reads with it, and reporting that as "no
 * running jobs" tells the operator their work is not running when it is.
 */
export const JOBS_UNAVAILABLE_LABEL = "Couldn't read jobs — retrying";

/**
 * Shown ABOVE the rows when a read failed but earlier rows are still on screen.
 * That case is the more dangerous of the two: the rows keep their "Running"
 * badges and look current, so without this line the panel presents a snapshot
 * from before the failure as live state for as long as the retries keep
 * failing (review #4783). Distinct copy from {@link JOBS_UNAVAILABLE_LABEL}
 * because the facts differ — here we have data and cannot vouch for it; there
 * we have none at all.
 */
export const JOBS_STALE_LABEL =
  "Couldn't refresh jobs — showing the last known state";

/**
 * Title for the request log's read-failure empty state. Kept distinct from the
 * "No gateway requests yet" onboarding copy for the same reason as the job
 * labels above: a failed read is not evidence that no request has arrived.
 */
export const REQUESTS_UNAVAILABLE_TITLE = "Couldn't read the request log";

/**
 * Which of the three independent reads failed on the last load that was allowed
 * to commit.
 *
 * One boolean per SOURCE, not one for the load: the reads are separate IPC
 * calls that fail separately, and a shared flag made an activity-log outage
 * render as a jobs-read failure (wongk, #4783). Each card reads only its own
 * source, so no card can speak for another's data.
 */
type ReadFailures = {
  completedJobs: boolean;
  events: boolean;
  runningJobs: boolean;
};

/** Nothing failed — also what the closed Labs gate renders. */
const NO_READ_FAILURES: ReadFailures = {
  completedJobs: false,
  events: false,
  runningJobs: false,
};

/**
 * Commits one settled read into its own state slot, returning whether it
 * succeeded.
 *
 * A rejected read leaves its slot ALONE rather than clearing it, so the last
 * good rows survive to be labelled stale instead of vanishing — dropping them
 * would assert the jobs ended, which is a different lie than the one this view
 * is fixing.
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
