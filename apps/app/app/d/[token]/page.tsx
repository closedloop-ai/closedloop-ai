"use client";

import type {
  DailyTokenUsage,
  DeliveryStats,
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
  if (n >= 1000) {
    return `$${(n / 1000).toFixed(1)}K`;
  }
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
  if (model in MODEL_COLORS) {
    return MODEL_COLORS[model];
  }
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (model.startsWith(key)) {
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

function rangeSuffix(range: DateRange): string {
  return range === 0 ? "all time" : `last ${range} days`;
}

// ── Components ──────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-5 py-4 ${
        highlight
          ? "border-green-700/50 bg-green-900/20"
          : "border-slate-700/50 bg-slate-800/60"
      }`}
    >
      <div className="mb-1 font-medium text-slate-400 text-xs uppercase tracking-wider">
        {label}
      </div>
      <div
        className={`font-bold text-2xl ${highlight ? "text-green-400" : "text-white"}`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-slate-500 text-xs">{sub}</div>}
    </div>
  );
}

function DeliveryCards({
  delivery,
  range,
}: {
  delivery: DeliveryStats;
  range: DateRange;
}) {
  const suffix = rangeSuffix(range);
  return (
    <div className="mb-6">
      <h2 className="mb-3 font-semibold text-slate-300 text-sm uppercase tracking-wider">
        Delivery Output
      </h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="PRDs Created"
          sub={suffix}
          value={delivery.prdsCreated.toString()}
        />
        <StatCard
          label="Plans Created"
          sub={suffix}
          value={delivery.plansCreated.toString()}
        />
        <StatCard
          label="Features"
          sub={suffix}
          value={delivery.featuresCreated.toString()}
        />
        <StatCard
          label="PRs Merged"
          sub={suffix}
          value={delivery.prsMerged.toString()}
        />
        <StatCard
          label="Agentic Workflows"
          sub={suffix}
          value={fmt(delivery.agenticWorkflows)}
        />
      </div>
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
        Daily Token Usage
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
            formatter={
              ((v: number, _n: string, entry: { payload: ModelUsage }) => [
                `${fmt(v)} tokens (${fmtCost(entry.payload.apiCost)})`,
                entry.payload.model,
              ]) as never
            }
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
              <th className="pb-3 text-right font-medium">Output</th>
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
                <td className="py-3 text-right">{fmt(s.outputTokens)}</td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td className="py-8 text-center text-slate-500" colSpan={8}>
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

function DashboardContent({
  data,
  range,
}: {
  data: NonNullable<ReturnType<typeof usePublicDashboard>["data"]>;
  range: DateRange;
}) {
  const { stats, delivery } = data;
  const totalTokens =
    stats.inputTokens +
    stats.outputTokens +
    stats.cacheRead +
    stats.cacheCreation;
  const suffix = rangeSuffix(range);

  return (
    <>
      {/* Hero: API Cost Equivalent + Total Tokens */}
      <div className="mb-6">
        <h2 className="mb-3 font-semibold text-slate-300 text-sm uppercase tracking-wider">
          Token Investment
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard
            highlight
            label="API Cost Equivalent"
            sub="Anthropic API pricing by model"
            value={fmtCost(stats.apiCostEquivalent ?? 0)}
          />
          <StatCard
            label="Total Tokens"
            sub={suffix}
            value={fmt(totalTokens)}
          />
          <StatCard label="Sessions" sub={suffix} value={fmt(stats.sessions)} />
          <StatCard
            label="Subscription"
            sub="electron targets (included)"
            value={fmt(stats.subscriptionTokens ?? 0)}
          />
          <StatCard
            label="API Tokens"
            sub="cloud / API key usage"
            value={fmt(stats.apiTokens ?? 0)}
          />
        </div>
      </div>

      {/* Token breakdown */}
      <div className="mb-6">
        <h2 className="mb-3 font-semibold text-slate-300 text-sm uppercase tracking-wider">
          Token Breakdown
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Input" sub={suffix} value={fmt(stats.inputTokens)} />
          <StatCard
            label="Output"
            sub={suffix}
            value={fmt(stats.outputTokens)}
          />
          <StatCard
            label="Cache Read"
            sub="prompt cache hits"
            value={fmt(stats.cacheRead)}
          />
          <StatCard
            label="Cache Creation"
            sub="prompt cache writes"
            value={fmt(stats.cacheCreation)}
          />
        </div>
      </div>

      {/* Delivery Output */}
      {delivery && <DeliveryCards delivery={delivery} range={range} />}

      {/* Daily Usage Chart */}
      <div className="mb-6">
        <DailyUsageChart data={data.dailyUsage} />
      </div>

      {/* Model Donut + Top Projects */}
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <ModelDonutChart data={data.byModel} />
        <TopProjectsChart data={data.topProjects} />
      </div>

      {/* Recent Sessions */}
      <SessionsTable sessions={data.recentSessions} />
    </>
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

  useEffect(() => {
    if (!data) {
      return;
    }
    if (initializedRef.current) {
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
      setSelectedModels(new Set(data.models));
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

  const updatedLabel = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  return (
    <div className="h-screen overflow-y-auto bg-slate-900 text-slate-200">
      <div className="mx-auto max-w-7xl px-6 py-6">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-bold text-orange-400 text-xl">
              {data?.organizationName ?? "AI"} &mdash; Claude Code Usage
            </h1>
            <p className="mt-1 text-slate-500 text-xs">
              Accelerating AI-driven software delivery
            </p>
          </div>
          <div className="text-right text-slate-500 text-xs">
            <div>Updated: {updatedLabel}</div>
            <div>Auto-refresh 30s</div>
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

        {isLoading && !data && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {[
              "cost",
              "tokens",
              "sessions",
              "sub",
              "api",
              "prds",
              "plans",
              "features",
              "prs",
              "workflows",
            ].map((id) => (
              <div
                className="h-24 animate-pulse rounded-lg bg-slate-800/60"
                key={id}
              />
            ))}
          </div>
        )}
        {data && <DashboardContent data={data} range={range} />}
      </div>
    </div>
  );
}
