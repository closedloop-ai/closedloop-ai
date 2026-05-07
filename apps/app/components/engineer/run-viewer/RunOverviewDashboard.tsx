"use client";

import {
  Activity,
  ClipboardCheck,
  FileText,
  FolderOpen,
  Scale,
} from "lucide-react";
import { useMemo } from "react";
import {
  type CaseScore,
  EvalStatus,
  type EvaluationReport,
} from "@/lib/engineer/queries/closedloop";
import { decodeText, getFileType } from "@/lib/engineer/run-viewer-utils";
import type { RunData } from "@/types/run-viewer";

type RunOverviewDashboardProps = {
  runData: RunData;
  onSelectFile: (path: string) => void;
};

type StateInfo = {
  phase?: string;
  status?: string;
  timestamp?: string;
};

type EvalInfo = {
  simple_mode?: boolean;
  signalCount: number;
  passedCount: number;
};

function tryParseJson<T>(data: Uint8Array | undefined): T | null {
  if (!data) {
    return null;
  }
  try {
    return JSON.parse(decodeText(data)) as T;
  } catch {
    return null;
  }
}

function inferStatusFromScore(caseScore: CaseScore): EvalStatus {
  const allPassed = caseScore.metrics.every(
    (m) => m.score !== null && m.score >= m.threshold
  );
  if (allPassed) {
    return EvalStatus.Passed;
  }
  return EvalStatus.Failed;
}

