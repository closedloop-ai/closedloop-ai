/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Brain, ChevronRight, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatScorePercent } from "@/lib/evaluation-utils";

type Pattern = {
  id: string;
  category: string;
  summary: string;
  confidence: string;
  seen_count: number;
  success_rate: number;
  flags: string[];
  applies_to: string[];
  context: string[];
};

const CATEGORIES = ["pattern", "mistake", "convention", "insight"] as const;

const categoryColor: Record<string, string> = {
  pattern: "bg-blue-500",
  mistake: "bg-red-500",
  convention: "bg-emerald-500",
  insight: "bg-amber-500",
};

const categoryStyles: Record<string, { bg: string; text: string }> = {
  pattern: { bg: "bg-blue-500/15", text: "text-blue-600 dark:text-blue-400" },
  mistake: { bg: "bg-red-500/15", text: "text-red-600 dark:text-red-400" },
  convention: {
    bg: "bg-emerald-500/15",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  insight: {
    bg: "bg-amber-500/15",
    text: "text-amber-600 dark:text-amber-400",
  },
};

const confidenceLabel: Record<string, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

function ExpandedDetail({ pattern }: Readonly<{ pattern: Pattern }>) {
  const style = categoryStyles[pattern.category] ?? categoryStyles.pattern;

  return (
    <div className="fade-in slide-in-from-top-1 animate-in space-y-3 border-border/30 border-t px-4 pt-1 pb-4 duration-150">
      {/* Full summary */}
      <p className="text-foreground/90 text-sm leading-relaxed">
        {pattern.summary}
      </p>

      {/* Metadata row */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="font-mono text-muted-foreground/60">{pattern.id}</span>
        <span className="text-border">·</span>
        <span
          className={`rounded-full px-1.5 py-0.5 font-medium ${style.bg} ${style.text}`}
        >
          {pattern.category}
        </span>
        <span className="text-border">·</span>
        <span>{confidenceLabel[pattern.confidence] ?? pattern.confidence}</span>
        <span className="text-border">·</span>
        <span>Seen {pattern.seen_count}x</span>
        <span className="text-border">·</span>
        <span>{formatScorePercent(pattern.success_rate)} success</span>
      </div>

      {/* Flags */}
      {pattern.flags.length > 0 && (
        <div className="flex gap-1.5">
          {pattern.flags.map((flag) => (
            <span
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              key={flag}
            >
              {flag}
            </span>
          ))}
        </div>
      )}

      {/* Tags */}
      {(pattern.applies_to.length > 0 || pattern.context.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {pattern.applies_to.map((tag) => (
            <span
              className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-[10px] text-primary/70"
              key={`a-${tag}`}
            >
              {tag}
            </span>
          ))}
          {pattern.context.map((tag) => (
            <span
              className="rounded-full bg-secondary px-2 py-0.5 font-medium text-[10px] text-secondary-foreground/70"
              key={`c-${tag}`}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CompactRow({
  pattern,
  isExpanded,
  onToggle,
}: Readonly<{
  pattern: Pattern;
  isExpanded: boolean;
  onToggle: () => void;
}>) {
  const dotColor = categoryColor[pattern.category] ?? categoryColor.pattern;

  return (
    <div
      className={`rounded-lg border transition-colors ${
        isExpanded
          ? "border-border bg-card/80"
          : "border-transparent hover:border-border/40 hover:bg-card/40"
      }`}
    >
      <button
        className="group flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left"
        onClick={onToggle}
        type="button"
      >
        {/* Category dot */}
        <span className={`size-2 shrink-0 rounded-full ${dotColor}`} />

        {/* Summary — truncated to one line */}
        <span className="flex-1 truncate text-foreground/85 text-sm">
          {pattern.summary}
        </span>

        {/* Right side: compact metadata */}
        <span className="flex shrink-0 items-center gap-2">
          {pattern.flags.length > 0 && (
            <span className="hidden rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground sm:inline">
              {pattern.flags[0]}
            </span>
          )}
          <span className="hidden text-[11px] text-muted-foreground/50 tabular-nums sm:inline">
            {pattern.seen_count}x
          </span>
          <ChevronRight
            className={`size-3.5 text-muted-foreground/40 transition-transform duration-150 group-hover:text-muted-foreground/70 ${
              isExpanded ? "rotate-90" : ""
            }`}
          />
        </span>
      </button>

      {isExpanded && <ExpandedDetail pattern={pattern} />}
    </div>
  );
}

const SKELETON_KEYS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"] as const;

function LoadingSkeleton() {
  return (
    <div className="mt-2 space-y-1">
      {SKELETON_KEYS.map((key) => (
        <div
          className="flex animate-pulse items-center gap-3 px-4 py-2.5"
          key={key}
        >
          <div className="size-2 rounded-full bg-muted" />
          <div className="h-4 flex-1 rounded bg-muted" />
          <div className="h-3 w-8 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

// Hex colors for SVG charts — must match Tailwind categoryColor classes
const CATEGORY_HEX: Record<string, string> = {
  pattern: "#3b82f6",
  mistake: "#ef4444",
  convention: "#10b981",
  insight: "#f59e0b",
};

function countByField(patterns: Pattern[], field: "applies_to" | "context") {
  const counts: Record<string, number> = {};
  for (const p of patterns) {
    for (const value of p[field]) {
      counts[value] = (counts[value] ?? 0) + 1;
    }
  }
  return counts;
}

function buildCategoryTestedMap(patterns: Pattern[]) {
  const catTested: Record<string, { tested: number; total: number }> = {};
  for (const p of patterns) {
    const entry = catTested[p.category] ?? { tested: 0, total: 0 };
    entry.total++;
    if (!p.flags.includes("UNTESTED")) {
      entry.tested++;
    }
    catTested[p.category] = entry;
  }
  return catTested;
}

function buildFrequencyBuckets(patterns: Pattern[]) {
  const buckets = [0, 0, 0, 0]; // 1x, 2x, 3x, 4+
  for (const p of patterns) {
    if (p.seen_count >= 4) {
      buckets[3]++;
    } else if (p.seen_count === 3) {
      buckets[2]++;
    } else if (p.seen_count === 2) {
      buckets[1]++;
    } else {
      buckets[0]++;
    }
  }
  return buckets;
}

function LearningsStats({ patterns }: Readonly<{ patterns: Pattern[] }>) {
  const stats = useMemo(() => {
    const total = patterns.length;
    const multiObserved = patterns.filter((p) => p.seen_count >= 2).length;
    const untested = patterns.filter((p) =>
      p.flags.includes("UNTESTED")
    ).length;
    const review = patterns.filter((p) => p.flags.includes("REVIEW")).length;
    const highConf = patterns.filter((p) => p.confidence === "high");
    const totalObservations = patterns.reduce((s, p) => s + p.seen_count, 0);

    const catCounts: Record<string, number> = {};
    for (const p of patterns) {
      catCounts[p.category] = (catCounts[p.category] ?? 0) + 1;
    }

    const catTested = buildCategoryTestedMap(patterns);
    const freqBuckets = buildFrequencyBuckets(patterns);

    const topAgents = Object.entries(countByField(patterns, "applies_to"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    const topTags = Object.entries(countByField(patterns, "context"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    const maxTagCount = topTags.length > 0 ? topTags[0][1] : 1;

    return {
      total,
      multiObserved,
      untested,
      review,
      highConf: highConf.length,
      highConfPct: total > 0 ? highConf.length / total : 0,
      totalObservations,
      catCounts,
      catTested,
      freqBuckets,
      topAgents,
      topTags,
      maxTagCount,
    };
  }, [patterns]);

  // Donut chart geometry
  const donutSegments = useMemo(() => {
    const total = patterns.length;
    if (total === 0) {
      return [];
    }
    const radius = 40;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    return CATEGORIES.map((cat) => {
      const count = stats.catCounts[cat] ?? 0;
      const fraction = count / total;
      const dashLength = fraction * circumference;
      const segment = {
        category: cat,
        count,
        dashArray: `${dashLength} ${circumference - dashLength}`,
        dashOffset: -offset,
        color: CATEGORY_HEX[cat] ?? "#888",
      };
      offset += dashLength;
      return segment;
    });
  }, [patterns.length, stats.catCounts]);

  const maxFreq = Math.max(...stats.freqBuckets, 1);

  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="space-y-5 py-2">
      {/* Row 1 — KPI cards */}
      <div className="grid grid-cols-4 gap-3">
        <div
          className="cursor-default rounded-lg border border-border/50 bg-card/60 p-3 text-center"
          title="Patterns observed 2 or more times across runs, indicating reinforced learnings"
        >
          <div className="font-semibold text-foreground text-xl tabular-nums">
            {stats.multiObserved}
            <span className="ml-1 font-normal text-muted-foreground text-xs">
              / {stats.total}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            Multi-observed
          </div>
        </div>
        <div
          className="cursor-default rounded-lg border border-border/50 bg-card/60 p-3 text-center"
          title="Patterns marked as high confidence by the learning system"
        >
          <div className="font-semibold text-foreground text-xl tabular-nums">
            {stats.highConf}
            <span className="ml-1 font-normal text-muted-foreground text-xs">
              ({formatScorePercent(stats.highConfPct)})
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            High confidence
          </div>
        </div>
        <div
          className="cursor-default rounded-lg border border-border/50 bg-card/60 p-3 text-center"
          title="Untested: not yet field-validated. Review: flagged for manual review before promotion."
        >
          <div className="font-semibold text-foreground text-xl tabular-nums">
            {stats.untested}
            <span className="ml-1 font-normal text-muted-foreground text-xs">
              / {stats.review}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            Untested / Review
          </div>
        </div>
        <div
          className="cursor-default rounded-lg border border-border/50 bg-card/60 p-3 text-center"
          title="Sum of all seen_count values — total times any pattern was observed"
        >
          <div className="font-semibold text-foreground text-xl tabular-nums">
            {stats.totalObservations}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            Total observations
          </div>
        </div>
      </div>

      {/* Row 2 — Donut + Tested bar chart */}
      <div className="grid grid-cols-2 gap-3">
        {/* Donut chart */}
        <div className="rounded-lg border border-border/50 bg-card/60 p-4">
          <div
            className="mb-3 cursor-default font-medium text-[11px] text-muted-foreground"
            title="Breakdown of patterns by type: pattern, mistake, convention, or insight"
          >
            Category Distribution
          </div>
          <div className="flex items-center justify-center">
            <svg aria-hidden="true" className="size-28" viewBox="0 0 100 100">
              {donutSegments.map((seg) => (
                <circle
                  className="transition-all duration-300"
                  cx="50"
                  cy="50"
                  fill="none"
                  key={seg.category}
                  r="40"
                  stroke={seg.color}
                  strokeDasharray={seg.dashArray}
                  strokeDashoffset={seg.dashOffset}
                  strokeWidth="14"
                  transform="rotate(-90 50 50)"
                />
              ))}
            </svg>
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1">
            {donutSegments
              .filter((s) => s.count > 0)
              .map((seg) => (
                <div
                  className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
                  key={seg.category}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: seg.color }}
                  />
                  <span className="capitalize">{seg.category}</span>
                  <span className="opacity-60">{seg.count}</span>
                </div>
              ))}
          </div>
        </div>

        {/* Field-tested rate per category */}
        <div className="rounded-lg border border-border/50 bg-card/60 p-4">
          <div
            className="mb-3 cursor-default font-medium text-[11px] text-muted-foreground"
            title="Percentage of patterns that have been field-tested (not flagged UNTESTED) within each category"
          >
            Field-tested Rate by Category
          </div>
          <div className="space-y-2.5">
            {CATEGORIES.map((cat) => {
              const entry = stats.catTested[cat];
              if (!entry || entry.total === 0) {
                return null;
              }
              const pct = (entry.tested / entry.total) * 100;
              return (
                <div key={cat}>
                  <div className="mb-1 flex items-center justify-between text-[10px]">
                    <span className="text-muted-foreground capitalize">
                      {cat}
                    </span>
                    <span className="text-muted-foreground/70 tabular-nums">
                      {entry.tested}/{entry.total} ({pct.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary/50">
                    <div
                      className="h-full rounded-full transition-all duration-700 ease-out"
                      style={{
                        width: animated ? `${pct}%` : "0%",
                        backgroundColor: CATEGORY_HEX[cat],
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Row 3 — Observation frequency histogram */}
      <div className="rounded-lg border border-border/50 bg-card/60 p-4">
        <div
          className="mb-3 cursor-default font-medium text-[11px] text-muted-foreground"
          title="How many patterns fall into each observation bucket (seen 1x, 2x, 3x, or 4+ times)"
        >
          Observation Frequency
        </div>
        <div className="flex h-24 items-end gap-3">
          {["1x", "2x", "3x", "4+"].map((label, i) => {
            const count = stats.freqBuckets[i];
            const height = (count / maxFreq) * 100;
            return (
              <div
                className="flex flex-1 flex-col items-center gap-1"
                key={label}
              >
                <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                  {count}
                </span>
                <div
                  className="flex w-full items-end"
                  style={{ height: "64px" }}
                >
                  <div
                    className="w-full rounded-t bg-primary/60 transition-all duration-700 ease-out"
                    style={{
                      height: animated ? `${Math.max(height, 4)}%` : "0%",
                    }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Row 4 — Agent coverage grid */}
      {stats.topAgents.length > 0 && (
        <div className="rounded-lg border border-border/50 bg-card/60 p-4">
          <div
            className="mb-3 cursor-default font-medium text-[11px] text-muted-foreground"
            title="Agents with the most pattern assignments — brighter cells indicate more patterns"
          >
            Agent Coverage
          </div>
          <div className="flex flex-wrap gap-1.5">
            {stats.topAgents.map(([agent, count]) => {
              const maxCount = stats.topAgents[0][1];
              const intensity = 0.3 + 0.7 * (count / maxCount);
              return (
                <span
                  className="rounded-md border border-border/30 px-2 py-1 font-mono text-[10px] text-foreground/80"
                  key={agent}
                  style={{
                    backgroundColor: `rgba(59, 130, 246, ${intensity * 0.15})`,
                  }}
                >
                  {agent} <span className="opacity-60">{count}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Row 5 — Top tech tags */}
      {stats.topTags.length > 0 && (
        <div className="rounded-lg border border-border/50 bg-card/60 p-4">
          <div
            className="mb-3 cursor-default font-medium text-[11px] text-muted-foreground"
            title="Most frequent context tags across all patterns — stronger opacity means higher frequency"
          >
            Top Tech Tags
          </div>
          <div className="flex flex-wrap gap-1.5">
            {stats.topTags.map(([tag, count]) => {
              const intensity = 0.4 + 0.6 * (count / stats.maxTagCount);
              return (
                <span
                  className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-[10px] text-primary"
                  key={tag}
                  style={{ opacity: intensity }}
                >
                  {tag}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

type LearningsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isProcessingLearnings?: boolean;
  onProcessPending?: () => void;
  onBatchProcessingComplete?: () => void;
};

export function LearningsDialog({
  open,
  onOpenChange,
  isProcessingLearnings,
  onProcessPending,
  onBatchProcessingComplete,
}: Readonly<LearningsDialogProps>) {
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"learnings" | "stats">(
    "learnings"
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [isProcessingLocal, setIsProcessingLocal] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    processedWorktrees: number;
    worktreeCount: number;
    totalPending: number;
  } | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshPatterns = useCallback(() => {
    fetch("/api/gateway/learnings")
      .then((res) => res.json())
      .then((data) => {
        if (!data.error) {
          setPatterns(data.patterns ?? []);
        }
      })
      .catch(() => {
        // Ignore refresh errors
      });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    setLoading(true);
    setError(null);

    const fetchAll = async () => {
      try {
        const [learningsRes, pendingRes] = await Promise.all([
          fetch("/api/gateway/learnings"),
          fetch("/api/gateway/symphony/pending-learnings"),
        ]);
        const learningsData = await learningsRes.json();
        const pendingData = await pendingRes.json();

        if (learningsData.error) {
          setError(learningsData.error);
        } else {
          setPatterns(learningsData.patterns ?? []);
        }
        setPendingCount(pendingData.totalCount ?? 0);

        // Check if batch processing is already in progress
        const batchRes = await fetch(
          "/api/gateway/symphony/process-all-learnings"
        );
        const batchData = await batchRes.json();
        if (batchData.status === "processing") {
          setIsProcessingLocal(true);
          setBatchProgress({
            processedWorktrees: batchData.processedWorktrees ?? 0,
            worktreeCount: batchData.worktreeCount ?? 0,
            totalPending: batchData.totalPending ?? 0,
          });
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load learnings"
        );
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
  }, [open]);

  // Poll batch processing status while isProcessingLocal
  useEffect(() => {
    if (!isProcessingLocal) {
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch("/api/gateway/symphony/process-all-learnings");
        const data = await res.json();
        if (data.status === "completed" || data.status === "error") {
          setIsProcessingLocal(false);
          setBatchProgress(null);
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          refreshPatterns();
          onBatchProcessingComplete?.();
        } else if (data.status === "processing") {
          setBatchProgress({
            processedWorktrees: data.processedWorktrees ?? 0,
            worktreeCount: data.worktreeCount ?? 0,
            totalPending: data.totalPending ?? 0,
          });
        }
      } catch {
        // Ignore polling errors
      }
    };

    pollingRef.current = setInterval(poll, 3000);

    // 5-minute safety timeout
    const timeout = setTimeout(() => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      setIsProcessingLocal(false);
      onBatchProcessingComplete?.();
    }, 300_000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      clearTimeout(timeout);
    };
  }, [isProcessingLocal, refreshPatterns, onBatchProcessingComplete]);

  // Reset filters when dialog closes
  useEffect(() => {
    if (!open) {
      setSearch("");
      setActiveCategory(null);
      setExpandedId(null);
      setActiveTab("learnings");
      setBatchProgress(null);
    }
  }, [open]);

  // Category counts from full dataset
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of patterns) {
      counts[p.category] = (counts[p.category] ?? 0) + 1;
    }
    return counts;
  }, [patterns]);

  // Filtered patterns
  const filtered = useMemo(() => {
    let result = patterns;

    if (activeCategory) {
      result = result.filter((p) => p.category === activeCategory);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.summary.toLowerCase().includes(q) ||
          p.applies_to.some((t) => t.toLowerCase().includes(q)) ||
          p.context.some((t) => t.toLowerCase().includes(q)) ||
          p.id.toLowerCase().includes(q)
      );
    }

    return result;
  }, [patterns, activeCategory, search]);

  const hasPatterns = patterns.length > 0;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-0 sm:max-w-2xl">
        <DialogHeader className="pb-4">
          <DialogTitle className="font-semibold text-lg tracking-tight">
            Organization Learnings
          </DialogTitle>
          <DialogDescription>
            {hasPatterns && !loading
              ? `${patterns.length} patterns and insights captured across Closedloop.dev runs`
              : "Patterns and insights captured across Closedloop.dev runs"}
          </DialogDescription>
        </DialogHeader>

        {/* Pending learnings banner */}
        {pendingCount > 0 &&
          !isProcessingLearnings &&
          !isProcessingLocal &&
          !loading && (
            <div className="mb-3 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
              <Brain className="size-4 shrink-0 text-amber-500" />
              <span className="flex-1 text-amber-700 text-sm dark:text-amber-400">
                {pendingCount} pending learning{pendingCount === 1 ? "" : "s"}{" "}
                to process
              </span>
              <button
                className="cursor-pointer rounded-md bg-amber-500/20 px-3 py-1 font-medium text-amber-700 text-xs transition-colors hover:bg-amber-500/30 dark:text-amber-400"
                onClick={() => {
                  setIsProcessingLocal(true);
                  setPendingCount(0);
                  onProcessPending?.();
                }}
                type="button"
              >
                Process now
              </button>
            </div>
          )}

        {/* Processing indicator */}
        {(isProcessingLearnings || isProcessingLocal) && (
          <div className="mb-3 space-y-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5">
            <div className="flex items-center gap-3">
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
              <span className="flex-1 text-primary text-sm">
                {batchProgress
                  ? `Processing learnings... ${batchProgress.processedWorktrees}/${batchProgress.worktreeCount} worktrees`
                  : "Processing learnings..."}
              </span>
              {batchProgress && batchProgress.worktreeCount > 0 && (
                <span className="text-primary/60 text-xs tabular-nums">
                  {batchProgress.totalPending} files
                </span>
              )}
            </div>
            {batchProgress && batchProgress.worktreeCount > 0 && (
              <div className="h-1.5 overflow-hidden rounded-full bg-primary/20">
                <div
                  className="h-full rounded-full bg-primary/60 transition-all duration-500 ease-out"
                  style={{
                    width: `${(batchProgress.processedWorktrees / batchProgress.worktreeCount) * 100}%`,
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* Tab bar */}
        {hasPatterns && !loading && (
          <div className="flex items-center gap-1.5 pb-3">
            {(["learnings", "stats"] as const).map((tab) => (
              <button
                className={`cursor-pointer rounded-full px-3 py-1.5 font-medium text-[12px] capitalize transition-all ${
                  activeTab === tab
                    ? "bg-primary/10 text-primary"
                    : "bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground/80"
                }`}
                key={tab}
                onClick={() => setActiveTab(tab)}
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>
        )}

        {activeTab === "learnings" ? (
          <>
            {/* Search + category filters */}
            {hasPatterns && !loading && (
              <div className="space-y-3 border-border/50 border-b pb-3">
                {/* Search */}
                <div className="relative">
                  <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
                  <input
                    className="h-9 w-full rounded-md border border-border/50 bg-secondary/30 pr-3 pl-9 text-foreground text-sm transition-colors placeholder:text-muted-foreground/50 focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/30"
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setExpandedId(null);
                    }}
                    placeholder="Search learnings..."
                    type="text"
                    value={search}
                  />
                </div>

                {/* Category filter chips */}
                <div className="flex items-center gap-1.5">
                  {CATEGORIES.map((cat) => {
                    const count = categoryCounts[cat] ?? 0;
                    if (count === 0) {
                      return null;
                    }
                    const isActive = activeCategory === cat;
                    const style = categoryStyles[cat];

                    return (
                      <button
                        className={`cursor-pointer rounded-full px-2.5 py-1 font-medium text-[11px] transition-all ${
                          isActive
                            ? `${style.bg} ${style.text} ring-1 ring-current/20`
                            : "bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground/80"
                        }`}
                        key={cat}
                        onClick={() => {
                          setActiveCategory(isActive ? null : cat);
                          setExpandedId(null);
                        }}
                        type="button"
                      >
                        {cat}
                        <span className="ml-1.5 opacity-60">{count}</span>
                      </button>
                    );
                  })}
                  {activeCategory && (
                    <button
                      className="ml-1 cursor-pointer text-[11px] text-muted-foreground/60 hover:text-muted-foreground"
                      onClick={() => {
                        setActiveCategory(null);
                        setExpandedId(null);
                      }}
                      type="button"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Scrollable list */}
            <div className="-mx-6 max-h-[60vh] overflow-y-auto px-6 py-1">
              {loading && <LoadingSkeleton />}

              {error && (
                <div className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
                  {error}
                </div>
              )}

              {!(loading || error) && patterns.length === 0 && (
                <div className="py-12 text-center text-muted-foreground text-sm">
                  <p className="mb-1">No learnings found</p>
                  <p className="text-muted-foreground/60 text-xs">
                    Patterns will appear here after ClosedLoop runs capture them
                  </p>
                </div>
              )}

              {!(loading || error) && hasPatterns && filtered.length === 0 && (
                <div className="py-8 text-center text-muted-foreground text-sm">
                  No learnings match your filters
                </div>
              )}

              {!(loading || error) && filtered.length > 0 && (
                <div className="space-y-0.5 py-1">
                  {filtered.map((p) => (
                    <CompactRow
                      isExpanded={expandedId === p.id}
                      key={p.id}
                      onToggle={() =>
                        setExpandedId(expandedId === p.id ? null : p.id)
                      }
                      pattern={p}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Footer count when filtering */}
            {!loading && hasPatterns && (activeCategory || search) && (
              <div className="border-border/50 border-t pt-3 text-center text-[11px] text-muted-foreground/50">
                Showing {filtered.length} of {patterns.length}
              </div>
            )}
          </>
        ) : (
          <div className="-mx-6 max-h-[60vh] overflow-y-auto px-6 py-1">
            <LearningsStats patterns={patterns} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
