"use client";

import type {
  DailyTokenUsage,
  ModelUsage,
  ProjectUsage,
  RecentSession,
} from "@repo/api/src/types/dashboard";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type PublicDashboardFilters,
  usePublicDashboard,
} from "@/hooks/queries/use-public-dashboard";

// ── Constants ───────────────────────────────────────────────────────────────

type DateRange = 7 | 30 | 90 | 0;
const DATE_RANGES: { label: string; value: DateRange }[] = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "All", value: 0 },
];

const MODEL_COLORS: Record<string, string> = {
  "claude-opus-4-6": "#f97316",
  "claude-opus-4": "#f97316",
  "claude-sonnet-4-6": "#3b82f6",
  "claude-sonnet-4-5": "#3b82f6",
  "claude-sonnet-4": "#3b82f6",
  "claude-haiku-4-5-20251001": "#22c55e",
  "claude-haiku-4-5": "#22c55e",
};
const DEFAULT_MODEL_COLOR = "#8b5cf6";

const BAR_COLORS = {
  input: "#60a5fa",
  output: "#a78bfa",
  cacheRead: "#34d399",
  cacheCreation: "#f59e0b",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(2)}B`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toString();
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtAxis(n: number): string {
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(1)}B`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(0)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(0)}K`;
  }
  return n.toString();
}

function modelColor(model: string): string {
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (model.includes(key) || key.includes(model)) {
      return color;
    }
  }
  return DEFAULT_MODEL_COLOR;
}

function truncateProject(name: string, maxLen = 25): string {
  if (name.length <= maxLen) {
    return name;
  }
  return `...${name.slice(-(maxLen - 3))}`;
}

// ── Components ──────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-800/60 px-5 py-4">
      <div className="mb-1 font-medium text-slate-400 text-xs uppercase tracking-wider">
        {label}
      </div>
      <div className="font-bold text-2xl text-white">{value}</div>
      {sub && <div className="mt-0.5 text-slate-500 text-xs">{sub}</div>}
    </div>
  );
}

function ModelFilterPills({
  allModels,
  selected,
  onToggle,
  onAll,
  onNone,
}: {
  allModels: string[];
  selected: Set<string>;
  onToggle: (m: string) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-slate-400 text-xs uppercase tracking-wider">
        Models
      </span>
      {allModels.map((m) => (
        <button
          className={`rounded-full border px-3 py-1 font-medium text-xs transition-colors ${
            selected.has(m)
              ? "border-slate-500 bg-slate-700 text-white"
              : "border-slate-700 bg-slate-800/40 text-slate-500"
          }`}
          key={m}
          onClick={() => onToggle(m)}
          type="button"
        >
          {m}
        </button>
      ))}
      <button
        className="rounded px-2 py-1 text-slate-400 text-xs transition-colors hover:text-white"
        onClick={onAll}
        type="button"
      >
        All
      </button>
      <button
        className="rounded px-2 py-1 text-slate-400 text-xs transition-colors hover:text-white"
        onClick={onNone}
        type="button"
      >
        None
      </button>
    </div>
  );
}

function RangeSelector({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (v: DateRange) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="mr-2 font-medium text-slate-400 text-xs uppercase tracking-wider">
        Range
      </span>
      {DATE_RANGES.map((r) => (
        <button
          className={`rounded px-3 py-1 font-medium text-xs transition-colors ${
            value === r.value
              ? "bg-blue-600 text-white"
              : "text-slate-400 hover:text-white"
          }`}
          key={r.value}
          onClick={() => onChange(r.value)}
          type="button"
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function DailyUsageChart({ data }: { data: DailyTokenUsage[] }) {
  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-800/60 p-5">
      <h3 className="mb-4 font-semibold text-slate-300 text-sm uppercase tracking-wider">
        Daily Token Usage &mdash; Last {data.length} Days
      </h3>
      <ResponsiveContainer height={350} width="100%">
        <BarChart data={data}>
          <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
          <XAxis
            axisLine={{ stroke: "#475569" }}
            dataKey="date"
            tick={{ fill: "#94a3b8", fontSize: 11 }}
            tickLine={false}
          />
          <YAxis
            axisLine={{ stroke: "#475569" }}
            tick={{ fill: "#94a3b8", fontSize: 11 }}
            tickFormatter={fmtAxis}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1e293b",
              border: "1px solid #475569",
              borderRadius: 8,
              color: "#e2e8f0",
              fontSize: 12,
            }}
            formatter={((v: number, n: string) => [fmt(v), n]) as never}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "#94a3b8" }} />
          <Bar
            dataKey="input"
            fill={BAR_COLORS.input}
            name="Input"
            stackId="a"
          />
          <Bar
            dataKey="output"
            fill={BAR_COLORS.output}
            name="Output"
            stackId="a"
          />
          <Bar
            dataKey="cacheRead"
            fill={BAR_COLORS.cacheRead}
            name="Cache Read"
            stackId="a"
          />
          <Bar
            dataKey="cacheCreation"
            fill={BAR_COLORS.cacheCreation}
            name="Cache Creation"
            stackId="a"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ModelDonutChart({ data }: { data: ModelUsage[] }) {
  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-800/60 p-5">
      <h3 className="mb-4 font-semibold text-slate-300 text-sm uppercase tracking-wider">
        By Model
      </h3>
      <ResponsiveContainer height={280} width="100%">
        <PieChart>
          <Pie
            cx="50%"
            cy="45%"
            data={data}
            dataKey="totalTokens"
            innerRadius={60}
            nameKey="model"
            outerRadius={100}
            paddingAngle={2}
          >
            {data.map((entry) => (
              <Cell fill={modelColor(entry.model)} key={entry.model} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: "#1e293b",
              border: "1px solid #475569",
              borderRadius: 8,
              color: "#e2e8f0",
              fontSize: 12,
            }}
            formatter={((v: number) => [fmt(v), "Tokens"]) as never}
          />
          <Legend
            formatter={(value: string) => (
              <span style={{ color: "#cbd5e1" }}>{value}</span>
            )}
            wrapperStyle={{ fontSize: 11, color: "#94a3b8" }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function TopProjectsChart({ data }: { data: ProjectUsage[] }) {
  const chartData = useMemo(
    () =>
      data
        .slice(0, 10)
        .map((p) => ({
          ...p,
          project: truncateProject(p.project),
        }))
        .reverse(),
    [data]
  );

  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-800/60 p-5">
      <h3 className="mb-4 font-semibold text-slate-300 text-sm uppercase tracking-wider">
        Top Projects by Tokens
      </h3>
      <ResponsiveContainer height={280} width="100%">
        <BarChart data={chartData} layout="vertical">
          <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
          <XAxis
            axisLine={{ stroke: "#475569" }}
            tick={{ fill: "#94a3b8", fontSize: 11 }}
            tickFormatter={fmtAxis}
            tickLine={false}
            type="number"
          />
          <YAxis
            axisLine={{ stroke: "#475569" }}
            dataKey="project"
            tick={{ fill: "#94a3b8", fontSize: 11 }}
            tickLine={false}
            type="category"
            width={150}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1e293b",
              border: "1px solid #475569",
              borderRadius: 8,
              color: "#e2e8f0",
              fontSize: 12,
            }}
            formatter={((v: number, n: string) => [fmt(v), n]) as never}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "#94a3b8" }} />
          <Bar
            dataKey="inputTokens"
            fill={BAR_COLORS.input}
            name="Input"
            stackId="b"
          />
          <Bar
            dataKey="outputTokens"
            fill={BAR_COLORS.output}
            name="Output"
            stackId="b"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function SessionsTable({ sessions }: { sessions: RecentSession[] }) {
  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-800/60 p-5">
      <h3 className="mb-4 font-semibold text-slate-300 text-sm uppercase tracking-wider">
        Recent Sessions
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-slate-700 border-b text-slate-400 text-xs uppercase tracking-wider">
              <th className="pr-4 pb-3 font-medium">Session</th>
              <th className="pr-4 pb-3 font-medium">Project</th>
              <th className="pr-4 pb-3 font-medium">Last Active</th>
              <th className="pr-4 pb-3 font-medium">Duration</th>
              <th className="pr-4 pb-3 font-medium">Model</th>
              <th className="pr-4 pb-3 text-right font-medium">Turns</th>
              <th className="pr-4 pb-3 text-right font-medium">Input</th>
              <th className="pr-4 pb-3 text-right font-medium">Output</th>
              <th className="pb-3 text-right font-medium">Est. Cost</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                className="border-slate-700/40 border-b text-slate-300"
                key={s.sessionId}
              >
                <td className="py-3 pr-4 font-mono text-xs">
                  {s.sessionId.slice(0, 8)}...
                </td>
                <td className="py-3 pr-4">{truncateProject(s.project, 20)}</td>
                <td className="py-3 pr-4 text-slate-400">
                  {new Date(s.lastActive).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="py-3 pr-4">{s.durationMinutes.toFixed(1)}m</td>
                <td className="py-3 pr-4">
                  <span
                    className="rounded-full border px-2 py-0.5 text-xs"
                    style={{
                      borderColor: modelColor(s.model),
                      color: modelColor(s.model),
                    }}
                  >
                    {s.model}
                  </span>
                </td>
                <td className="py-3 pr-4 text-right">{s.turns}</td>
                <td className="py-3 pr-4 text-right">{fmt(s.inputTokens)}</td>
                <td className="py-3 pr-4 text-right">{fmt(s.outputTokens)}</td>
                <td className="py-3 text-right font-medium text-green-400">
                  {fmtCost(s.estimatedCost)}
                </td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td className="py-8 text-center text-slate-500" colSpan={9}>
                  No sessions found for the selected filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

type Props = {
  params: Promise<{ token: string }>;
};

export default function PublicDashboardPage({ params }: Props) {
  const { token } = use(params);
  const [range, setRange] = useState<DateRange>(30);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const filters: PublicDashboardFilters = useMemo(
    () => ({
      range,
      models: initializedRef.current
        ? Array.from(selectedModels).sort()
        : undefined,
    }),
    [range, selectedModels]
  );

  const { data, isLoading, error, dataUpdatedAt } = usePublicDashboard(
    token,
    filters
  );

  // Initialize selected models from first data load, add new models on refresh
  useEffect(() => {
    if (!data) {
      return;
    }
    const incoming = new Set(data.models);
    if (initializedRef.current) {
      // Add newly discovered models to the selection
      setSelectedModels((prev) => {
        const newModels = data.models.filter((m) => !prev.has(m));
        if (newModels.length === 0) {
          return prev;
        }
        const next = new Set(prev);
        for (const m of newModels) {
          next.add(m);
        }
        return next;
      });
    } else {
      setSelectedModels(incoming);
      initializedRef.current = true;
    }
  }, [data]);

  const allModels = data?.models ?? [];

  const toggleModel = useCallback((m: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(m)) {
        next.delete(m);
      } else {
        next.add(m);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedModels(new Set(allModels));
  }, [allModels]);

  const selectNone = useCallback(() => {
    setSelectedModels(new Set());
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 text-white">
        <div className="rounded-lg border border-red-800 bg-red-900/30 px-6 py-4">
          This dashboard link is invalid or has been revoked.
        </div>
      </div>
    );
  }

  const stats = data?.stats;
  const updatedLabel = dataUpdatedAt
    ? new Date(dataUpdatedAt).toISOString().replace("T", " ").slice(0, 19)
    : "";

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200">
      <div className="mx-auto max-w-7xl px-6 py-6">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <h1 className="font-bold text-orange-400 text-xl">
            Claude Code Usage Dashboard
          </h1>
          <div className="text-slate-500 text-xs">
            Updated: {updatedLabel} &middot; Auto-refresh in 30s
          </div>
        </div>

        {/* Filters */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <ModelFilterPills
            allModels={allModels}
            onAll={selectAll}
            onNone={selectNone}
            onToggle={toggleModel}
            selected={selectedModels}
          />
          <RangeSelector onChange={setRange} value={range} />
        </div>

        {isLoading && !data ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              "sessions",
              "turns",
              "input",
              "output",
              "cache-read",
              "cache-creation",
              "cost",
            ].map((id) => (
              <div
                className="h-24 animate-pulse rounded-lg bg-slate-800/60"
                key={id}
              />
            ))}
          </div>
        ) : (
          <>
            {/* Stat Cards */}
            <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard
                label="Sessions"
                sub={`last ${range || "all"} days`}
                value={fmt(stats?.sessions ?? 0)}
              />
              <StatCard
                label="Turns"
                sub={`last ${range || "all"} days`}
                value={fmt(stats?.turns ?? 0)}
              />
              <StatCard
                label="Input Tokens"
                sub={`last ${range || "all"} days`}
                value={fmt(stats?.inputTokens ?? 0)}
              />
              <StatCard
                label="Output Tokens"
                sub={`last ${range || "all"} days`}
                value={fmt(stats?.outputTokens ?? 0)}
              />
              <StatCard
                label="Cache Read"
                sub="from prompt cache"
                value={fmt(stats?.cacheRead ?? 0)}
              />
            </div>
            <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard
                label="Cache Creation"
                sub="writes to prompt cache"
                value={fmt(stats?.cacheCreation ?? 0)}
              />
              <StatCard
                label="Est. Cost"
                sub={`API pricing, ${new Date().toLocaleString("default", { month: "short", year: "numeric" })}`}
                value={fmtCost(stats?.estimatedCost ?? 0)}
              />
            </div>

            {/* Daily Usage Chart */}
            <div className="mb-6">
              <DailyUsageChart data={data?.dailyUsage ?? []} />
            </div>

            {/* Model Donut + Top Projects */}
            <div className="mb-6 grid gap-6 lg:grid-cols-2">
              <ModelDonutChart data={data?.byModel ?? []} />
              <TopProjectsChart data={data?.topProjects ?? []} />
            </div>

            {/* Recent Sessions */}
            <SessionsTable sessions={data?.recentSessions ?? []} />
          </>
        )}
      </div>
    </div>
  );
}
