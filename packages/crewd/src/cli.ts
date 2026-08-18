#!/usr/bin/env node
/**
 * `crewd` CLI — the filesystem/process entry point.
 *
 * This module is the ONLY place the runnable daemon is wired to concrete
 * fs-backed collaborators: it constructs the JSON `TaskStore`, the `FileLock`
 * single-instance guard, and the default cascade `dispatch`, then drives the
 * `Daemon`. The importable core (`@repo/crewd`) has none of this coupling — the
 * seams (`StorePort`, `LockPort`, `Dispatch`) are injected here so the same
 * `Daemon` can run against a SQLite store inside apps/desktop without a CLI.
 *
 * Keep all `process.argv` / stdout / fs interaction in this file.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultTaskRoute } from "./broker.js";
import { createDispatch, type OrchestrationRunner } from "./dispatch.js";
import { defaultRegistry } from "./harness/index.js";
import {
  type CascadeStep,
  cascadeStepSchema,
  type HarnessName,
  hasConfirmedNativeOwner,
  PassKind,
  passKindSchema,
  RunStatus,
  type ScheduledTask,
  TaskRoute,
} from "./model.js";
import { type AuditRunResult, runAuditPass } from "./passes/audit.js";
import {
  type AuditWorkspace,
  prepareAuditWorkspace,
} from "./passes/audit-workspace.js";
import type { Finding } from "./passes/findings.js";
import type { DispatchContext } from "./scheduler/daemon.js";
import { Daemon, type DispatchOutcome } from "./scheduler/daemon.js";
import { FileLock } from "./scheduler/file-lock.js";
import { createScheduledTasksWriter } from "./scheduler/native-scheduled-tasks.js";
import { defaultStorePath, TaskStore } from "./scheduler/store.js";

const DEFAULT_CASCADE: CascadeStep[] = [
  { harness: "codex" },
  { harness: "claude" },
  { harness: "opencode" },
];

export type CliOptions = {
  storePath?: string;
  lockPath?: string;
  intervalMs?: number;
  cascade?: CascadeStep[];
  repoDir?: string;
  promptsDir?: string;
  perAttemptTimeoutMs?: number;
  kind?: string;
  pass?: string;
  /**
   * The runnable prompt body for `add` (FEA-4069). A `claude-scheduled-tasks`
   * (native) task MUST carry a non-empty prompt: the native writer rejects an
   * empty-prompt task ({@link toClaudeEntry} treats it as unrepresentable), so
   * without this the advertised native `add` path could only ever report
   * `owner=daemon`. A `local-cascade` review/custom task derives its work from its
   * character/cascade and leaves this empty.
   */
  prompt?: string;
  /**
   * Explicit broker route for `add` (FEA-4048). When omitted, a task defaults to
   * the capability-aware route ({@link defaultTaskRoute}): a Claude-primary task
   * lands on `claude-scheduled-tasks` (native by default), everything else on
   * `local-cascade`. An explicit `--route` always wins.
   */
  route?: TaskRoute;
};

const HARNESS_NAMES: readonly HarnessName[] = ["claude", "codex", "opencode"];

function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value);
}

/**
 * Parse a `--cascade` entry: a bare harness name (`codex`) or the
 * `"harness:model"` shorthand (`codex:o3`). Returns undefined when the harness
 * half is not a known harness, so the caller can report the bad token.
 */
function parseCascadeEntry(raw: string): CascadeStep | undefined {
  const harness = raw.includes(":") ? raw.slice(0, raw.indexOf(":")) : raw;
  if (!isHarnessName(harness)) {
    return;
  }
  return cascadeStepSchema.parse(raw);
}

/** Render a step back to `harness` or `harness:model` for display. */
function formatCascadeStep(step: CascadeStep): string {
  return step.model ? `${step.harness}:${step.model}` : step.harness;
}

