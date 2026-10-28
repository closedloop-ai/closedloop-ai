import { randomBytes } from "node:crypto";
import { log } from "@repo/observability/log";

/**
 * ISS-8152 — a local-development scheduler for the GitHub sync crons.
 *
 * `apps/api/vercel.json`'s crons fire only in a Vercel deployment, so nothing
 * drives `/cron/bootstrap-repo-sync-states`, `/cron/reconcile-pull-requests`,
 * or `/cron/refresh-branch-analytics-rollups` in a local stack. Every local
 * environment therefore lacks steady-state Branches maintenance work, which is
 * what made the 2026-08-25 investigation read as total product darkness and
 * would silently invalidate any future local QA of the Branches surfaces.
 *
 * ## Why it calls the routes over loopback rather than the services directly
 *
 * The services are importable (`post-connect-sync-service.ts` already calls one
 * outside its route), and doing that would skip both the HTTP layer and
 * `validateCronSecret`. But the entrypoint that runs in production is the
 * ROUTE, and the whole point of this module is that a green local run must mean
 * the shipped path works — a local stack that exercises only the service would
 * be a second way to be falsely reassured, which is the defect this fixes, not
 * a fix for it. Going over loopback also decouples this file from the service
 * singletons while PRD-683 Phase 0 reshapes them.
 *
 * ## Why the guard is three conditions and not one
 *
 * The FIRST line of defense is not in this file: `server-dev.ts` is the only
 * entrypoint that imports this module, so the production command cannot reach
 * it at all (`lib/__tests__/dev-cron-production-exclusion.test.ts` holds that).
 * These three conditions are the second line, and they defend a different case
 * — a developer's own non-production process pointed somewhere it should not
 * write. So: an explicit opt-in, a non-production runtime, AND a database that
 * is demonstrably local. Every one of them fails closed.
 *
 * ## What the guard does NOT bound
 *
 * It bounds the DATABASE. It says nothing about which GitHub credentials the
 * ticks spend, and those are the genuinely shared resource: the sweeps draw on
 * the App installation / user tokens configured in `local.env`, at a cadence
 * several times production's. The 50% reserve floor in
 * `github-sync-client-pool.ts` is computed from `observedRemaining` in
 * WHICHEVER database the process is attached to, so spend recorded locally is
 * invisible to production's floor — it keeps believing it has headroom and
 * meets real 429s instead of deferring cleanly (#6048 review). Point this at a
 * development GitHub App, not a shared one.
 */

/** The opt-in. Absent or anything other than `"1"` leaves the scheduler off. */
export const DEV_CRON_ENABLE_ENV_VAR = "CL_DEV_CRON";
const DEV_CRON_ENABLE_VALUE = "1";

const DEV_CRON_LOG_PREFIX = "[dev-cron]";

/**
 * Hostnames that count as "this machine". A `DATABASE_URL` pointing anywhere
 * else — most realistically a developer who repointed their stack at stage to
 * debug something — must not get a second writer racing that environment's own
 * cron on rows PRD-683 Phase 0 is actively reshaping.
 *
 * Compared AFTER `unbracket`, so one entry serves both spellings this check
 * sees: `URL.hostname` returns the IPv6 loopback bracketed (`[::1]`), while the
 * `host` connection parameter below carries it bare. Listing both forms instead
 * would leave one of them permanently unmatched (tamsinb, #6048).
 */
const LOCAL_DATABASE_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * A Unix-socket `host`, which is machine-local by construction — there is no
 * network peer a socket path could reach.
 */
const UNIX_SOCKET_HOST_PREFIX = "/";

/** IPv6 literals arrive bracketed from `URL.hostname` and bare from `?host=`. */
function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Why the scheduler declined to start, for the log line and for tests. */
export const DevCronDisabledReason = {
  NotOptedIn: "not-opted-in",
  ProductionRuntime: "production-runtime",
  NonLocalDatabase: "non-local-database",
} as const;
export type DevCronDisabledReason =
  (typeof DevCronDisabledReason)[keyof typeof DevCronDisabledReason];