export function RunOverviewDashboard({
  runData,
  onSelectFile,
}: Readonly<RunOverviewDashboardProps>) {
  const { stateInfo, planPreview, judgesInfo, evalInfo, fileStats } =
    useMemo(() => {
      // State
      const stateData = findFile(runData, "state.json");
      const state = tryParseJson<StateInfo>(stateData);

      // Plan preview
      let preview: string | null = null;
      const planMd = findFile(runData, "plan.md");
      if (planMd) {
        const text = decodeText(planMd);
        preview = text.slice(0, 200) + (text.length > 200 ? "..." : "");
      }

      // Judges
      const judgesData = findFile(runData, "judges.json");
      const judges = tryParseJson<EvaluationReport>(judgesData);
      let jInfo: {
        totalCount: number;
        passedCount: number;
        percentage: number;
      } | null = null;
      if (judges?.stats) {
        const total = judges.stats.length;
        const passed = judges.stats.filter(
          (s) =>
            s.type === "case_score" &&
            inferStatusFromScore(s) === EvalStatus.Passed
        ).length;
        jInfo = {
          totalCount: total,
          passedCount: passed,
          percentage: total > 0 ? (passed / total) * 100 : 0,
        };
      }

      // Evaluation
      const evalData = findFile(runData, "plan-evaluation.json");
      const evalParsed = tryParseJson<{
        simple_mode?: boolean;
        signals?: unknown[];
      }>(evalData);
      let eInfo: EvalInfo | null = null;
      if (evalParsed) {
        const signals = Array.isArray(evalParsed.signals)
          ? evalParsed.signals
          : [];
        eInfo = {
          simple_mode: evalParsed.simple_mode,
          signalCount: signals.length,
          passedCount: signals.filter((s: unknown) => {
            const sig = s as { passed?: boolean };
            return sig.passed;
          }).length,
        };
      }

      // File stats
      const typeCounts = new Map<string, number>();
      let totalSize = 0;
      for (const [path, data] of runData.files) {
        const type = getFileType(path);
        typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
        totalSize += data.byteLength;
      }

      return {
        stateInfo: state,
        planPreview: preview,
        judgesInfo: jInfo,
        evalInfo: eInfo,
        fileStats: { typeCounts, totalSize, totalFiles: runData.files.size },
      };
    }, [runData]);

  return (
    <div className="h-full space-y-4 overflow-auto p-6">
      <h2 className="font-semibold text-lg">Run Overview</h2>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* State Card */}
        {stateInfo && (
          <DashboardCard
            icon={<Activity className="size-4" />}
            onClick={() => navigateToFile(runData, "state.json", onSelectFile)}
            title="State"
          >
            <div className="flex items-center gap-3">
              {stateInfo.phase && (
                <span className="font-medium text-sm">{stateInfo.phase}</span>
              )}
              {stateInfo.status && (
                <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-xs">
                  {stateInfo.status}
                </span>
              )}
            </div>
            {stateInfo.timestamp && (
              <p className="mt-1 font-mono text-muted-foreground text-xs">
                {stateInfo.timestamp}
              </p>
            )}
          </DashboardCard>
        )}

        {/* Plan Summary Card */}
        {planPreview && (
          <DashboardCard
            icon={<FileText className="size-4" />}
            onClick={() => navigateToFile(runData, "plan.md", onSelectFile)}
            title="Plan"
          >
            <p className="line-clamp-3 text-muted-foreground text-xs">
              {planPreview}
            </p>
            <p className="mt-1 text-primary text-xs">View full plan...</p>
          </DashboardCard>
        )}

        {/* Judges Card */}
        {judgesInfo && (
          <DashboardCard
            icon={<Scale className="size-4" />}
            onClick={() => navigateToFile(runData, "judges.json", onSelectFile)}
            title="Judge Scores"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">
                {judgesInfo.passedCount}/{judgesInfo.totalCount} passed
              </span>
              <span className="text-muted-foreground text-xs">
                ({judgesInfo.percentage.toFixed(0)}%)
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full ${percentageColor(judgesInfo.percentage)}`}
                style={{ width: `${judgesInfo.percentage}%` }}
              />
            </div>
          </DashboardCard>
        )}

        {/* Evaluation Card */}
        {evalInfo && (
          <DashboardCard
            icon={<ClipboardCheck className="size-4" />}
            onClick={() =>
              navigateToFile(runData, "plan-evaluation.json", onSelectFile)
            }
            title="Evaluation"
          >
            <div className="flex items-center gap-2">
              {evalInfo.simple_mode !== undefined && (
                <span
                  className={`rounded-full px-2 py-0.5 font-medium text-xs ${
                    evalInfo.simple_mode
                      ? "bg-emerald-500/15 text-emerald-500"
                      : "bg-amber-500/15 text-amber-500"
                  }`}
                >
                  {evalInfo.simple_mode ? "Simple" : "Full"}
                </span>
              )}
              {evalInfo.signalCount > 0 && (
                <span className="text-muted-foreground text-xs">
                  {evalInfo.passedCount}/{evalInfo.signalCount} signals passed
                </span>
              )}
            </div>
          </DashboardCard>
        )}

        {/* Files Card */}
        <DashboardCard icon={<FolderOpen className="size-4" />} title="Files">
          <div className="flex items-center gap-4">
            <span className="font-medium text-sm">
              {fileStats.totalFiles} files
            </span>
            <span className="text-muted-foreground text-xs">
              {formatSize(fileStats.totalSize)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {Array.from(fileStats.typeCounts.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([type, count]) => (
                <span
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                  key={type}
                >
                  {type}: {count}
                </span>
              ))}
          </div>
        </DashboardCard>
      </div>
    </div>
  );
}

function DashboardCard({
  icon,
  title,
  children,
  onClick,
}: Readonly<{
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  onClick?: () => void;
}>) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      className={`space-y-2 rounded-lg border p-4 text-left ${
        onClick ? "cursor-pointer transition-colors hover:bg-muted/50" : ""
      }`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="font-medium text-xs uppercase tracking-wider">
          {title}
        </span>
      </div>
      {children}
    </Wrapper>
  );
}

function findFile(runData: RunData, filename: string): Uint8Array | undefined {
  // Look for exact match first, then search in nested paths
  const direct = runData.files.get(filename);
  if (direct) {
    return direct;
  }

  for (const [path, data] of runData.files) {
    if (path.endsWith(`/${filename}`) || path === filename) {
      return data;
    }
  }
  return undefined;
}

function navigateToFile(
  runData: RunData,
  filename: string,
  onSelectFile: (path: string) => void
) {
  for (const path of runData.files.keys()) {
    if (path === filename || path.endsWith(`/${filename}`)) {
      onSelectFile(path);
      return;
    }
  }
}

function percentageColor(pct: number): string {
  if (pct >= 80) {
    return "bg-green-500";
  }
  if (pct >= 50) {
    return "bg-amber-500";
  }
  return "bg-red-500";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