/**
 * Parse a `--cascade` value (`codex,claude:opus,...`) into ordered steps.
 * Throws on any token whose harness half is unknown rather than silently
 * dropping it (which, if it emptied the list, would disable the default
 * cascade).
 */
function parseCascadeOption(value: string): CascadeStep[] {
  const raw = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const steps: CascadeStep[] = [];
  const unknown: string[] = [];
  for (const token of raw) {
    const step = parseCascadeEntry(token);
    if (step) {
      steps.push(step);
    } else {
      unknown.push(token);
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `unknown harness in --cascade: ${unknown.join(", ")} (valid: ${HARNESS_NAMES.join(", ")})`
    );
  }
  return steps;
}

/**
 * The routes an operator may set via `--route`. Deliberately the two DOCUMENTED
 * values (see `cmdHelp`): the daemon route and the native LOCAL scheduler route.
 * `claude-routine` (the cloud path) is OPT-IN only and has no CLI registration
 * wiring, so it is intentionally NOT settable here — the accepted set matches the
 * documented set.
 */
const CLI_ROUTES: readonly TaskRoute[] = [
  TaskRoute.LocalCascade,
  TaskRoute.ClaudeScheduledTasks,
];

/**
 * Parse an explicit `--route` value. Throws (mirroring {@link parseCascadeOption})
 * on any value outside {@link CLI_ROUTES} so a typo surfaces as an error and
 * `main`'s catch sets `process.exitCode = 2`, rather than being silently dropped
 * and then flipped to the OPPOSITE (capability-aware native) default.
 */
function parseRouteOption(value: string | undefined): TaskRoute {
  if (
    value !== undefined &&
    (CLI_ROUTES as readonly string[]).includes(value)
  ) {
    return value as TaskRoute;
  }
  throw new Error(
    `unknown --route: ${value ?? "(missing)"} (valid: ${CLI_ROUTES.join(", ")})`
  );
}

/**
 * A value-taking flag applier: given the raw next token (already shifted off the
 * arg list), record it onto `opts`. A missing/invalid value is dropped so it
 * can't reach the daemon as garbage (e.g. NaN interval → busy-loop).
 */
type FlagApplier = (opts: CliOptions, value: string | undefined) => void;