export type DevCronJob = {
  /** Route path, appended to the loopback origin. */
  readonly path: string;
  /** Development cadence in milliseconds. */
  readonly intervalMs: number;
  /** Human-readable development cadence, for the banner and each tick line. */
  readonly cadenceLabel: string;
  /** The `vercel.json` schedule, so no log line states a cadence unqualified. */
  readonly productionCadenceLabel: string;
  /**
   * Whether the job runs once immediately at boot rather than waiting out its
   * first interval.
   */
  readonly runAtBoot: boolean;
};

/**
 * The jobs, as data rather than two call sites.
 *
 * A table because PRD-683 Phase 0 is rewriting what these crons do — ISS-8147
 * replaces the tier-2 fetch model and the PRD retires the sweep down to a
 * tier-1 failsafe — so which paths belong here is expected to change, and it
 * should change by editing a row.
 *
 * ORDER IS LOAD-BEARING. `selectDueRepos` reads `gitHubRepoSyncState`, and the
 * bootstrap job is what creates those rows, so a first tick that reconciled
 * before bootstrapping would sweep an empty set and read as a broken scheduler.
 *
 * Only ONE job runs at boot, because `server:dev` is `tsx watch` and every file
 * save restarts the process and re-fires that run. Bootstrap is the one chosen
 * so a fresh stack has sync-state rows before the first reconcile — NOT because
 * it is cheap. It is not: `bootstrap-repo-sync-states` runs
 * `runObservedRepositoryVerification` first, which draws on the same credential
 * pool a reconcile sweep does (#6048 review corrected an earlier claim here).
 * The per-restart cost is bounded per tick but repeats on every save, which is
 * the strongest argument for pointing this at a development GitHub App.
 */
export const DEV_CRON_JOBS: readonly DevCronJob[] = [
  {
    path: "/cron/bootstrap-repo-sync-states",
    intervalMs: 5 * 60 * 1000,
    cadenceLabel: "5m",
    productionCadenceLabel: "hourly",
    runAtBoot: true,
  },
  {
    path: "/cron/reconcile-pull-requests",
    intervalMs: 2 * 60 * 1000,
    cadenceLabel: "2m",
    productionCadenceLabel: "*/15m",
    runAtBoot: false,
  },
  {
    path: "/cron/refresh-branch-analytics-rollups",
    intervalMs: 5 * 60 * 1000,
    cadenceLabel: "5m",
    productionCadenceLabel: "*/5m",
    runAtBoot: false,
  },
];

export type DevCronPlan =
  | { readonly enabled: false; readonly reason: DevCronDisabledReason }
  | { readonly enabled: true; readonly databaseHost: string };

/**
 * Whether `DATABASE_URL` names a database on this machine.
 *
 * Fails closed on an absent or unparseable value: "cannot tell" is not "local".
 * `scripts/setup-local-env.sh` makes the same call with a regex, but only on
 * the `--print-database-url` path that `just setup` / `just migrate` use — the
 * dev server itself reads whatever `local.env` holds, which is the gap this
 * closes. Parsing rather than pattern-matching so a password containing an `@`
 * cannot read as a remote host.
 *
 * ## The authority is not the connection target
 *
 * libpq — and `pg-connection-string`, which is what actually resolves this URL —
 * lets a `host` CONNECTION PARAMETER override the authority, so
 * `postgres://user@localhost/cl?host=db.stage.example.com` connects to stage
 * while reading as local. Verified against the installed parser: it reports
 * `stage.example.com` for exactly that string (whitlockk, #6048). The parameter is
 * therefore what gets judged whenever it is present.
 *
 * EVERY occurrence of it, and every comma-separated entry within each. Two
 * subtleties, both verified against the installed `pg-connection-string@2.12.0`
 * rather than assumed:
 *
 *  - The parameter may REPEAT, and the parser assigns in iteration order, so the
 *    LAST occurrence wins. Reading only the first (`searchParams.get`) made
 *    `?host=localhost&host=db.stage.example.com` read as local while the driver
 *    connected to stage — the guard failing OPEN, which is the one direction it
 *    must never fail (#6048 review).
 *  - libpq accepts a comma-separated failover list, and one remote entry in it
 *    is enough to write to that remote.
 *
 * So the rule is: collect every target, and refuse unless all of them are local.
 */
