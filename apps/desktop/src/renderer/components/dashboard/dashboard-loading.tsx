import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import {
  type HarnessIngest,
  useIngestProgress,
} from "../../hooks/use-ingest-progress";
import {
  clampPercent,
  describeImportProgress,
} from "../import-progress-display";

const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  copilot: "Copilot",
  cursor: "Cursor",
  gemini: "Gemini CLI",
};

function ProgressBar({ label, pct }: { label: string; pct: number }) {
  // Clamp once so the ARIA value and the visual width stay in sync even if
  // `pct` transiently overshoots (see use-ingest-progress.ts).
  const clamped = clampPercent(pct);
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={clamped}
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--accent)]"
      role="progressbar"
    >
      <div
        className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-300 ease-out"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function HarnessRow({ harness }: { harness: HarnessIngest }) {
  const label = harnessLabel(harness.harness);
  const progress = describeImportProgress(harness.processed, harness.total);
  return (
    <div className="grid grid-cols-[8rem_1fr_auto] items-center gap-3">
      <span className="truncate font-medium text-[var(--foreground)] text-xs">
        {label}
      </span>
      <ProgressBar label={`${label} import progress`} pct={progress.pct} />
      <span className="text-right font-mono text-[10px] text-[var(--muted-foreground)] tabular-nums">
        {progress.processed.toLocaleString()} /{" "}
        {progress.total.toLocaleString()}
      </span>
    </div>
  );
}

/**
 * Dashboard loading treatment with real progress for both phases: per-harness
 * local-session ingest ("Claude Code 612 / 1,357") while importing, then the
 * insights-computing progress. Falls back to a skeleton beneath it so the
 * transition to data is calm. `analyticsPct` is the share of dashboard reads
 * resolved (0–100).
 */
export function DashboardLoading({ analyticsPct }: { analyticsPct: number }) {
  const ingest = useIngestProgress(true);
  const importProgress = describeImportProgress(
    ingest?.processed ?? 0,
    ingest?.total ?? 0
  );
  const ingesting = Boolean(
    ingest &&
      importProgress.total > 0 &&
      importProgress.processed < importProgress.total
  );
  // FEA-2936: an aggregate percentage across every harness, so the import phase
  // shows one bounded, determinate figure ("42%") instead of only per-harness
  // bars — the skeleton wait otherwise reads as open-ended. Floored, not rounded:
  // while `ingesting` (processed < total) the figure must never read "100%".
  const ingestPct = Math.floor(importProgress.pct);

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-border/70 bg-card p-5">
        {ingesting && ingest ? (
          <>
            <div className="flex items-center gap-2">
              <span
                className="size-1.5 rounded-full bg-[var(--primary)]"
                style={{ animation: "ob-pulse 1.1s ease-in-out infinite" }}
              />
              <span
                className="font-medium text-[var(--foreground)] text-sm"
                role="status"
              >
                Analyzing your sessions…
              </span>
              {/* Ticking counts are aria-hidden so the polite live region only
                  announces the phase label, not every ~1s progress tick. */}
              <span
                aria-hidden="true"
                className="ml-auto font-mono text-[var(--muted-foreground)] text-xs tabular-nums"
              >
                {ingestPct}% · {importProgress.processed.toLocaleString()} /{" "}
                {importProgress.total.toLocaleString()}
              </span>
            </div>
            {/* Overall determinate progress across all harnesses, so the whole
                import reads as bounded before the per-harness breakdown. */}
            <div className="mt-4">
              <ProgressBar
                label="Overall import progress"
                pct={importProgress.pct}
              />
            </div>
            <div className="mt-4 space-y-2.5">
              {ingest.byHarness.map((harness) => (
                <HarnessRow harness={harness} key={harness.harness} />
              ))}
            </div>
          </>
        ) : (
          <>
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
                so only the "Computing insights…" label is announced. */}
            <div className="mt-4">
              <ProgressBar label="Insights progress" pct={analyticsPct} />
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        {["a", "b", "c", "d", "e"].map((key) => (
          <Skeleton className="h-[112px] rounded-xl" key={key} />
        ))}
      </div>
      <Skeleton className="h-[300px] rounded-xl" />
    </div>
  );
}

function harnessLabel(key: string): string {
  return HARNESS_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
