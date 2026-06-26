import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { useEffect, useState } from "react";

type HarnessIngest = { harness: string; total: number; processed: number };
type IngestProgress = {
  byHarness: HarnessIngest[];
  total: number;
  processed: number;
};

const INGEST_POLL_MS = 1000;

const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  copilot: "Copilot",
  cursor: "Cursor",
  gemini: "Gemini CLI",
};

function harnessLabel(key: string): string {
  return HARNESS_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function parseIngest(status: unknown): IngestProgress | null {
  if (typeof status !== "object" || status === null) {
    return null;
  }
  const ingest = (status as { ingest?: unknown }).ingest;
  if (typeof ingest !== "object" || ingest === null) {
    return null;
  }
  const raw = ingest as { byHarness?: unknown; total?: unknown };
  if (!(Array.isArray(raw.byHarness) && typeof raw.total === "number")) {
    return null;
  }
  const byHarness = raw.byHarness.filter(
    (h): h is HarnessIngest =>
      typeof h === "object" &&
      h !== null &&
      typeof (h as HarnessIngest).harness === "string" &&
      typeof (h as HarnessIngest).total === "number" &&
      typeof (h as HarnessIngest).processed === "number"
  );
  const processed = byHarness.reduce((sum, h) => sum + h.processed, 0);
  return { byHarness, total: raw.total, processed };
}

/** Polls the main-process ingest progress while the local import is running. */
function useIngestProgress(active: boolean): IngestProgress | null {
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    const poll = () => {
      window.desktopApi
        .getRuntimeStatus()
        .then((status) => {
          if (!cancelled) {
            setProgress(parseIngest(status));
          }
        })
        .catch(() => undefined);
    };
    poll();
    const id = window.setInterval(poll, INGEST_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active]);
  return progress;
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--accent)]">
      <div
        className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-300 ease-out"
        style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

function HarnessRow({ harness }: { harness: HarnessIngest }) {
  const pct = harness.total > 0 ? (harness.processed / harness.total) * 100 : 0;
  return (
    <div className="grid grid-cols-[8rem_1fr_auto] items-center gap-3">
      <span className="truncate font-medium text-[var(--foreground)] text-xs">
        {harnessLabel(harness.harness)}
      </span>
      <ProgressBar pct={pct} />
      <span className="text-right font-mono text-[10px] text-[var(--muted-foreground)] tabular-nums">
        {harness.processed.toLocaleString()} / {harness.total.toLocaleString()}
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
  const ingesting = Boolean(
    ingest && ingest.total > 0 && ingest.processed < ingest.total
  );

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
              <span className="font-medium text-[var(--foreground)] text-sm">
                Analyzing your sessions…
              </span>
              <span className="ml-auto font-mono text-[var(--muted-foreground)] text-xs tabular-nums">
                {ingest.processed.toLocaleString()} /{" "}
                {ingest.total.toLocaleString()}
              </span>
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
              <span className="font-medium text-[var(--foreground)] text-sm">
                Computing insights…
              </span>
            </div>
            <div className="mt-4">
              <ProgressBar pct={analyticsPct} />
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {["a", "b", "c", "d", "e"].map((key) => (
          <Skeleton className="h-[112px] rounded-xl" key={key} />
        ))}
      </div>
      <Skeleton className="h-[300px] rounded-xl" />
    </div>
  );
}
