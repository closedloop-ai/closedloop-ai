import { Button } from "@repo/design-system/components/ui/button";
import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DashboardRowState } from "./dashboard-row-sections";
import { DashboardRowSkeleton } from "./dashboard-skeletons";
import { DASHBOARD_ROW_LABELS, type DashboardRow } from "./dashboard-tiles";

/**
 * What one dashboard row draws: its data, its own skeleton, or its own failure.
 *
 * ISS-10486. The shell used to stand a page-level gate in front of the rows —
 * any errored section replaced the entire body with a single Retry card, so one
 * failed read deleted every section that had succeeded. With that gate narrowed
 * to "nothing at all to draw", the rows own their own states and a failure costs
 * its own row. ISS-10408 is landing the same split on the desktop shell, which
 * still refuses the whole page on any errored section.
 *
 * The verdict is passed in rather than derived here: a shell also needs the same
 * answer for an element beside a row — the AI-impact card, which reads its OWN
 * `AI_IMPACT_SECTIONS` rather than the stats row's `ROW_SECTIONS` entry, and so
 * resolves through `resolveInsightsSectionsState` while a row resolves through
 * `resolveDashboardRowState`. Both fold the same precedence in the one place.
 */
export function DashboardRowSlot({
  row,
  state,
  onRetry,
  retrying,
  children,
}: {
  row: DashboardRow;
  state: DashboardRowState;
  onRetry: () => void;
  /** A retry is in flight, so the control reports itself busy. */
  retrying: boolean;
  /** The row's real content, drawn once its sections have data. */
  children: ReactNode;
}) {
  if (state === DashboardRowState.Failed) {
    return (
      <DashboardRowDegraded onRetry={onRetry} retrying={retrying} row={row} />
    );
  }
  if (state === DashboardRowState.Loading) {
    return <DashboardRowSkeleton row={row} />;
  }
  return children;
}

/**
 * Built from this page's own card idiom (`rounded-xl border-border/70 bg-card`,
 * the shape every rowmate and the empty state already wear), dashed to mark it
 * as a gap rather than content, so a degraded row reads as part of the dashboard
 * instead of a second error dialect. `onRetry` invalidates exactly the sections
 * THIS ROW reads — `useInsightsSectionRetry` over the row's own `ROW_SECTIONS`
 * list — so one press recovers the section that failed without throwing away
 * the healthy ones the reader is still looking at (27a7c768e7).
 *
 * It NAMES the row. A single failed section degrades every row that reads from
 * it, so a generic sentence would leave a reader facing several identical boxes.
 *
 * THE CONTROL CARRIES THAT NAME TOO, in `aria-label`. The sentence solves this
 * for a reader who can see the card; a bare "Retry" leaves a screen reader user
 * tabbing five identical accessible names with nothing to tell them apart, and
 * leaves any name-addressed locator matching all five (ISS-10486 review). The
 * label is the row's OWN `DASHBOARD_ROW_LABELS` entry — the same words already
 * on screen in the sentence above it — not a second phrasing to keep in sync.
 *
 * `role="status"` on the sentence because the swap is now quiet: before
 * ISS-10486 a failed section replaced the whole page, and after it a background
 * refetch can turn one row from its chart into this card with nothing else on
 * screen changing.
 */
function DashboardRowDegraded({
  onRetry,
  retrying,
  row,
}: {
  onRetry: () => void;
  retrying: boolean;
  row: DashboardRow;
}) {
  return (
    <div className="flex min-h-[112px] flex-col items-center justify-center gap-3 rounded-xl border border-border/70 border-dashed bg-card p-6">
      <p
        aria-live="polite"
        className="text-center text-[var(--muted-foreground)] text-sm"
        role="status"
      >
        {DASHBOARD_ROW_LABELS[row.tour]} is temporarily unavailable.
      </p>
      <Button
        aria-label={`${retrying ? "Retrying" : "Retry"} ${DASHBOARD_ROW_LABELS[row.tour]}`}
        disabled={retrying}
        onClick={onRetry}
        size="sm"
        type="button"
        variant="outline"
      >
        <RefreshCwIcon aria-hidden="true" className="size-3.5" />
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
