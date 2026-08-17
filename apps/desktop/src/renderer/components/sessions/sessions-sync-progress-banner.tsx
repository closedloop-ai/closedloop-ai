import type { SyncConsentLevel } from "@repo/app/onboarding/components/sync-consent";
import {
  DataSyncLevelValue,
  findDataSyncLevelCopy,
} from "@repo/app/shared/lib/data-sync-copy";
import { Card } from "@closedloop-ai/design-system/components/ui/card";
import {
  Progress,
  ProgressTone,
} from "@closedloop-ai/design-system/components/ui/progress";
import { CheckIcon, EyeOffIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  type CloudSyncProgress,
  useCloudSyncProgress,
} from "../../hooks/use-ingest-progress";
import { describeUndeliverableItems } from "../import-progress-display";
import { useSyncConsentArrival } from "../onboarding/sync-consent-arrival";

/**
 * The Off card's whole text. Honest by construction: it states where the data
 * is and how to change the answer, and shows no bar and no count, because
 * nothing is uploading and a progress bar at 0 would imply something is.
 */
export const SYNC_OFF_MESSAGE =
  "Cloud sync is off. Your sessions stay on this Mac — change this any time in Settings > Data & Sync.";

/** The destination when the org name did not resolve — never an empty hole. */
const UNNAMED_WORKSPACE = "your workspace";

/**
 * ISS-5489 (PLN-1694 M2) — the Sessions landing's acknowledgement of the sync
 * the post-auth takeover just authorized.
 *
 * Renders NOTHING unless this run answered the consent question (see
 * {@link useSyncConsentArrival}), which is what keeps it an arrival
 * acknowledgement rather than a permanent banner — and what gates it behind the
 * `guest-onboarding` flag without a second flag read: the provider that supplies
 * the arrival is mounted only by the flag-gated takeover.
 *
 * Fed by the REAL cloud-sync lane ({@link useCloudSyncProgress}), not the
 * prototype's 450ms timer. That distinction is the point: a fixture bar always
 * reaches 100%, and this one only says "synced" when the lane says the session
 * queues are drained.
 */
export function SessionsSyncProgressBanner(): ReactNode {
  const arrival = useSyncConsentArrival();
  if (arrival === null) {
    return null;
  }
  if (arrival.level === DataSyncLevelValue.Off) {
    return (
      <BannerFrame>
        <Card className="flex-row items-center gap-3 p-4">
          <EyeOffIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <p className="text-muted-foreground text-sm">{SYNC_OFF_MESSAGE}</p>
        </Card>
      </BannerFrame>
    );
  }
  return (
    <SyncingBanner
      level={arrival.level}
      workspaceName={arrival.workspaceName}
    />
  );
}

function BannerFrame({ children }: { children: ReactNode }) {
  return <div className="shrink-0 border-b px-4 py-3">{children}</div>;
}

/**
 * The syncing / synced card, for every level that actually uploads.
 *
 * The counter's denominator is the LARGEST session backlog this banner has seen,
 * because the lane reports what is still owed and never a total — there is no
 * "y" on the wire to read. Deriving it from the peak keeps every number the card
 * prints a real observation: `y` is a backlog that genuinely existed and `x` is
 * how much of it has drained. Before the first non-zero sample there is no
 * honest pair to show, so the card shows the state without a counter or a bar
 * rather than inventing a denominator.
 */
