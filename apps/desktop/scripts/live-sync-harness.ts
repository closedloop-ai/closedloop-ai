/**
 * @file live-sync-harness.ts
 * @description ISS-9166 (PRD-707 FR4b) — contract layer TWO: drive the desktop's
 * REAL cloud sync lanes, in plain Node, over a real SQLite store, against a real
 * API, until the outboxes drain.
 *
 * WHAT THIS CATCHES THAT LAYER ONE (ISS-9846) CANNOT. The replay layer sends
 * recorded payloads through the real routes, so it pins the payload SHAPE. It
 * never runs the producer: backoff, the durable cursor, dead-lettering, the
 * envelope reserve, compression negotiation, and the composition that wires them
 * are all absent from it. This harness runs exactly those, through the
 * production assembly — `buildDesktopSyncLaneDeps` into `createDesktopSyncLanes`
 * — so a skew introduced in the sync service itself reds here and nowhere else.
 *
 * NO ELECTRON, AND THAT IS THE LOAD-BEARING CLAIM. PRD-707 FR4b rests on it and
 * ISS-9166 asked for it to be PROVED on a real store rather than asserted: no
 * file under `src/main/agent-sync` imports `electron`, and neither does anything
 * the lane composition reaches. This script is that proof — it runs on a Linux
 * runner with no Electron binary present, which is why the harness job is
 * `ubuntu-latest` and not a step of the macOS candidate build (a macOS GitHub
 * runner has no Docker daemon and so cannot host the containerized stack at
 * all).
 *
 * The four Electron-bearing collaborators `desktop-services.ts` passes — the
 * settings store, the session manager, the renderer readiness gates, and the
 * OTel runtime — are supplied here as the narrow structural PORTS
 * `desktop-sync-lane-deps.ts` already declares. Nothing in the lanes is stubbed.
 * The eleven invariants those lanes are held to are `src/main/sync/AGENTS.md`;
 * invariant 9 (no lane's delivery is gated on renderer or window state) is what
 * makes a renderer-free driver a legitimate view of production rather than a
 * special case of it.
 *
 * TELEMETRY IS INERT ON PURPOSE. The harness borrows the canonical inert OTel
 * runtime rather than starting a real SDK, and tees `emitSyncBatchEvent` to tally
 * batches. That tee is the observation seam: it is the production call the lanes
 * already make on every batch, so counting there adds nothing to the hot path and
 * cannot drift from what the lane actually did. The consequence is stated rather
 * than hidden — this lane proves nothing about the OTel exporters.
 *
 * THREE LANES, AND THE VERDICT SAYS SO. The harness drives the session-metadata,
 * invocation-parts and component-inventory lanes, and each of the three has to
 * reach its OWN `drained` verdict before the run is green — the session lane's
 * `caughtUp` is scoped to its own queues and is documented as never a whole-app
 * completeness claim. The transcript-archive lane is NOT driven here (it is
 * composed in the dashboard runtime this script does not stand up), nor is the
 * routine lane (composed, never started here), so they are excluded by name in
 * `HARNESS_DRIVES_LANE` rather than reported as caught up.
 *
 * THE COMPUTE TARGET IS REGISTERED, NOT INVENTED. `POST /compute-targets/register`
 * with the seeded key mints one owned by the org and user that key resolves to,
 * which is the pair `computeTargetsService.findOwnedById` checks on every sync
 * POST. See {@link registerComputeTarget}.
 *
 * TWO PHASES, because the cloud-side counts cannot exist before the drain and
 * the verdict cannot be reached without them:
 *
 *   drain:   --store <dir> --report <file.json> [--budget-ms <n>]
 *   verdict: --verdict --report <file.json> --cloud-counts <file.json>
 *
 * The drain phase writes the report and fails only if it could not run at all;
 * the verdict phase folds in the caller's cloud measurement, rewrites the report
 * and decides. `e2e/run-desktop-sync-harness.sh` runs both with the count step
 * between them. A drain whose verdict phase never runs leaves a report with
 * `cloud: null`, which is a violation and not a pass — see the report module.
 *
 * Environment (the `api-key-store.ts` seam, same names the desktop itself reads):
 *   CL_AUTH_API_ORIGIN   the API origin to sync against
 *   CLOSEDLOOP_API_KEY   an `sk_live_` key; `withAnyAuth` routes it to API-key auth
 *   CL_RELAY_ORIGIN      recorded in the report; the HTTP lanes do not dial it
 */

