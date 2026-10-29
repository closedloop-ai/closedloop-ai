/**
 * ISS-7513 — per-query wall-time profile of the /insights/* dashboard sections.
 *
 * WHY THIS EXISTS ALONGSIDE THE API LANE. `scripts/perf/api-workload.ts` drives
 * the routes over HTTP, which is the right shape for end-to-end numbers and the
 * wrong one for "which STATEMENT is slow": it cannot see inside a section's
 * `Promise.all`, and it cannot run at all without a PostHog-enrolled bearer
 * (`docs/runbooks/performance-profiling.md` — "Known gap — the Dashboard phase
 * 403s for a seed-minted bearer"). This profiles the service layer directly, so
 * it needs no auth, no flag, and no server, and it attributes wall time to the
 * individual query the section is waiting on.
 *
 * Sections fan their queries out concurrently, so a section's wall time is
 * roughly its SLOWEST query, not the sum. Both are reported: the per-query table
 * names the statement to fix, the section total says whether fixing it moved
 * the number a reader actually waits on.
 *
 * WRITES, so it refuses anything but a local `closedloop_perf` database through
 * the same `checkDatabaseUrl` guard the desktop-snapshot import uses — a
 * mistyped host must never seed rows into a shared database.
 *
 *   docker run -d --name perf-pg -p 5442:5432 \
 *     -e POSTGRES_PASSWORD=password -e POSTGRES_DB=closedloop_perf postgres:16
 *   export DATABASE_URL=postgresql://postgres:password@localhost:5442/closedloop_perf
 *   pnpm -C packages/database exec prisma migrate deploy
 *   pnpm -C apps/api perf:insights-sections -- --sessions 400 --events-per-session 60
 *
 * Re-running reuses the corpus unless `--seed` is passed, so a before/after pair
 * measures the same rows.
 */

import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { fetchAgentPipelineGraph } from "@/app/insights/agent-pipeline";
import { fetchAgentsSpendBreakdowns } from "@/app/insights/agents-spend";
import { fetchActivityHeatmap } from "@/app/insights/lib/activity-heatmap";
import { insightsService } from "@/app/insights/service";
import {
  countEvents,
  fetchEventTypeBuckets,
  fetchEventVolume,
  fetchToolUsageBuckets,
} from "@/app/insights/service/event-queries";
import {
  type InsightsScopeContext,
  sessionScopeSql,
} from "@/app/insights/service/scope";
import {
  countSessions,
  fetchAgentBuckets,
  fetchSessionActivity,
  fetchSessionRollup,
  fetchToolRunsByDay,
  fetchUserBreakdown,
  sumSessionCost,
  sumToolRuns,
} from "@/app/insights/service/session-queries";
import {
  fetchModelUsageRows,
  fetchTokenTotals,
} from "@/app/insights/service/token-queries";
import { checkDatabaseUrl } from "./perf-import-desktop-snapshot-guards";
import {
  describePopulation,
  resolveSeededOrganization,
  seedCorpus,
} from "./perf-insights-sections-corpus";

const DEFAULT_SESSIONS = 400;
const DEFAULT_EVENTS_PER_SESSION = 60;
const DEFAULT_REPEATS = 5;
const WINDOW_DAYS = 90;
/**
 * How far back the seeded corpus reaches. Deliberately much wider than the
 * 90-day window under test: an index on a timestamp only earns its keep when
 * the window is SELECTIVE, so a corpus that fits entirely inside the window
 * measures a planner correctly choosing a sequential scan and proves nothing
 * about a real org carrying years of history.
 */
const DEFAULT_HISTORY_DAYS = 730;
const MS_PER_DAY = 86_400_000;

type Timing = { label: string; medianMs: number; p95Ms: number };