function positiveMs(value: string | undefined): number | undefined {
  const ms = Number(value);
  // Ignore a missing/non-numeric value so it can't reach the daemon as NaN
  // (NaN survives `?? 30_000` and makes setInterval busy-loop at delay 0).
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Value-taking flags → their appliers. A plain-object lookup with an untrusted
 * key can hit inherited properties (`__proto__`, `constructor`), so this uses a
 * null-prototype dispatch table.
 */
const FLAG_APPLIERS: Record<string, FlagApplier> = Object.assign(
  Object.create(null),
  {
    "--store": (o: CliOptions, v: string | undefined) => {
      o.storePath = v;
    },
    "--lock": (o: CliOptions, v: string | undefined) => {
      o.lockPath = v;
    },
    "--interval": (o: CliOptions, v: string | undefined) => {
      const ms = positiveMs(v);
      if (ms !== undefined) {
        o.intervalMs = ms;
      }
    },
    "--cascade": (o: CliOptions, v: string | undefined) => {
      o.cascade = parseCascadeOption(v ?? "");
    },
    "--repo": (o: CliOptions, v: string | undefined) => {
      o.repoDir = v;
    },
    "--prompts-dir": (o: CliOptions, v: string | undefined) => {
      o.promptsDir = v;
    },
    "--per-attempt-timeout": (o: CliOptions, v: string | undefined) => {
      const ms = positiveMs(v);
      if (ms !== undefined) {
        o.perAttemptTimeoutMs = ms;
      }
    },
    "--kind": (o: CliOptions, v: string | undefined) => {
      o.kind = v;
    },
    "--pass": (o: CliOptions, v: string | undefined) => {
      o.pass = v;
    },
    "--prompt": (o: CliOptions, v: string | undefined) => {
      o.prompt = v;
    },
    "--route": (o: CliOptions, v: string | undefined) => {
      // Throw on an unknown route (FEA-4048) so a typo surfaces as an error and
      // `main`'s catch sets exitCode=2 — never silently dropped and then flipped
      // to the OPPOSITE capability-aware native default.
      o.route = parseRouteOption(v);
    },
  } satisfies Record<string, FlagApplier>
);

export function parseOptions(argv: string[]): {
  command: string;
  rest: string[];
  opts: CliOptions;
} {
  const [command = "help", ...tail] = argv;
  const rest: string[] = [];
  const opts: CliOptions = {};
  while (tail.length > 0) {
    const arg = tail.shift() ?? "";
    const applier = FLAG_APPLIERS[arg];
    if (applier) {
      applier(opts, tail.shift());
    } else {
      rest.push(arg);
    }
  }
  return { command, rest, opts };
}

/**
 * Construct the JSON `TaskStore` with the NATIVE local-scheduler writer wired in
 * (FEA-4069). This is what makes the `claude-scheduled-tasks` route executable
 * end-to-end from the CLI: an `add`/`route`/`disable`/`remove` that touches a
 * native-route task now materializes (or removes) the entry in Claude Code's
 * local `~/.claude/scheduled_tasks.json` and stamps (or clears) the confirmed
 * native-owner marker, so the daemon suppresses its own run for a confirmed slot.
 * The writer's diagnostics go to STDERR so they never corrupt the machine-
 * readable task/run data the commands print to stdout.
 */
function makeStore(opts: CliOptions): TaskStore {
  return new TaskStore(opts.storePath ?? defaultStorePath(), {
    scheduledTasksRegistrar: createScheduledTasksWriter({
      log: (m) => process.stderr.write(`${m}\n`),
    }),
    log: (m) => process.stderr.write(`${m}\n`),
  });
}

function cmdList(opts: CliOptions): void {
  const store = makeStore(opts);
  const tasks = store.listTasks();
  if (tasks.length === 0) {
    process.stdout.write("no tasks\n");
    return;
  }
  for (const t of tasks) {
    const state = t.enabled ? "enabled" : "disabled";
    process.stdout.write(
      `${t.id}  ${t.name}  [${t.kind}]  cron="${t.cron}"  ${state}  route=${t.route}  owner=${ownerLabel(t)}  next=${t.nextRunAt ?? "-"}  last=${t.lastStatus ?? "-"}\n`
    );
  }
}

/**
 * The scheduler that currently OWNS a task's firing, for the `list` surface
 * (FEA-4069 observability). A task on a native route with a CONFIRMED native
 * owner (`hasConfirmedNativeOwner`) is fired by Claude Code's own scheduler and
 * suppressed locally — report `claude` — otherwise the local `daemon` owns it
 * (a `local-cascade` task, or a native route whose registration is unconfirmed
 * and therefore still runs locally as the honest fallback).
 */
function ownerLabel(task: ScheduledTask): string {
  return hasConfirmedNativeOwner(task) ? "claude" : "daemon";
}

async function cmdAdd(rest: string[], opts: CliOptions): Promise<void> {
  const [name, cron] = rest;
  if (!(name && cron)) {
    process.stderr.write(
      'usage: crewd add <name> <cron> [--store <path>] [--cascade a,b] [--kind review] [--pass <character>] [--prompt "<text>"] [--route local-cascade|claude-scheduled-tasks]\n'
    );
    process.exitCode = 2;
    return;
  }
  const store = makeStore(opts);
  const parsedKind = passKindSchema.safeParse(opts.kind);
  const kind: PassKind = parsedKind.success ? parsedKind.data : PassKind.Custom;
  const harnessCascade = opts.cascade ?? [];
  // FEA-4048: an explicit `--route` wins; otherwise derive the capability-aware
  // default so a Claude-primary night-crew task lands on the native scheduler
  // (`claude-scheduled-tasks`) by default while a codex/opencode-primary task
  // stays daemon-owned (`local-cascade`). The fallback cascade mirrors what
  // `cmdStart` uses (`opts.cascade ?? DEFAULT_CASCADE`), so a task with no
  // per-task cascade derives its route from the SAME effective default order the
  // operator would run the daemon with on this invocation, not a phantom empty
  // cascade. NOTE: `add` and `start` are separate invocations — a daemon later
  // started with a DIFFERENT `--cascade` can diverge from this add-time default,
  // but the persisted route is only an INTENT: the daemon's confirmed-owner guard
  // (`hasConfirmedNativeOwner`) keys off a stamped native owner, not this route,
  // so a mismatch never double-fires or drops a task.
  const fallbackCascade = opts.cascade ?? DEFAULT_CASCADE;
  const route =
    opts.route ?? defaultTaskRoute({ harnessCascade }, fallbackCascade);
  // FEA-4069: a native (`claude-scheduled-tasks`) task is unrepresentable — and
  // so silently stays daemon-owned — without a runnable prompt. Fail fast so the
  // operator gets an actionable error instead of an `add` that reports
  // `owner=daemon` and never actually reaches Claude Code's scheduler.
  const prompt = opts.prompt ?? "";
  if (route === TaskRoute.ClaudeScheduledTasks && prompt.length === 0) {
    process.stderr.write(
      'a claude-scheduled-tasks task needs a runnable prompt; pass --prompt "<text>"\n'
    );
    process.exitCode = 2;
    return;
  }
  const task = store.upsertTask({
    name,
    cron,
    harnessCascade,
    kind,
    pass: opts.pass,
    prompt,
    route,
  });
  // Await the native-schedule reconcile so the printed owner reflects a CONFIRMED
  // native registration (or the daemon fallback when native was unrepresentable).
  await store.whenReconciled();
  const stored = store.getTask(task.id) ?? task;
  process.stdout.write(
    `added ${stored.id} (${stored.name}); route=${stored.route}; owner=${ownerLabel(stored)}; next=${stored.nextRunAt ?? "-"}\n`
  );
}

async function cmdRemove(rest: string[], opts: CliOptions): Promise<void> {
  const [id] = rest;
  if (!id) {
    process.stderr.write("usage: crewd remove <id>\n");
    process.exitCode = 2;
    return;
  }
  const store = makeStore(opts);
  const removed = store.removeTask(id);
  // Await the deregister so a removed native task's entry is actually gone from
  // Claude Code's file before the process exits.
  await store.whenReconciled();
  process.stdout.write(removed ? `removed ${id}\n` : `no such task ${id}\n`);
}

async function cmdEnable(
  rest: string[],
  opts: CliOptions,
  enabled: boolean
): Promise<void> {
  const [id] = rest;
  if (!id) {
    process.stderr.write(
      `usage: crewd ${enabled ? "enable" : "disable"} <id>\n`
    );
    process.exitCode = 2;
    return;
  }
  const store = makeStore(opts);
  const updated = store.setEnabled(id, enabled);
  // Await the reconcile: disabling a native task must remove its Claude entry
  // (there is no `enabled` flag on disk), enabling re-materializes it.
  await store.whenReconciled();
  process.stdout.write(
    updated
      ? `${id} ${enabled ? "enabled" : "disabled"}\n`
      : `no such task ${id}\n`
  );
}

/**
 * FEA-4069: flip an EXISTING task's broker route (`crewd route <id> <route>`).
 * `add` only sets a route at creation; this is the operator opt-in to (or out of)
 * the native `claude-scheduled-tasks` scheduler for a task that already exists —
 * the CLI counterpart to the desktop editor's route control. The value must be
 * one of {@link CLI_ROUTES}; an unknown value errors (exitCode 2) rather than
 * silently persisting garbage. Reuses the store's `upsertTask` path, so the route
 * change reconciles the native scheduler exactly like an edit: flipping to
 * `claude-scheduled-tasks` materializes the entry + confirms the owner, flipping
 * back deregisters + clears it. The stored route (and its now-confirmed owner) are
 * echoed so the operator sees which scheduler took the task.
 */
async function cmdRoute(rest: string[], opts: CliOptions): Promise<void> {
  const [id, routeArg] = rest;
  if (!(id && routeArg)) {
    process.stderr.write(`usage: crewd route <id> <${CLI_ROUTES.join("|")}>\n`);
    process.exitCode = 2;
    return;
  }
  let route: TaskRoute;
  try {
    route = parseRouteOption(routeArg);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
    return;
  }
  const store = makeStore(opts);
  const existing = store.getTask(id);
  if (!existing) {
    process.stdout.write(`no such task ${id}\n`);
    return;
  }
  store.upsertTask({ ...existing, route });
  // Await the reconcile so the echoed owner reflects the CONFIRMED result.
  await store.whenReconciled();
  const updated = store.getTask(id) ?? existing;
  process.stdout.write(
    `${id} route=${updated.route}; owner=${ownerLabel(updated)}\n`
  );
}

function cmdRuns(rest: string[], opts: CliOptions): void {
  const store = makeStore(opts);
  const runs = store.listRuns(rest[0], 50);
  for (const r of runs) {
    process.stdout.write(
      `${r.startedAt}  ${r.taskName}  ${r.status}${r.harnessUsed ? ` via ${r.harnessUsed}` : ""}  ${r.summary}${r.logPath ? ` [findings: ${r.logPath}]` : ""}\n`
    );
  }
}

type ReviewOrchestratorConfig = {
  repoDir: string;
  promptsDir: string;
  /** Fallback cascade when a task carries no per-task `harnessCascade`. */
  defaultCascade: readonly CascadeStep[];
  /** Directory the durable per-run findings file is written to. */
  findingsDir: string;
  perAttemptTimeoutMs?: number;
};

function reviewOrchestrator(
  config: ReviewOrchestratorConfig
): OrchestrationRunner {
  return (
    task: ScheduledTask,
    ctx: DispatchContext
  ): Promise<DispatchOutcome> => runReviewOrchestration(task, ctx, config);
}

async function runReviewOrchestration(
  task: ScheduledTask,
  ctx: DispatchContext,
  config: ReviewOrchestratorConfig
): Promise<DispatchOutcome> {
  const character = task.pass || task.name;
  const promptPath = join(config.promptsDir, `${character}.md`);
  if (!existsSync(promptPath)) {
    return {
      status: RunStatus.Failed,
      harnessUsed: null,
      attempts: [],
      summary: `${character}: prompt not found`,
      error: `prompt not found: ${promptPath}`,
    };
  }

  // Prefer the task's own cascade (which may pin a model, e.g. `claude:opus`)
  // over the daemon default; keep the full `(harness, model?)` steps so the
  // selected model is honored, not dropped.
  const cascade =
    task.harnessCascade.length > 0
      ? task.harnessCascade
      : config.defaultCascade;

  // SECURITY: the harness cascade spawns each engine with its dangerous bypass
  // flags, so the character's "read-only" instruction is NOT an enforcement
  // boundary. Never point the cascade at the operator's live checkout — run it
  // against a disposable copy so any write a prompt-injected or misbehaving
  // harness makes is discarded with the copy. Disposed unconditionally below.
  let workspace: AuditWorkspace;
  try {
    workspace = await prepareAuditWorkspace(config.repoDir, undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: RunStatus.Failed,
      harnessUsed: null,
      attempts: [],
      summary: `${character}: workspace prepare failed`,
      error: `workspace prepare failed: ${message}`,
    };
  }

  try {
    const result = await runAuditPass({
      character,
      repoDir: workspace.dir,
      promptsDir: config.promptsDir,
      cascade,
      registry: defaultRegistry,
      perAttemptTimeoutMs: config.perAttemptTimeoutMs,
      onProgress: (e) => {
        if (e.phase === "attempt") {
          const a = e.attempt;
          ctx.log(
            `  [${a.harness}] ${a.outcome} ${a.durationMs}ms${a.note ? ` — ${a.note}` : ""}`
          );
        }
        if (e.phase === "done") {
          ctx.log(`  → ${e.findingsCount} findings, ok=${e.ok}`);
        }
      },
    });

    // Give the findings a durable, surfaced destination: persist them next to
    // the store and point the run's `logPath` at the file so `crewd runs` can
    // show where the review's output landed (a bare count would not).
    const logPath = persistFindings(
      config.findingsDir,
      task.id,
      result.findings
    );
    return toReviewOutcome(character, result, logPath);
  } finally {
    await workspace.dispose().catch(() => {
      // Best-effort cleanup; a leftover temp copy must never fail the run.
    });
  }
}

/**
 * Map an audit result to a dispatch outcome. A cascade that failed but still
 * captured findings (`ok === false`, `findings.length > 0`) is a PARTIAL
 * failure: keep the status `failed`, but surface the findings count and a
 * non-null error instead of a bare task-name summary with a null error.
 */
export function toReviewOutcome(
  character: string,
  result: AuditRunResult,
  logPath: string | null
): DispatchOutcome {
  const found = `${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}`;
  if (result.ok) {
    return {
      status: RunStatus.Success,
      harnessUsed: result.harnessUsed,
      attempts: result.attempts,
      summary: `${character}: ${found} via ${result.harnessUsed}`,
      error: null,
      logPath,
    };
  }
  const partial =
    result.findings.length > 0 ? ` (partial: ${found} captured)` : "";
  return {
    status: RunStatus.Failed,
    harnessUsed: result.harnessUsed,
    attempts: result.attempts,
    summary: `${character}: ${result.error ?? "cascade did not complete cleanly"}${partial}`,
    error: result.error ?? "cascade did not complete cleanly",
    logPath,
  };
}

/**
 * Write a run's parsed findings to a durable JSONL file under `findingsDir` and
 * return its path (null when there were no findings, or on a best-effort write
 * failure — a missing artifact must never fail the run's own success).
 */
function persistFindings(
  findingsDir: string,
  taskId: string,
  findings: readonly Finding[]
): string | null {
  if (findings.length === 0) {
    return null;
  }
  try {
    mkdirSync(findingsDir, { recursive: true });
    const path = join(findingsDir, `${taskId}-${Date.now()}.findings.jsonl`);
    writeFileSync(
      path,
      `${findings.map((f) => JSON.stringify(f)).join("\n")}\n`,
      "utf8"
    );
    return path;
  } catch {
    return null;
  }
}

async function cmdStart(opts: CliOptions): Promise<void> {
  const store = makeStore(opts);
  const cascade = opts.cascade ?? DEFAULT_CASCADE;
  const repoDir = opts.repoDir ?? process.cwd();
  const promptsDir =
    opts.promptsDir ?? join(repoDir, "apps/desktop/resources/audit-characters");

  const orchestration: Record<string, OrchestrationRunner> = {};
  orchestration[PassKind.Review] = reviewOrchestrator({
    repoDir,
    promptsDir,
    defaultCascade: cascade,
    findingsDir: join(dirname(store.path), "findings"),
    perAttemptTimeoutMs: opts.perAttemptTimeoutMs,
  });

  // FEA-4069: re-materialize + re-confirm every enabled native-route task before
  // the first tick, so a daemon booting over a store that already holds
  // `claude-scheduled-tasks` tasks (added in a prior invocation) hands them to
  // Claude Code's scheduler and suppresses its own run — instead of running them
  // locally until the operator next edits one. Await the reconcile BEFORE
  // starting the daemon so the confirmed-owner marker is stamped before the first
  // tick reads the tasks — otherwise a native task due right at boot could
  // double-fire (once locally, once via Claude) before ownership lands.
  store.reconcileNativeSchedulesOnStartup();
  await store.whenReconciled();

  const dispatch = createDispatch({
    orchestration,
    perAttemptTimeoutMs: opts.perAttemptTimeoutMs,
  });
  const daemon = new Daemon(
    {
      store,
      dispatch,
      lock: new FileLock(opts.lockPath),
      log: (m) => process.stdout.write(`${m}\n`),
    },
    {
      defaultCascade: cascade,
      intervalMs: opts.intervalMs,
      lockPath: opts.lockPath,
    }
  );
  daemon.start();
  process.stdout.write(
    `crewd started (store ${store.path}); cascade=${cascade.map(formatCascadeStep).join(",")}\n`
  );
  const shutdown = () => {
    daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cmdHelp(): void {
  process.stdout.write(
    [
      "crewd — portable night-crew scheduler",
      "",
      "usage: crewd <command> [options]",
      "",
      "commands:",
      "  list                     list scheduled tasks (shows route + owner)",
      "  add <name> <cron>        add a task",
      "  route <id> <route>       change a task's route (local-cascade or",
      "                           claude-scheduled-tasks)",
      "  remove <id>              remove a task",
      "  enable <id>              enable a task",
      "  disable <id>             disable a task",
      "  runs [taskId]            show recent run history",
      "  start                    run the scheduler loop (foreground)",
      "  help                     show this help",
      "",
      "options:",
      "  --store <path>           store file (default: $CREW_HOME/scheduled_tasks.json)",
      "  --lock <path>            single-instance lock file",
      "  --interval <ms>          tick interval for `start`",
      "  --cascade a,b,c          cascade order; each entry is `harness` or",
      "                           `harness:model` (e.g. codex:o3,claude:opus)",
      "  --repo <path>            repo directory for audit passes (default: cwd)",
      "  --prompts-dir <path>     character prompts directory",
      "  --per-attempt-timeout <ms> per-harness timeout (default: unlimited)",
      "  --kind <type>            task kind for `add` (review, custom, ...)",
      "  --pass <character>       character id for `add --kind review`",
      "  --prompt <text>          runnable prompt for `add` (required for a",
      "                           claude-scheduled-tasks/native task)",
      "  --route <route>          broker route for `add`: local-cascade (daemon) or",
      "                           claude-scheduled-tasks (native). Default: native for",
      "                           a Claude-primary task, else local-cascade (FEA-4048)",
      "",
    ].join("\n")
  );
}

/**
 * Run the CLI for `argv` (the args after `node crewd`). Exported and NOT
 * self-invoked at module scope: importing this module (e.g. a test importing
 * `parseOptions`) must never execute a command against the host's real
 * `process.argv`. The runnable `bin/crewd.mjs` wrapper is the only caller that
 * invokes `main(process.argv.slice(2))`.
 */
export async function main(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
    return;
  }
  const { command, rest, opts } = parsed;
  switch (command) {
    case "list":
      cmdList(opts);
      break;
    case "add":
      // Awaited so the native-schedule reconcile settles before the process can
      // exit — otherwise the writer's fs work (and the owner-marker persist)
      // could be cut off by an early exit.
      await cmdAdd(rest, opts);
      break;
    case "route":
      await cmdRoute(rest, opts);
      break;
    case "remove":
      await cmdRemove(rest, opts);
      break;
    case "enable":
      await cmdEnable(rest, opts, true);
      break;
    case "disable":
      await cmdEnable(rest, opts, false);
      break;
    case "runs":
      cmdRuns(rest, opts);
      break;
    case "start":
      await cmdStart(opts);
      break;
    default:
      cmdHelp();
      break;
  }
}