import { readFile, writeFile } from "node:fs/promises";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { z } from "zod";
import { inProcessAgentSessionPayloadPreparer } from "../src/main/agent-sync/agent-session-payload-preparation.js";
import { NO_AGENT_SESSION_SYNC_CAPABILITIES } from "../src/main/agent-sync/agent-session-sync-capabilities.js";
import { createDesktopSyncLanes } from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import { buildDesktopSyncLaneDeps } from "../src/main/agent-sync/desktop-sync-lane-deps.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import type { SyncBurndownReporter } from "../src/main/sync/sync-burndown-reporter.js";
import { SyncObservabilityTier } from "../src/shared/contracts.js";
import type { SyncBurndownSnapshot } from "../src/shared/sync-burndown-contract.js";
import { inertDesktopOtelRuntime } from "../test/inert-desktop-otel-runtime.js";
import {
  allHarnessLanesDrained,
  collectLiveSyncViolations,
  HARNESS_DRIVES_LANE,
  type LiveSyncCounts,
  type LiveSyncHarnessReport,
  type LiveSyncLaneRemainder,
  type LiveSyncObservations,
  observeGatewayLog,
  tallySyncBatch,
} from "./live-sync-harness-report.js";
import { openRehearsalDb } from "./rehearsal-build-store.js";

/** PRD-707 FR4b / ISS-9166 AC1: the whole drain in at most fifteen minutes. */
const DEFAULT_BUDGET_MS = 15 * 60 * 1000;

/** How long to wait between drain probes. Short: the lanes are event-driven. */
const DRAIN_POLL_INTERVAL_MS = 250;

/**
 * The machine name this run registers its compute target under. Stable rather
 * than per-run: `register` upserts on `(userId, machineName)`, and the stack's
 * database is destroyed by `down -v` between runs anyway.
 */
const HARNESS_MACHINE_NAME = "live-sync-harness";

/** Budget floor and ceiling. The ceiling sits under the harness job's own bound. */
const MIN_BUDGET_MS = 1000;
const MAX_BUDGET_MS = 40 * 60 * 1000;

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required; see this script's header.`);
  }
  return value;
}

/**
 * The drain budget, clamped at both ends.
 *
 * A bare `Number()` here made `--budget-ms` a way to red the lane with a typo:
 * a non-numeric value yields `NaN`, `Date.now() < startedAt + NaN` is false, the
 * loop body never runs once, and the report blames the sync lanes for a bad
 * shell variable. A refused value falls back to the default rather than
 * throwing, because the caller's intent — run the drain — is unambiguous.
 */
function resolveBudgetMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_BUDGET_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[live-sync-harness] ignoring unusable --budget-ms ${JSON.stringify(raw)}; using ${DEFAULT_BUDGET_MS}ms.`
    );
    return DEFAULT_BUDGET_MS;
  }
  return Math.min(Math.max(parsed, MIN_BUDGET_MS), MAX_BUDGET_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The owner identity the store's sessions already carry, read FROM the store.
 *
 * Not the `REHEARSAL_OWNER_*` constants: the lane skips a session whose owner
 * pair does not match the signed-in identity, so a second spelling of those ids
 * here would not fail loudly — it would silently sync nothing and report a
 * drained, empty, green run.
 */
async function readStoreOwnerIdentity(
  db: Awaited<ReturnType<typeof openRehearsalDb>>
): Promise<{ userId: string; organizationId: string }> {
  const rows = await db.prisma.read((reader) =>
    reader.$queryRawUnsafe<{ user_id: string; organization_id: string }[]>(
      "SELECT user_id, organization_id FROM sessions WHERE user_id IS NOT NULL AND organization_id IS NOT NULL LIMIT 1"
    )
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      "no session in the store carries an owner identity, so the lane would treat every row as foreign and sync nothing. Rebuild the store with rehearsal-build-store.ts, which claims one."
    );
  }
  return { userId: row.user_id, organizationId: row.organization_id };
}

/** What the local store holds — the denominator the cloud is compared against. */
async function readCorpusCounts(
  db: Awaited<ReturnType<typeof openRehearsalDb>>
): Promise<LiveSyncCounts> {
  const sessions = await db.sessions.count();
  // A raw count, not a reader-pool model delegate: `session-count.ts` records
  // that a delegate aggregate on the reader pool returns 0 in packaged builds.
  const rows = await db.prisma.read((reader) =>
    reader.$queryRawUnsafe<{ cnt: number | bigint }[]>(
      "SELECT COUNT(*) AS cnt FROM token_events"
    )
  );
  return { sessions, events: Number(rows[0]?.cnt ?? 0) };
}

/**
 * The caller's file is a parse boundary — written by a shell step, from psql
 * output — so its shape is validated rather than asserted. `.int()` on both:
 * a fractional or non-finite count is not a small measurement error, it is a
 * broken count step, and admitting one would put a number in the verdict that
 * no row supports.
 */
const cloudCountsSchema = z.object({
  sessions: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
});

/**
 * What the verdict phase needs the drain phase to have written. Deliberately
 * `.passthrough()`: the verdict rewrites the file with everything it read, so a
 * field a NEWER drain added must survive the round trip rather than be stripped
 * by an older verdict.
 */
const drainReportSchema = z
  .object({
    sessionLaneDrained: z.boolean(),
    durationMs: z.number(),
    budgetMs: z.number(),
    sessionsDelivered: z.number(),
    lanes: z.array(
      z.object({
        lane: z.string(),
        accepted: z.number(),
        rejected: z.number(),
        deferred: z.number(),
        deadLettered: z.number(),
        reasons: z.array(z.string()),
      })
    ),
    deadLetters: z.object({
      sessions: z.number(),
      components: z.number(),
      invocationParts: z.number(),
    }),
    syncFailures: z.array(z.string()),
    rejectedDetails: z.array(z.string()),
    // Required, not optional: this is the whole-run completion evidence, and a
    // verdict that tolerated its absence would pass a report written by a drain
    // that never sampled the lanes at all.
    laneRemainders: z.array(
      z.object({
        lane: z.string(),
        state: z.string(),
        itemsRemaining: z.number().nullable(),
      })
    ),
    corpus: cloudCountsSchema,
  })
  .passthrough();

/**
 * The caller's cloud-side measurement, or `null` when it did not run.
 *
 * Every failure mode here resolves to `null` rather than throwing, because the
 * verdict already treats an unmeasured cloud as a violation and naming it there
 * puts the whole report in front of the operator instead of a stack trace.
 */
async function readCloudCounts(file?: string): Promise<LiveSyncCounts | null> {
  if (!file) {
    return null;
  }
  try {
    const parsed = cloudCountsSchema.safeParse(
      JSON.parse(await readFile(file, "utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The `POST /compute-targets/register` answer, at its parse boundary. */
const registeredTargetSchema = z.object({
  success: z.literal(true),
  data: z.object({ id: z.uuid() }),
});

/**
 * Register a compute target through the API — exactly what the desktop does at
 * startup — and sync under the id the server hands back.
 *
 * NOT a locally-minted UUID (whitlockk review). `requireComputeTargetId` only
 * shape-checks the query parameter, but `desktopAgentSessionsSyncService.sync`
 * then calls `computeTargetsService.findOwnedById`, so an id no row carries is
 * answered 403 `target_not_owned` on every batch: the lane re-resolves its
 * identity instead of retrying, nothing ever lands, and the run reports a budget
 * expiry with no indication why. The id has to be owned by the org and user the
 * SEEDED API KEY resolves to, which is precisely what registering with that key
 * produces — the harness cannot compute that pair locally, only ask for it.
 *
 * Blocking, and loud: a harness with no owned target proves nothing, so this
 * fails before a single lane starts rather than inside the drain loop.
 */
async function registerComputeTarget(
  apiOrigin: string,
  apiKey: string
): Promise<string> {
  const response = await fetch(`${apiOrigin}/compute-targets/register`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      machineName: HARNESS_MACHINE_NAME,
      platform: process.platform,
      supportedOperations: [],
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  const parsed = registeredTargetSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `POST /compute-targets/register answered ${response.status} with a body the harness could not read, ` +
        "so the sync lanes have no owned compute target to send under: " +
        JSON.stringify(body)
    );
  }
  return parsed.data.data.id;
}

/**
 * Take ONE fresh burn-down sample and fold the lanes this harness drives.
 *
 * The snapshot slot is cleared first because `sampleOnce` deliberately swallows
 * a failed store read — a diagnostic must never disturb a lane — so a stale
 * all-zero snapshot from an earlier tick would otherwise be read as this tick's
 * evidence and green the run on a measurement that did not happen.
 */
async function sampleHarnessLaneRemainders(
  reporter: SyncBurndownReporter,
  slot: { snapshot: SyncBurndownSnapshot | null }
): Promise<LiveSyncLaneRemainder[]> {
  slot.snapshot = null;
  await reporter.sampleOnce();
  return harnessLaneRemainders(slot.snapshot);
}

/**
 * Phase two: fold the caller's cloud measurement into the drain's report and
 * decide. Kept in this script rather than a sibling so the report shape has one
 * writer and the verdict one caller.
 */
async function runVerdictPhase(reportFile: string): Promise<void> {
  // The SAME parse boundary the cloud-counts file crosses, and validated the
  // same way: this file was written by a different process, possibly from an
  // older tree. A bare cast let a truncated report reach `collectLiveSyncViolations`
  // and throw `Cannot read properties of undefined` — a stack trace where this
  // module's own doctrine says the operator should get the report.
  const parsed = drainReportSchema.safeParse(
    JSON.parse(await readFile(reportFile, "utf8"))
  );
  if (!parsed.success) {
    throw new Error(
      `${reportFile} is not a drain report this build can read (${parsed.error.issues[0]?.message ?? "unknown"}). The drain phase must run, and finish, before the verdict.`
    );
  }
  const report: LiveSyncHarnessReport = {
    ...(parsed.data as LiveSyncHarnessReport),
    cloud: await readCloudCounts(readFlag("cloud-counts")),
  };
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  reportVerdict(report, reportFile);
}

/** Print the verdict and throw when the run is not clean. */
function reportVerdict(
  report: LiveSyncHarnessReport,
  reportFile: string
): void {
  const violations = collectLiveSyncViolations(report);
  if (violations.length === 0) {
    console.log(
      `[live-sync-harness] drained ${report.sessionsDelivered} session(s) in ${report.durationMs}ms ` +
        "with no rejected batch, dead letter or failed tick"
    );
    return;
  }
  for (const violation of violations) {
    console.error(`::error::[live-sync-harness] ${violation}`);
  }
  throw new Error(
    `${violations.length} live-sync violation(s); see ${reportFile}.`
  );
}

async function main(): Promise<void> {
  const reportFile = readFlag("report");
  if (!reportFile) {
    throw new Error(
      "usage: tsx scripts/live-sync-harness.ts --store <dir> --report <file.json> [--budget-ms <n>]\n" +
        "   or: tsx scripts/live-sync-harness.ts --verdict --report <file.json> --cloud-counts <file.json>"
    );
  }
  if (process.argv.includes("--verdict")) {
    await runVerdictPhase(reportFile);
    return;
  }
  const storeDir = readFlag("store");
  if (!storeDir) {
    throw new Error("--store <dir> is required for the drain phase.");
  }
  const budgetMs = resolveBudgetMs(readFlag("budget-ms"));
  const apiOrigin = requireEnv("CL_AUTH_API_ORIGIN");
  const apiKey = requireEnv("CLOSEDLOOP_API_KEY");
  const relayOrigin = process.env.CL_RELAY_ORIGIN?.trim() ?? null;
  const log = (message: string) =>
    console.log(`[live-sync-harness] ${message}`);
  log(
    `api=${apiOrigin} relay=${relayOrigin ?? "(unset)"} budget=${budgetMs}ms`
  );

  const observations: LiveSyncObservations = {
    lanes: new Map(),
    syncFailures: [],
    rejectedDetails: [],
  };
  const stopObservingLog = observeGatewayLog(gatewayLog, observations);

  const db = await openRehearsalDb(storeDir);
  const startedAt = Date.now();
  let sessionLaneDrained = false;
  let sessionsDelivered = 0;
  let deadLetters = { sessions: 0, components: 0, invocationParts: 0 };
  let corpus: LiveSyncCounts = { sessions: 0, events: 0 };
  let laneRemainders: LiveSyncLaneRemainder[] = [];
  const burndown: { snapshot: SyncBurndownSnapshot | null } = {
    snapshot: null,
  };
  // DECLARED OUTSIDE THE TRY so the `finally` can stop them. Scoped inside it,
  // a throw anywhere after `start()` left both services holding live timers
  // while `main().catch` only set `process.exitCode` — Node then stays alive on
  // those handles and the step wedges until the job's own timeout, with no
  // report written. A fast red became a silent 45-minute hang.
  let lanes: ReturnType<typeof createDesktopSyncLanes> | null = null;

  try {
    const identity = await readStoreOwnerIdentity(db);
    corpus = await readCorpusCounts(db);
    log(
      `store: ${corpus.sessions} session(s), ${corpus.events} token event(s), owner org ${identity.organizationId}`
    );

    const computeTargetId = await registerComputeTarget(apiOrigin, apiKey);
    log(`registered compute target ${computeTargetId}`);
    const otel = inertDesktopOtelRuntime({
      onSyncBatch: (input) => tallySyncBatch(observations, input),
    });

    lanes = createDesktopSyncLanes(
      buildDesktopSyncLaneDeps({
        desktopSessionManager: {
          // `withAnyAuth` routes a `Bearer sk_live_*` to API-key auth, so the
          // seeded key stands in for the first-party Desktop session token
          // without the harness needing a Clerk sign-in.
          getAccessToken: () => Promise.resolve(apiKey),
          // Authenticated for the whole run under one key, so one account
          // generation, as `DesktopSessionManager.getAccountAdmission` reports it.
          getAccountAdmission: () => ({ ...identity, generation: 0 }),
          getIdentity: () => identity,
          invalidateAccessToken: () => undefined,
        },
        settings: {
          getApiOrigin: () => apiOrigin,
          hasSyncObservabilityTierBeenSet: () => true,
          getDataSyncLevel: () => DataSyncLevel.Full,
          getSyncConsentRecord: () => ({
            tier: SyncObservabilityTier.Full,
            organizationId: identity.organizationId,
            bound: true,
          }),
        },
        sessionSyncIdentity: {
          computeTargetId: () => computeTargetId,
          // The registered id above is the only one this run ever answers.
          lastLiveTargetRefusal: () => null,
          isHttpReady: () => true,
        },
        syncEgressGate: {
          sessionMetadataAllowed: () => true,
        },
        rendererGates: {
          // Resolves immediately, which is the harness running WITHOUT the
          // renderer rather than the harness defeating a gate: `src/main/sync`
          // invariant 9 is that no lane's delivery may be gated on renderer or
          // window state, so a lane that needed this to block would already be
          // in violation. The cost is stated rather than implied — this lane
          // exercises no PACING, so it cannot show that the production slot
          // yields to the renderer as intended.
          waitForRendererBackgroundSlot: () => Promise.resolve(),
        },
        appOtelRuntime: otel,
        getApiKey: () => apiKey,
        // The compose'd API advertises its capabilities over the relay hello,
        // which this harness does not dial. Starting from none is the
        // conservative choice: every capability-gated payload shape degrades to
        // the one an older server accepts, so a green here is a green for the
        // narrowest wire contract rather than the widest.
        getServerCapabilities: () => NO_AGENT_SESSION_SYNC_CAPABILITIES,
        getTranscriptComputeTargetId: () => computeTargetId,
        // ISS-12097: `rehearsal-build-store.ts` runs the import and its backfills
        // to completion and closes the store before this opens it, so no
        // initial projection is pending; `false` would hold the session and
        // invocation lanes forever.
        getDashboardRuntime: () => ({
          syncSource: db.syncSource,
          isInitialSessionProjectionReady: () => true,
        }),
        getTranscriptSync: () => null,
        // tsx resolves a Worker entry as the `.js` the source names, which does
        // not exist before a build, so the worker preparer cannot start under
        // this runner. The in-process preparer is the same code path the service
        // itself falls back to; the worker hop is covered by the node suite and
        // deliberately NOT claimed by this lane.
        preparePayloads: inProcessAgentSessionPayloadPreparer,
        // The all-lanes remainder, teed off the production burn-down sampler so
        // every lane's `sourceKey` is derived in exactly one place. What the
        // drain loop reads it for is below.
        onSyncBurndownSample: (snapshot) => {
          burndown.snapshot = snapshot;
        },
      })
    );

    lanes.agentSessionSync.start();
    lanes.agentComponentInvocationSync.start();

    const deadline = startedAt + budgetMs;
    while (Date.now() < deadline) {
      lanes.agentSessionSync.refresh();
      await lanes.agentSessionSync.whenSessionSyncSettled();
      await lanes.agentSessionSync.whenComponentSyncSettled();
      await lanes.agentComponentInvocationSync.syncOnce();

      const progress = lanes.agentSessionSync.getSyncProgress();
      sessionsDelivered = progress.deliveredSessions ?? sessionsDelivered;
      deadLetters = {
        sessions: progress.deadLetteredSessions,
        components: progress.deadLetteredComponents,
        // ISS-5347: the invocation lane's own counter. The two above come from
        // `sync_state.dead_lettered_ids`, which that ticket records as never
        // covering this lane — so reading only them reported a lane that had
        // abandoned rows as clean.
        invocationParts:
          lanes.agentComponentInvocationSync.deadLetteredPartCount,
      };
      // The session lane's own queues gate the (much heavier) all-lanes read:
      // `caughtUp` is a PER-LANE signal and is documented as never a whole-app
      // completeness claim, so it is a cheap in-memory "is it worth asking?"
      // and never the answer. The answer is the burn-down sample below, which
      // holds the invocation-parts and component-inventory queues to their own
      // `drained` verdict — without it this loop stops both lanes the moment the
      // session lane settles, with parts still owed and nothing saying so.
      if (
        progress.caughtUp &&
        progress.pendingBackfillSessions === 0 &&
        progress.pendingIncrementalSessions === 0
      ) {
        sessionLaneDrained = true;
        laneRemainders = await sampleHarnessLaneRemainders(
          lanes.syncBurndownReporter,
          burndown
        );
        if (allHarnessLanesDrained(laneRemainders)) {
          break;
        }
      }
      await sleep(DRAIN_POLL_INTERVAL_MS);
    }

    if (!allHarnessLanesDrained(laneRemainders)) {
      // One last sample so the report can NAME the lane that still owes work
      // rather than reporting only that the budget expired. Best-effort: a
      // sample that cannot complete leaves the remainders empty, which the
      // verdict reports as unmeasured rather than as drained.
      laneRemainders = await sampleHarnessLaneRemainders(
        lanes.syncBurndownReporter,
        burndown
      );
    }
  } finally {
    lanes?.agentSessionSync.stop();
    lanes?.agentComponentInvocationSync.stop();
    await db.close().catch(() => undefined);
    stopObservingLog();
  }

  const report: LiveSyncHarnessReport = {
    sessionLaneDrained,
    durationMs: Date.now() - startedAt,
    budgetMs,
    sessionsDelivered,
    lanes: [...observations.lanes.values()],
    deadLetters,
    syncFailures: observations.syncFailures,
    rejectedDetails: observations.rejectedDetails,
    laneRemainders,
    corpus,
    // Filled by the verdict phase; `null` here is "not measured yet", which the
    // verdict treats as a violation if that phase never runs.
    cloud: null,
  };
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(
    `drain finished: sessionLaneDrained=${report.sessionLaneDrained} ` +
      `delivered=${report.sessionsDelivered} in ${report.durationMs}ms; ` +
      `report written to ${reportFile}`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

/**
 * The fold over one burn-down sample. A parameter rather than an inline read of
 * the slot: `sampleOnce` fills the slot through `onSyncBurndownSample`, which
 * tsc cannot see, so it keeps the `slot.snapshot = null` narrowing across the
 * `await` and types the inline read as `never`.
 */
function harnessLaneRemainders(
  snapshot: SyncBurndownSnapshot | null
): LiveSyncLaneRemainder[] {
  return (snapshot?.lanes ?? [])
    .filter((lane) => HARNESS_DRIVES_LANE[lane.lane])
    .map((lane) => ({
      lane: lane.lane,
      state: lane.state,
      itemsRemaining: lane.itemsRemaining,
    }));
}