main().catch((error) => {
  process.exitCode = 1;
  process.stderr.write(`${String(error)}\n`);
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const guard = checkDatabaseUrl(process.env.DATABASE_URL);
  if (!guard.ok) {
    process.exitCode = 1;
    process.stderr.write(`${guard.error.code}: ${guard.error.message}\n`);
    return;
  }

  const organizationId = args.seed
    ? await seedCorpus(args)
    : await resolveSeededOrganization();
  if (!organizationId) {
    process.exitCode = 1;
    process.stderr.write(
      "no seeded organization found — rerun with --seed to build the corpus\n"
    );
    return;
  }

  const ctx: InsightsScopeContext = {
    organizationId,
    userId: organizationId,
    scope: InsightsScope.Org,
  };
  const now = new Date();
  const end = now;
  const start = new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY);
  const scopeSql = sessionScopeSql(ctx);

  const population = await describePopulation(organizationId);
  process.stdout.write(`\n## Corpus\n\n${population}\n`);

  const perQuery = await measureAll(args.repeats, [
    ["utilization countEvents", () => countEvents(ctx, start, end)],
    [
      "utilization fetchEventTypeBuckets",
      () => fetchEventTypeBuckets(ctx, start, end),
    ],
    [
      "utilization fetchEventVolume",
      () => fetchEventVolume(ctx, start, end, "UTC"),
    ],
    [
      "utilization fetchSessionRollup",
      () => fetchSessionRollup(ctx, { start, end }),
    ],
    [
      "utilization fetchSessionActivity",
      () => fetchSessionActivity(ctx, start, end),
    ],
    ["utilization countSessions", () => countSessions(ctx, start, end)],
    [
      "utilization fetchUserBreakdown",
      () => fetchUserBreakdown(ctx, start, end),
    ],
    [
      "utilization fetchActivityHeatmap",
      () => fetchActivityHeatmap(scopeSql, "UTC", start, end),
    ],
    ["agents fetchTokenTotals", () => fetchTokenTotals(ctx, start, end)],
    [
      "agents fetchModelUsageRows",
      () => fetchModelUsageRows(ctx, start, end, "UTC"),
    ],
    [
      "agents fetchAgentsSpendBreakdowns",
      () => fetchAgentsSpendBreakdowns(scopeSql, start, end),
    ],
    ["agents fetchAgentBuckets", () => fetchAgentBuckets(ctx, start, end)],
    [
      "agents fetchToolUsageBuckets",
      () => fetchToolUsageBuckets(ctx, start, end),
    ],
    ["agents sumToolRuns", () => sumToolRuns(ctx, start, end)],
    ["agents fetchToolRunsByDay", () => fetchToolRunsByDay(ctx, start, end)],
    [
      "agents fetchAgentPipelineGraph",
      () => fetchAgentPipelineGraph(scopeSql, start, end),
    ],
    ["delivery sumSessionCost", () => sumSessionCost(ctx, { start, end })],
  ]);

  const perSection = await measureAll(args.repeats, [
    [
      "SECTION /insights/delivery",
      () => insightsService.getDelivery(ctx, InsightsPeriod.Quarter, now),
    ],
    [
      "SECTION /insights/utilization",
      () => insightsService.getUtilization(ctx, InsightsPeriod.Quarter, now),
    ],
    [
      "SECTION /insights/agents",
      () => insightsService.getAgents(ctx, InsightsPeriod.Quarter, now),
    ],
  ]);

  process.stdout.write(
    `\n## Per-query wall time (${args.repeats} repeats)\n\n${table(
      [...perQuery].sort((a, b) => b.medianMs - a.medianMs)
    )}\n`
  );
  process.stdout.write(
    `\n## Per-section wall time (${args.repeats} repeats)\n\n${table(perSection)}\n`
  );
}

function parseArgs(argv: string[]): {
  sessions: number;
  eventsPerSession: number;
  repeats: number;
  historyDays: number;
  seed: boolean;
} {
  const read = (flag: string, fallback: number): number => {
    const at = argv.indexOf(flag);
    if (at === -1) {
      return fallback;
    }
    const parsed = Number(argv[at + 1]);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  };
  return {
    sessions: read("--sessions", DEFAULT_SESSIONS),
    eventsPerSession: read("--events-per-session", DEFAULT_EVENTS_PER_SESSION),
    repeats: read("--repeats", DEFAULT_REPEATS),
    historyDays: read("--history-days", DEFAULT_HISTORY_DAYS),
    seed: argv.includes("--seed"),
  };
}

async function measureAll(
  repeats: number,
  cases: [string, () => Promise<unknown>][]
): Promise<Timing[]> {
  const timings: Timing[] = [];
  for (const [label, run] of cases) {
    timings.push(await measure(label, repeats, run));
  }
  return timings;
}

/** One warmup (planner/cache), then `repeats` timed runs; median and p95. */
async function measure(
  label: string,
  repeats: number,
  run: () => Promise<unknown>
): Promise<Timing> {
  await run();
  const samples: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const startedAt = performance.now();
    await run();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms:
      samples[
        Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)
      ],
  };
}

function table(timings: Timing[]): string {
  const header = "| query | median ms | p95 ms |\n|---|---:|---:|";
  const rows = timings.map(
    (t) => `| ${t.label} | ${t.medianMs.toFixed(1)} | ${t.p95Ms.toFixed(1)} |`
  );
  return [header, ...rows].join("\n");
}