function SyncingBanner({
  level,
  workspaceName,
}: {
  level: Exclude<SyncConsentLevel, typeof DataSyncLevelValue.Off>;
  workspaceName: string | null;
}) {
  const progress = useCloudSyncProgress(true);
  // `null` is NOT zero. A lane that stopped reporting — an older main process, a
  // dropped identity, a corrupt sample — owes an unknown amount, and collapsing
  // that into "0 left" is what made the counter read `N / N` and the bar sit at
  // 100% while the title still said "Syncing": a finished-looking card describing
  // a measurement nobody took.
  const pending = pendingSessions(progress);
  // What has DRAINED so far, accumulated across samples — not a high-water mark
  // of the backlog.
  //
  // The lane reports what is owed and never a total, so a total has to be built.
  // Taking the largest backlog ever seen looked right until work arrived
  // mid-sync: with a peak of 10 and 7 drained, five new sessions pushed pending
  // back to 8 and the counter fell from 7 / 10 to 2 / 10 with the bar retreating
  // behind it. Accumulating the DROPS instead means the numerator can only rise,
  // and the denominator (`completed + pending`) grows to absorb the arrivals —
  // 7 / 10 becomes 7 / 15, which is what actually happened.
  //
  // Render-phase guarded update (the React-endorsed derive-state pattern, as in
  // App.tsx's nav bookkeeping): each sample settles in one extra render.
  const [drain, setDrain] = useState(NO_DRAIN);
  if (pending !== null && pending !== drain.lastPending) {
    setDrain(advanceDrain(drain, pending));
  }

  const destination = workspaceName ?? UNNAMED_WORKSPACE;
  // A dead-letter count that VALIDATED, or null when the sample carried
  // something that cannot be one. The difference matters below: an unreadable
  // count is not a zero, and only a zero earns the success title.
  const undeliverableCount = countOrNull(progress?.deadLetteredSessions ?? 0);
  // `caughtUp` is the session backfill/incremental queues and nothing else — the
  // exact scope of the claim on this card, which is about SESSIONS. It is
  // deliberately not the whole-app `CloudSyncBacklog` the Settings → History
  // Sync cell must consult (ISS-5768): that cell claims the machine owes
  // nothing, and this one only claims your sessions are up.
  //
  // But `caughtUp` alone is not a clean finish. It goes true with sessions
  // dead-lettered, and a corrupt count reads as zero once floored — so on its
  // own it let "Sessions synced" sit above a warning icon and a line saying two
  // items never made it. The success title now needs a COHERENT drained
  // snapshot: measured pending, a dead-letter count that parsed, and that count
  // at zero. Anything less keeps the in-progress title, which under-claims.
  const done =
    progress?.identified === true &&
    progress.caughtUp &&
    pending !== null &&
    undeliverableCount === 0;
  // A pair is printable only when we have both a real backlog to divide by AND a
  // live measurement to subtract. Losing either hides the counter and the bar
  // rather than freezing them at a number that is no longer being observed.
  const total = drain.completed + (pending ?? 0);
  const counted = pending !== null && total > 0;
  const undeliverable = undeliverableCount ?? 0;

  return (
    <BannerFrame>
      <Card className="gap-0 p-4">
        <div className="flex items-center gap-3">
          <StatusIcon done={done} undeliverable={undeliverable} />
          <div aria-live="polite" className="min-w-0 flex-1">
            <p className="font-medium text-sm">
              {done
                ? `Sessions synced to ${destination}`
                : `Syncing your sessions to ${destination}`}
            </p>
            <p className="text-muted-foreground text-xs">
              {detailLine(level, undeliverable)}
            </p>
          </div>
          {counted ? (
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {`${drain.completed.toLocaleString()} / ${total.toLocaleString()}`}
            </span>
          ) : null}
        </div>
        {counted ? (
          <Progress
            aria-label="Sync progress"
            className="mt-3 h-1.5"
            tone={
              undeliverable > 0 ? ProgressTone.Warning : ProgressTone.Default
            }
            value={Math.round((drain.completed / total) * 100)}
          />
        ) : null}
      </Card>
    </BannerFrame>
  );
}

function StatusIcon({
  done,
  undeliverable,
}: {
  done: boolean;
  undeliverable: number;
}) {
  if (undeliverable > 0) {
    return (
      <TriangleAlertIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-warning-foreground"
      />
    );
  }
  if (done) {
    return (
      <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-success" />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 animate-pulse rounded-full bg-primary"
    />
  );
}

/**
 * What is being uploaded, plus anything that could not be.
 *
 * The upload phrase is derived from the SAME per-level copy the takeover's cards
 * render, so the acknowledgement can never describe a different payload from the
 * question that was answered. The failure phrase reuses the existing
 * {@link describeUndeliverableItems} vocabulary rather than inventing a second
 * one — the Settings History Sync cell and the cloud-cutover badge already say
 * it this way.
 */
function detailLine(
  level: Exclude<SyncConsentLevel, typeof DataSyncLevelValue.Off>,
  undeliverable: number
): string {
  const uploading = `Uploading ${findDataSyncLevelCopy(level).badgeLabel.toLowerCase()}`;
  if (undeliverable > 0) {
    return `${uploading}. ${describeUndeliverableItems(undeliverable)}`;
  }
  return uploading;
}

/**
 * The session work still owed across both queues, or `null` when the lane has
 * not measured it.
 *
 * Three unmeasured cases, deliberately not folded into `0`: no snapshot yet (or
 * an older main process that never sends the field), a device the lane has not
 * identified, and a sample carrying a value that cannot be a count. The last one
 * discards the WHOLE sample rather than just the bad field — one corrupt queue
 * makes the total unknowable, and a half-trusted total is a fabricated one.
 */
function pendingSessions(progress: CloudSyncProgress | null): number | null {
  if (progress === null || !progress.identified) {
    return null;
  }
  const backfill = countOrNull(progress.pendingBackfillSessions);
  const incremental = countOrNull(progress.pendingIncrementalSessions);
  if (backfill === null || incremental === null) {
    return null;
  }
  return backfill + incremental;
}

/** A value we are willing to treat as a count, or `null` when it cannot be one. */
function countOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * How much of the backlog has drained, and the sample that reading came from.
 *
 * `completed` is monotone by construction: it moves only on a FALL in the owed
 * count, so work arriving cannot walk the numerator backwards.
 */
type DrainProgress = {
  completed: number;
  /** `null` before the first measured sample — no delta to take yet. */
  lastPending: number | null;
};

const NO_DRAIN: DrainProgress = { completed: 0, lastPending: null };

/**
 * Fold one measured sample in. A drop of N owed sessions is N drained; a rise is
 * new work, which grows the total rather than un-draining anything already done.
 *
 * The first measured sample establishes the baseline and credits nothing: at
 * that point every owed session is still owed, and treating the opening backlog
 * as progress would start the bar somewhere other than zero.
 */
function advanceDrain(current: DrainProgress, pending: number): DrainProgress {
  const drained =
    current.lastPending === null
      ? 0
      : Math.max(0, current.lastPending - pending);
  return { completed: current.completed + drained, lastPending: pending };
}