function resolveLocalDatabaseHost(
  databaseUrl: string | undefined
): string | null {
  if (!databaseUrl) {
    return null;
  }
  try {
    const parsed = new URL(databaseUrl);
    const [first, ...rest] = parsed.searchParams
      .getAll("host")
      .flatMap((value) => value.split(","));
    if (first === undefined) {
      return isLocalHost(parsed.hostname) ? unbracket(parsed.hostname) : null;
    }
    if (!(isLocalHost(first) && rest.every(isLocalHost))) {
      return null;
    }
    return unbracket(first);
  } catch {
    return null;
  }
}

/**
 * Whether one connection target names this machine.
 *
 * Case-folded because `postgres:` is not a WHATWG "special" scheme, so
 * `URL.hostname` does NOT lowercase it — `postgresql://…@LOCALHOST/cl` reports
 * `LOCALHOST` verbatim. That refusal was safe (it fails closed) but it refused a
 * genuinely local database, and the natural next move for whoever hits it is to
 * loosen the guard.
 */
function isLocalHost(host: string): boolean {
  if (host.startsWith(UNIX_SOCKET_HOST_PREFIX)) {
    return true;
  }
  return LOCAL_DATABASE_HOSTNAMES.has(unbracket(host).toLowerCase());
}

/**
 * Resolve whether the scheduler may run, from an environment alone.
 *
 * Pure and separately exported so the guard can be tested by EXECUTING the
 * decision against synthetic environments rather than by asserting that a
 * condition appears in this file.
 */
export function resolveDevCronPlan(
  env: NodeJS.ProcessEnv = process.env
): DevCronPlan {
  if (env[DEV_CRON_ENABLE_ENV_VAR] !== DEV_CRON_ENABLE_VALUE) {
    return { enabled: false, reason: DevCronDisabledReason.NotOptedIn };
  }
  if (env.NODE_ENV === "production") {
    return { enabled: false, reason: DevCronDisabledReason.ProductionRuntime };
  }
  const databaseHost = resolveLocalDatabaseHost(env.DATABASE_URL);
  if (databaseHost === null) {
    return { enabled: false, reason: DevCronDisabledReason.NonLocalDatabase };
  }
  return { enabled: true, databaseHost };
}

/**
 * The bearer the loopback calls present, minting one when the environment has
 * none.
 *
 * `CRON_SECRET` is deliberately unset locally (`local.env.example` lists it
 * under cloud-only), and `validateCronSecret` answers a missing secret with a
 * 500 — so the routes 500 on every local stack today, manual `curl` included.
 * Minting into `process.env` works because this process also hosts the Next
 * handler, and the route reads the variable per request rather than at module
 * load. An operator-supplied value always wins, so a developer who has one
 * configured keeps it.
 *
 * The value is never logged.
 */
function resolveCronSecret(): string {
  const existing = process.env.CRON_SECRET;
  if (existing) {
    return existing;
  }
  const minted = randomBytes(32).toString("hex");
  process.env.CRON_SECRET = minted;
  return minted;
}

export type DevCronSchedulerHandle = {
  /** Cancel every armed timer. Idempotent. */
  stop: () => void;
};

/**
 * What the server is actually listening on — `Server.address()`, verbatim.
 *
 * A `string` is a Unix socket or named pipe, and `null` means the server is not
 * listening; neither yields an origin this can call, so both fall back to IPv4
 * loopback on `fallbackPort`.
 */
export type DevCronListenAddress =
  | { readonly address: string; readonly port: number; readonly family: string }
  | string
  | null;

