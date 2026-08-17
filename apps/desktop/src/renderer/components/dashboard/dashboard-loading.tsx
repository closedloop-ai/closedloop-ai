import { clampPercent } from "@repo/api/src/utils/math";
import { Progress } from "@closedloop-ai/design-system/components/ui/progress";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";

/**
 * Dashboard loading treatment for the post-import analytics phase: the
 * insights-computing progress driven by `analyticsPct` (the share of dashboard
 * reads resolved, 0–100), over a skeleton so the transition to data is calm.
 *
 * First-launch import progress is owned solely by the top
 * `FirstLaunchImportBanner` (see first-launch-import-banner.tsx +
 * import-splash/import-splash-state.ts); the dashboard body no longer repeats
 * it. While the import is still in flight (`importActive`) the body is just the
 * skeleton below: the dashboard reads can resolve to 100% mid-import, so showing
 * the "Computing insights…" card then would park a full, never-resolving bar
 * beside the still-counting splash — the exact double-progress FEA-4139 removes.
 */
export function DashboardLoading({
  analyticsPct,
  importActive = false,
}: {
  analyticsPct: number;
  importActive?: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      {importActive ? null : (
        <InsightsProgressCard analyticsPct={analyticsPct} />
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        {["a", "b", "c", "d", "e"].map((key) => (
          <Skeleton className="h-[112px] rounded-xl" key={key} />
        ))}
      </div>
      <Skeleton className="h-[300px] rounded-xl" />
    </div>
  );
}

function InsightsProgressCard({ analyticsPct }: { analyticsPct: number }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-5">
      <div className="flex items-center gap-2">
        <span
          className="size-1.5 rounded-full bg-[var(--primary)]"
          style={{ animation: "ob-pulse 1.1s ease-in-out infinite" }}
        />
        <span
          className="font-medium text-[var(--foreground)] text-sm"
          role="status"
        >
          Computing insights…
        </span>
        {/* Ticking value is aria-hidden so the polite live region only
            announces the phase label, not every progress tick. */}
        <span
          aria-hidden="true"
          className="ml-auto font-mono text-[var(--muted-foreground)] text-xs tabular-nums"
        >
          {Math.round(clampPercent(analyticsPct))}%
        </span>
      </div>
      {/* Progress value ticks continuously outside the live status label,
          so only the "Computing insights…" label is announced. Shares the
          catalog Progress (slim h-1.5) with the import splash's per-harness
          bars so the two surfaces render one consistent bar. Clamp once so the
          Radix ARIA value can't overshoot (see use-ingest-progress.ts). */}
      <div className="mt-4">
        <Progress
          aria-label="Insights progress"
          className="h-1.5"
          value={clampPercent(analyticsPct)}
        />
      </div>
    </div>
  );
}