type StartDevCronSchedulerOptions = {
  /** `server.address()` after `listen`. */
  readonly address: DevCronListenAddress;
  /** Used only when `address` cannot supply one. */
  readonly fallbackPort: number;
  /** Overridable for tests. */
  readonly jobs?: readonly DevCronJob[];
  /** Overridable for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Overridable for tests; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
};

/**
 * The origin the loopback calls target, derived from the bound address rather
 * than assumed.
 *
 * `server.ts` binds `process.env.HOST ?? "0.0.0.0"`, so a developer who pins
 * `HOST` to a non-wildcard address had every tick refused by a hardcoded
 * `127.0.0.1` while the server was up and healthy (davetho, #6048).
 *
 * A wildcard bind is the one case that still has to be translated: `0.0.0.0`
 * and `::` are not addresses anything can connect TO, so they resolve to the
 * loopback of their own family. IPv6 literals are re-bracketed for the URL.
 */
export function resolveLoopbackOrigin(
  address: DevCronListenAddress,
  fallbackPort: number
): string {
  if (address === null || typeof address === "string") {
    return `http://127.0.0.1:${fallbackPort}`;
  }
  const isIpv6 = address.family === "IPv6" || address.address.includes(":");
  if (!isIpv6) {
    const host = address.address === "0.0.0.0" ? "127.0.0.1" : address.address;
    return `http://${host}:${address.port}`;
  }
  const bare = unbracket(address.address);
  const host = bare === "::" ? "::1" : bare;
  return `http://[${host}]:${address.port}`;
}

/**
 * Start the scheduler if this environment allows it.
 *
 * Returns a handle in every case — a disabled run yields a no-op `stop`, so no
 * caller needs a null check.
 */
export function startDevCronScheduler(
  options: StartDevCronSchedulerOptions
): DevCronSchedulerHandle {
  const env = options.env ?? process.env;
  const plan = resolveDevCronPlan(env);
  if (!plan.enabled) {
    logDisabled(plan.reason);
    return { stop: noop };
  }
  const jobs = options.jobs ?? DEV_CRON_JOBS;
  const runner = createJobRunner({
    fetchImpl: options.fetchImpl ?? fetch,
    origin: resolveLoopbackOrigin(options.address, options.fallbackPort),
  });
  logEnabled(jobs, plan.databaseHost);
  return armJobs(jobs, runner);
}

function noop(): void {
  // Nothing to cancel.
}

/**
 * Say why, but only to someone who asked.
 *
 * Not opting in is the overwhelmingly common case — every production container
 * boot, every developer who never turned this on — and it needs no explanation,
 * so it stays silent rather than putting a "dev-cron disabled" line in
 * production logs forever. The other two reasons mean an operator DID ask and
 * did not get it, which is a warning: a refusal nobody can see is
 * indistinguishable from a scheduler that ran and found nothing to do.
 */
function logDisabled(reason: DevCronDisabledReason): void {
  if (reason === DevCronDisabledReason.NotOptedIn) {
    return;
  }
  log.warn(`${DEV_CRON_LOG_PREFIX} refused to start`, { reason });
}

/**
 * The banner. It names the production cadence beside the development one on
 * purpose: this scheduler's own hazard is the inverse of the bug it fixes — a
 * developer signing off "PR data shows up promptly" against a cadence several
 * times faster than the quarter-hourly one that has to meet PRD-683's
 * 15-minute bar.
 */
function logEnabled(jobs: readonly DevCronJob[], databaseHost: string): void {
  const schedule = jobs
    .map(
      (job) =>
        `${job.path} every ${job.cadenceLabel} (prod: ${job.productionCadenceLabel})`
    )
    .join(", ");
  log.info(
    `${DEV_CRON_LOG_PREFIX} ENABLED — DEV CADENCE, NOT PROD. ${schedule}. Database: ${databaseHost}.`
  );
}

type JobRunner = (job: DevCronJob) => Promise<void>;

/**
 * The ceiling on one tick, matching the `maxDuration = 300` these routes declare.
 *
 * Load-bearing for LIVENESS, not just tidiness. The re-arm below fires from
 * `finally`, which is what makes non-overlap structural — but it also means a
 * tick that never settles stops that job permanently, and the local `node:http`
 * server enforces none of Vercel's `maxDuration`, so nothing else would ever
 * end it (davetho, #6048). The signal covers the body read as well as the
 * request: aborting a fetch tears down its response stream too.
 */
export const TICK_TIMEOUT_MS = 300_000;

/**
 * One tick: call the route over loopback and report what it said.
 *
 * Never rejects. A tick that throws would kill the re-arm below and stop the
 * scheduler silently, which is the failure mode this whole module exists to
 * remove.
 */
function createJobRunner({
  fetchImpl,
  origin,
}: {
  fetchImpl: typeof fetch;
  origin: string;
}): JobRunner {
  return async (job: DevCronJob) => {
    const cadence = `every ${job.cadenceLabel} — DEV CADENCE, NOT PROD`;
    try {
      const response = await fetchImpl(`${origin}${job.path}`, {
        headers: { authorization: `Bearer ${resolveCronSecret()}` },
        signal: AbortSignal.timeout(TICK_TIMEOUT_MS),
      });
      const body = summarizeBody(await response.text());
      if (response.ok) {
        log.info(`${DEV_CRON_LOG_PREFIX} ${job.path} (${cadence}) — ${body}`);
        return;
      }
      log.warn(
        `${DEV_CRON_LOG_PREFIX} ${job.path} (${cadence}) — HTTP ${response.status}: ${body}`,
        { remedy: remedyForStatus(response.status, body) }
      );
    } catch (error) {
      // `parseError` is not used here: this runs outside a request and the
      // interesting case is a connection refused during `tsx watch` restart,
      // where the message alone is the whole signal.
      log.warn(
        `${DEV_CRON_LOG_PREFIX} ${job.path} (${cadence}) — request failed`,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  };
}

/** The exact body `validateCronSecret` returns when `CRON_SECRET` is unset. */
const MISSING_CRON_SECRET_BODY = "Internal Server Error";

/**
 * A cap on the body interpolated into a log line.
 *
 * The cron routes answer with one short summary line, but a 404 or an unhandled
 * Next error answers with an HTML document, and dumping that into the console
 * every tick buries the `remedy` that makes the failure diagnosable.
 */
const LOGGED_BODY_MAX_CHARS = 200;

function summarizeBody(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > LOGGED_BODY_MAX_CHARS
    ? `${trimmed.slice(0, LOGGED_BODY_MAX_CHARS)}…`
    : trimmed;
}

/**
 * What to try, when the failure is configuration rather than a bug.
 *
 * Matched on the BODY, not the status alone. Every unhandled exception in these
 * routes is also a 500, and telling someone to go set `CRON_SECRET` when the
 * real cause was a service throwing sends them somewhere useless — so the
 * missing-secret remedy is offered only for the one body
 * `validateCronSecret` produces for that case (#6048 review).
 *
 * There is deliberately no 401 remedy. A 401 would mean the header and the
 * route disagreed about the secret, which the per-tick read above already makes
 * impossible within one process — the earlier "restart the API" advice
 * described a failure this design cannot produce, and would not have fixed a
 * real 401 anyway.
 */
function remedyForStatus(status: number, body: string): string | undefined {
  if (status === 500 && body.startsWith(MISSING_CRON_SECRET_BODY)) {
    return `Set CRON_SECRET in local.env — the value ${DEV_CRON_LOG_PREFIX} minted did not reach the route.`;
  }
  if (status === 404) {
    return "The route moved or was retired; update DEV_CRON_JOBS.";
  }
  return undefined;
}

/**
 * Arm every job on its own re-arming timer.
 *
 * A re-arming `setTimeout` rather than `setInterval`, and the next tick is
 * armed only after the previous one SETTLES: these routes declare
 * `maxDuration = 300`, so an interval shorter than a slow sweep would stack
 * concurrent sweeps against the same credential pool. Non-overlap is
 * structural here rather than a property that happens to hold.
 *
 * Every TIMER is unref'd, so a waiting job cannot hold the process open past a
 * Ctrl-C or a `tsx watch` restart. `stop()` does not abort a request already in
 * flight — its socket keeps the loop alive until the tick settles or
 * `TICK_TIMEOUT_MS` fires. Both of the cases named above signal-terminate, so
 * neither waits on it; a caller relying on natural event-loop drain would.
 */
function armJobs(
  jobs: readonly DevCronJob[],
  runner: JobRunner
): DevCronSchedulerHandle {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  const arm = (job: DevCronJob, delayMs: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      runner(job)
        .catch(noop)
        .finally(() => {
          if (!stopped) {
            arm(job, job.intervalMs);
          }
        });
    }, delayMs);
    timer.unref?.();
    timers.add(timer);
  };

  for (const job of jobs) {
    arm(job, job.runAtBoot ? 0 : job.intervalMs);
  }

  return {
    stop: () => {
      stopped = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}
