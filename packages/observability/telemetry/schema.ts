import { DESKTOP_BUILD_COMMIT_PATTERN } from "@repo/api/src/types/desktop-build-commit";
import { invocationSyncMissingParentsSchema } from "@repo/api/src/types/invocation-sync-diagnostics";
import { z } from "zod";
import { COLLECTOR_RECORDS_DROPPED_REASON } from "./collector-records-dropped-reason";
import { dbHostReplyRejectedDiagnosticsSchema } from "./db-host-reply-rejection-reason";
import { dbHostTelemetryRefusedDiagnosticsSchema } from "./db-host-telemetry-refusal-reason";
import { decisionTableVerificationDiagnosticsSchema } from "./decision-table-verification";
import {
  desktopShutdownDiagnosticsSchema,
  desktopUpdateDiagnosticsSchema,
  supportUploadDiagnosticsSchema,
} from "./desktop-lifecycle-triggers";
import { harnessResultEnvelopesDroppedDiagnosticsSchema } from "./harness-result-envelope-drop-reason";
import { LOCAL_READ_FAILED_READ } from "./local-read-failed-read";
import { outboundNetworkDiagnosticsSchema } from "./outbound-network";
import { RENDERER_LOAD_FAILURE_SOURCE } from "./renderer-load-failure-source";
import {
  MIGRATION_STEP_OUTCOME,
  SQL_STATEMENT_FAMILIES,
  SQL_STATEMENT_FAMILY,
  STORE_INTEGRITY_CHECK_NAME,
  STORE_INTEGRITY_CHECKS_RUN,
  STORE_INTEGRITY_ISSUE_CATEGORY,
  storageExhaustedObjectIsBounded,
} from "./store-integrity";
import { tolerantDesktopTelemetryValue } from "./tolerant-desktop-value";

// ---------------------------------------------------------------------------
// ErrorClass
// ---------------------------------------------------------------------------

export const ErrorClass = {
  Connection: "connection",
  Protocol: "protocol",
  Approval: "approval",
  Sandbox: "sandbox",
  Execution: "execution",
  Deployment: "deployment",
} as const;

export type ErrorClass = (typeof ErrorClass)[keyof typeof ErrorClass];

// ---------------------------------------------------------------------------
// TelemetryTraceContext — shared trace fields (no PII: no machineName, no userId)
// ---------------------------------------------------------------------------

// gatewaySessionId is hashed (redactGatewaySessionId) before it reaches any
// log/telemetry sink, so the validated/emitted value is either a raw uuid or the
// 12-char hex redaction hash. This regex mirrors SHORT_HASH_PATTERN in
// ../redact-correlation, inlined here so this schema module stays free of
// node:crypto (and thus safe to import from any runtime).
const REDACTED_GATEWAY_SESSION_ID_RE = /^[0-9a-f]{12}$/;
const gatewaySessionIdSchema = z.union([
  z.uuid(),
  z.string().regex(REDACTED_GATEWAY_SESSION_ID_RE),
]);

// desktopBuildCommit crosses a TRUST boundary: an authenticated client puts the
// value here and it becomes a Datadog trace dimension, so an unvalidated string
// is both a wrong-attribution and an unbounded-cardinality hazard. The pattern
// is the producer's own, imported rather than restated, so the resolver in
// apps/desktop/src/main/util/desktop-build-commit.ts and this boundary cannot
// disagree about what a commit is.
//
// `.catch(undefined)` is what makes tightening a shipped wire field safe. Every
// installed desktop vintage is already sending this key; a bare `.regex()`
// would make one bad value reject the WHOLE event, silently dropping the unit
// and re-dropping it on every retry. Instead the single dimension is discarded
// and the rest of the span still records.
const desktopBuildCommitSchema = z
  .string()
  .regex(DESKTOP_BUILD_COMMIT_PATTERN)
  .optional()
  .catch(undefined);

export const telemetryTraceContextSchema = z.object({
  commandId: z.string(),
  operationId: z.string(),
  computeTargetId: z.string(),
  gatewaySessionId: gatewaySessionIdSchema,
  loopSessionId: z.uuid().optional(),
  loopId: z.string().optional(),
  jobId: z.string().optional(),
  requestId: z.string().optional(),
  environment: z.string().optional(),
  serverVersion: z.string().optional(),
  pluginVersion: z.string().optional(),
  schemaVersion: z.string(),
  desktopClientVersion: z.string().optional(),
  desktopBuildCommit: desktopBuildCommitSchema,
  gatewayProtocolVersion: z.string().optional(),
});

export type TelemetryTraceContext = z.infer<typeof telemetryTraceContextSchema>;

// ---------------------------------------------------------------------------
// TelemetryDiagnostics
// ---------------------------------------------------------------------------

// Desktop wire format — must not include server-only protocol fields.
// Desktop-originated telemetry is parsed against this schema; any server-only
// field (e.g. ackLatencyMs) carried in a desktop payload is stripped by Zod's
// default `.strip` behavior before reaching the log emitter.

// ---------------------------------------------------------------------------
// LoopPerfEventDiagnostics — permissive passthrough for loop.perf.* categories
// ---------------------------------------------------------------------------
// The relay forwards `loopPerf` payloads to Datadog opaquely so version skew
// between desktop producers and the relay never drops observability data
// (PRD-254 §FR-6 fail-open, producer-additivity rollout property). Field-level
// validation is owned by the producer schema in apps/desktop.
//
// `event` is `.optional()` so missing-discriminator payloads also fail open
// rather than tripping envelope-level validation.
//
// Producer-side wire-format invariants (informational; not enforced here):
// - Optional fields are absent (omitted), not `null`. Exception: `tool` events
//   may carry `endedAt`/`durationS`/`ok` as `null` as the in-flight sentinel
//   for orphan-tool reconciliation at end-of-loop.
// - `pipeline_step.step` is a number, not an integer (producer emits 8.5 for
//   the synthetic `write_merged_patterns` step).

export const loopPerfEventDiagnosticsSchema = z
  .object({ event: z.string().optional() })
  .passthrough();

export type LoopPerfEventDiagnostics = z.infer<
  typeof loopPerfEventDiagnosticsSchema
>;

// ---------------------------------------------------------------------------
// LifecycleDiagnostics — permissive passthrough for job.* lifecycle attribution
// ---------------------------------------------------------------------------
// Accepts `diagnostics.lifecycle.command` from desktop producers on `job.*`
// events. Any string is accepted via `.passthrough()` to preserve producer-additivity across
// version skew (AC-002, AC-003). Field-level validation of canonical values is
// owned by the producer schema in apps/desktop.
//
// `command` is `.optional()` so payloads without the field also validate
// (back-compat, AC-001). Unknown sibling fields under `lifecycle` survive
// parsing and reach Datadog via `.passthrough()` (AC-003).

/**
 * ISS-7401 — the sentinel both stall vocabularies below coarsen an unrecognised
 * wire string onto. Named once so the two cannot drift apart, and so a dashboard
 * has ONE bucket meaning "a build newer than this server named something we do
 * not have a word for".
 */
const SYNC_STALL_UNKNOWN = "unknown";

/**
 * ISS-7401 — which sync lane a stall belongs to. The six real values are those
 * of `SyncLane` in `@closedloop-ai/telemetry-contract/sync`, which also names
 * the `sync.lane` span attribute, so a stall alert joins to that lane's batch
 * spans.
 *
 * Mirrored as literals rather than imported, matching every other desktop enum
 * in this file: `@closedloop-ai/telemetry-contract` resolves here only through
 * its built `dist`, and this package's vitest alias points at a `src/` directory
 * the root-level `sync.ts` does not live in — so importing it compiles and then
 * fails every test in this package at load time. Drift is pinned by
 * `__tests__/telemetry-sync-lane-stall.test.ts`, which feeds the RAW strings the
 * desktop producer emits rather than this const.
 *
 * TOLERANT. Desktop and server deploy independently, so a newer install WILL
 * name a lane this list does not have. A closed `z.enum` made that one unknown
 * string reject the ENTIRE event, so every stall diagnostic from that build
 * vanished as `telemetry.validation_failed` and re-vanished on retry — the alert
 * going darkest exactly when a new lane is the thing failing (codex, PR #5915).
 * Coarsening keeps the event and its other dimensions and costs only this
 * field's precision. A non-string is still invalid: the tolerance is for unknown
 * MEMBERS, not for a structurally wrong payload.
 *
 * NOT built on `tolerantDesktopTelemetryValue`, which is the same tolerance and
 * would be the SSOT choice, because `no-unmirrored-desktop-telemetry-enum` reads
 * that call in the AST and then requires a same-named const exported from
 * `apps/desktop/src/main/{telemetry,database}/` to compare the members against.
 * These two vocabularies are owned by `packages/telemetry-contract/sync.ts` and
 * `apps/desktop/src/shared/sync-burndown-contract.ts`, neither of which is on
 * that surface, so the wrapper would enrol a pair the gate cannot actually
 * police. The producer→ingest check it would have run is the one
 * `telemetry-sync-lane-stall.test.ts` runs against the CANONICAL owners, which
 * is strictly the better oracle; widening the gate's roots to cover them is a
 * separate change to shared lint infrastructure.
 */
const SYNC_LANE = z.union([
  z.enum([
    "session_metadata",
    "invocation_parts",
    "transcript_archive",
    "component_inventory",
    "trace_comments",
    // PRD-797 retired the routine lane, but installed pre-PRD-797 Desktop
    // builds still run it and report under this label.
    "routine",
  ]),
  z.string().transform(() => SYNC_STALL_UNKNOWN),
]);

/**
 * ISS-5973 — why a lane stall was raised. Mirrors `SyncLaneStallKind` in
 * `apps/desktop/src/shared/sync-burndown-contract.ts`, which this package cannot
 * import (it is desktop-app code, not a shared package).
 *
 * Tolerant for the same version-skew reason as {@link SYNC_LANE}, and NOT folded
 * onto `cursor_frozen`: the desktop producer picks that fallback because its own
 * sentence has to say something, whereas here a coarsened value would be counted
 * on a dashboard beside genuinely frozen cursors. An in-tree kind that reaches
 * the sentinel is DRIFT rather than skew.
 *
 * `__tests__/telemetry-sync-lane-stall.test.ts` asserts each producer kind
 * survives as ITSELF — but only over a HAND-WRITTEN copy of the producer's
 * members, so it catches this schema regressing and does NOT catch a kind added
 * upstream. The lane half next door IS pinned to `Object.values(SyncLane)`; the
 * kind half cannot be, because `SyncLaneStallKind` lives in `apps/desktop` app
 * code this package cannot import, and `no-unmirrored-desktop-telemetry-enum`
 * does not police it either (its producer roots are `src/main/telemetry/` and
 * `src/main/database/`; the const is in `src/shared/`). ISS-8768 added
 * `gate_shut_with_backlog` and nothing went red. Closing that needs an
 * importable owner for the const or a widened producer root, which is a change
 * with its own blast radius — until then, adding a kind means editing BOTH
 * halves by hand.
 */
const SYNC_LANE_STALL_KIND = z.union([
  z.enum([
    "cursor_frozen",
    "no_progress",
    "gate_shut_with_backlog",
    // ISS-9823: the lane is running but its once-per-identity resume read keeps
    // failing, so every pass is abandoned before it can enqueue.
    "resume_read_failed",
  ]),
  z.string().transform(() => SYNC_STALL_UNKNOWN),
]);

/**
 * ISS-9744 — WHAT `deadLetteredCount` on the same event counted. The producer
 * measures it from two incompatible populations (a live `GROUP BY status` row
 * count that a redrive LOWERS, versus the durable abandoned-id list on the
 * lane's cursor row) and one lane has no dead-letter state at all, so a panel
 * that sums or compares the bare count across lanes is adding unlike things.
 *
 * Tolerant and hand-mirrored for the same reason as {@link SYNC_LANE_STALL_KIND}:
 * `SyncLaneDeadLetteredBasis` lives in `apps/desktop/src/shared/`, which this
 * package cannot import. Coarsened rather than folded onto a member — asserting
 * a basis this schema did not receive is precisely the collapse the field
 * closes.
 */
const SYNC_LANE_DEAD_LETTERED_BASIS = z.union([
  z.enum([
    "queue_status_count",
    "abandoned_id_ledger",
    "no_dead_letter_state",
    "unmeasured",
  ]),
  z.string().transform(() => SYNC_STALL_UNKNOWN),
]);

/**
 * ISS-9418 - the ENVIRONMENTAL cause a lane gave up on. Mirrors `SyncReason` in
 * `packages/telemetry-contract/sync.ts`, hand-held for the reason
 * {@link SYNC_LANE} states: this package's vitest resolves that package to a
 * `dist` the root-level `sync.ts` does not live in, so importing it compiles and
 * then fails every test here at load time.
 *
 * Tolerant, and here the tolerance is load-bearing rather than defensive. This
 * is the ONLY channel a give-up is ever observed on (PLN-1961 D-a: no badge, no
 * settings row, no notification), so a newer desktop naming a reason this list
 * has not learned must not sink the event - the alert would go darkest exactly
 * when a new failure class is the thing breaking, which is the outcome codex's
 * PR #5915 measured for the lane vocabulary next door. Coarsening keeps the
 * lane, the duration and the items-owed count and costs only this field.
 *
 * Drift is pinned by `__tests__/telemetry-sync-lane-give-up.test.ts`, which
 * holds this list against `Object.values(SyncReason)` - the canonical owner,
 * which a TEST here can import even though this module cannot.
 */
const SYNC_LANE_GIVE_UP_REASON = z.union([
  z.enum([
    "ack_clear_failed",
    "ack_omitted",
    "ack_timeout",
    "generation_conflict",
    "part_conflict",
    "protocol_unsupported",
    "rate_limited",
    "session_missing",
    "source_missing",
    "transport_timeout",
    "transport_unavailable",
    "ingestion_failed",
    "upload_conflict",
    "validation_failed",
    "feature_disabled",
    "locally_oversized",
    "target_not_owned",
    "transport_error",
    "unauthenticated",
    "unhydratable",
    "lane_gave_up",
    "local_read_failed",
  ]),
  z.string().transform(() => SYNC_STALL_UNKNOWN),
]);

/**
 * ISS-9418 - WHICH recovery door re-armed a given-up lane. Mirrors
 * `LaneReArmTrigger` in `apps/desktop/src/shared/lane-give-up.ts`, which this
 * package cannot import (desktop app code, not a shared package).
 *
 * Tolerant like its siblings, and NOT folded onto a member: `event` says a
 * precondition the lane was blocked on actually changed while `window` says only
 * that a retry timer elapsed, so a coarsened value counted beside either would
 * assert the very claim the field exists to separate. The field is also OMITTED
 * entirely by a producer whose give-up ended because the lane ANSWERED rather
 * than through a door, which is a third state and stays readable as an absence.
 */
const SYNC_LANE_REARM_TRIGGER = z.union([
  z.enum(["event", "window"]),
  z.string().transform(() => SYNC_STALL_UNKNOWN),
]);

/**
 * PLN-2028 D7 (ISS-10043) - WHICH producer wrote a lane's give-up. Mirrors
 * `LaneGiveUpSource` in `packages/telemetry-contract/sync.ts`, hand-held like
 * its siblings: the `/sync` subpath resolves to that package's BUILT `dist`, so
 * a source import here typechecks in a tree that happens to have one and reds
 * every lane that typechecks without building, which is what `scripts/lint` and
 * `scripts/deploy` do.
 *
 * It is the dimension that makes a grouped query MEAN something on the session
 * lane, which has two producers writing one give-up. `environmental_gate` says
 * the world was broken for this lane for a day and the lane is terminal;
 * `row_ceiling` says enough individual rows exhausted their own budgets while the
 * lane kept attempting. Without this field the documented claim "a monitor
 * grouped by `lane` separates the shapes" is simply false for that lane.
 *
 * Drift is pinned by `__tests__/telemetry-sync-lane-give-up.test.ts`, which
 * holds this list against `Object.values(LaneGiveUpSource)` - the canonical
 * owner, which a TEST here can import even though this module cannot. A third
 * producer added there cannot coarsen to `unknown` here with nothing going red;
 * the grouped monitor this field exists for would have stopped separating the
 * terminal case from the routine one (tamsinb review).
 *
 * Tolerant like its siblings, and OPTIONAL: it is absent from every give-up a
 * desktop older than PLN-2028 M5 emits, and from one RESUMED off a row written
 * before migration 0091, which records no producer. Accepted here before any
 * desktop sends it - this schema ships with cl-api, which deploys continuously,
 * while a desktop build reaches a user's machine only on update.
 */
const SYNC_LANE_GIVE_UP_SOURCE = z.union([
  z.enum(["environmental_gate", "row_ceiling"]),
  z.string().transform(() => SYNC_STALL_UNKNOWN),
]);

export const lifecycleDiagnosticsSchema = z
  .object({ command: z.string().optional() })
  .passthrough();

/**
 * FEA-1969 — the costing layer that observed an unpriced model. Mirrors the
 * `TokenCostPricingMissSurface` union in
 * `apps/desktop/src/main/telemetry/telemetry-protocol.ts`.
 *
 * TOLERANT since ISS-7488, and it was the single largest source of rejected
 * desktop telemetry: 15 of the 33 events refused over the 30 days to 2026-09-14
 * failed on this one field. A costing surface only a newer desktop knows is the
 * expected state of a fleet mid-rollout, and refusing it took the model, the
 * reason, and the session id down with it — the pricing-miss event going dark
 * precisely when a NEW costing path is the one missing prices.
 */
export const TokenCostPricingMissSurface = {
  SyncedSession: "synced_session",
  SyncResolver: "sync_resolver",
  BranchProjection: "branch_projection",
  TraceActivity: "trace_activity",
  ImportedTokenCosts: "imported_token_costs",
  ComponentInvocation: "component_invocation",
  /**
   * ISS-7488 — a surface this build does not recognise. No producer emits it;
   * it is where a newer desktop's surface lands so the rest of the event lives.
   */
  Unknown: "unknown",
} as const;

export type TokenCostPricingMissSurface =
  (typeof TokenCostPricingMissSurface)[keyof typeof TokenCostPricingMissSurface];

export const desktopTelemetryDiagnosticsSchema = z.object({
  logTail: z.string().optional(),
  exitCode: z.number().optional(),
  planSource: z
    .object({
      source: z.enum([
        "raw-artifact",
        "local-plan-json",
        "imported-plan-compat",
      ]),
      rawPlanPayload: z.boolean(),
      rawPlanAligned: z.boolean(),
      localPlanJsonPresent: z.boolean(),
      localPlanJsonAligned: z.boolean(),
      importedPlanFileStaged: z.boolean(),
      closedLoopPlanFileSet: z.boolean(),
      planArtifactContentLength: z.number(),
      rawPlanContentLength: z.number().nullable().optional(),
      planArtifactContentHash: z.string().nullable().optional(),
      rawPlanContentHash: z.string().nullable().optional(),
    })
    .optional(),
  tokenUsage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheCreationInputTokens: z.number().optional(),
      cacheReadInputTokens: z.number().optional(),
    })
    .optional(),
  stderrTail: z.string().optional(),
  exitSignal: z.string().optional(),
  elapsedMs: z.number().optional(),
  stdoutBytes: z.number().optional(),
  abortReason: z.string().optional(),
  diagnosticsVersion: z.number().optional(),
  decisionTableVerification:
    decisionTableVerificationDiagnosticsSchema.optional(),
  desktopUpdate: desktopUpdateDiagnosticsSchema.optional(),
  desktopShutdown: desktopShutdownDiagnosticsSchema.optional(),
  pluginUpdate: z
    .object({
      pluginIds: z.array(z.string().max(80)).max(6),
      versionsBefore: z.record(z.string().max(80), z.string().max(64)),
      versionsAfter: z.record(z.string().max(80), z.string().max(64)),
      outcomes: z.record(
        z.string().max(80),
        z.enum(["success", "failed", "timeout", "skipped"])
      ),
      durationMs: z.number().nonnegative(),
      command: z.literal("claude plugin update"),
      scope: z.literal("user"),
      exitCode: z.number().optional(),
      failureReason: z
        .enum([
          "command_failed",
          "timeout",
          "still_outdated",
          "cli_unavailable",
          "manifest_unavailable",
          "unknown",
        ])
        .optional(),
      stderrTail: z.string().max(512).optional(),
    })
    .strip()
    .optional(),
  outboundNetwork: outboundNetworkDiagnosticsSchema.optional(),
  supportUpload: supportUploadDiagnosticsSchema.optional(),
  loopPerf: loopPerfEventDiagnosticsSchema.optional(),
  lifecycle: lifecycleDiagnosticsSchema.optional(),
  // FEA-1969 — token-cost pricing miss. Typed (not `extra`) so the fields
  // survive validation: the top-level diagnostics object strips unknown keys,
  // so only declared fields reach Datadog.
  tokenCostPricingMiss: z
    .object({
      model: z.string().max(120),
      reason: z.enum(["unknown_model", "no_match", "compute_error"]),
      surface: tolerantDesktopTelemetryValue(TokenCostPricingMissSurface),
      sessionId: z.string().max(200).optional(),
    })
    .optional(),
  // FEA-1999 — desktop SQLite store integrity probe result. Typed (not `extra`)
  // so the fields survive validation and reach Datadog. The producer only ever
  // emits bounded, content-free fields: `object` is a schema identifier (index
  // or table name), never row content. `.strip()` drops any unexpected key, and
  // `issues` is bounded so a corrupt store cannot inflate the payload.
  storeIntegrity: z
    .object({
      healthy: z.boolean(),
      durationMs: z.number().int().nonnegative(),
      // ISS-5444 / ISS-7488 — a derived cap plus a fold that keeps it sound; the
      // reasoning lives with the vocabulary, on `STORE_INTEGRITY_CHECKS_RUN`.
      checksRun: STORE_INTEGRITY_CHECKS_RUN,
      issueCount: z.number().int().nonnegative(),
      issues: z
        .array(
          z
            .object({
              check: STORE_INTEGRITY_CHECK_NAME,
              category: STORE_INTEGRITY_ISSUE_CATEGORY,
              object: z.string().max(128).optional(),
              objectType: z.enum(["index", "table", "unknown"]).optional(),
            })
            .strip()
            .superRefine(storageExhaustedObjectIsBounded)
        )
        .max(64),
      truncated: z.boolean(),
    })
    .strip()
    .optional(),
  // ISS-6339 — a periodic desktop store PERFORMANCE sample. Typed (not `extra`)
  // because the top-level diagnostics object strips unknown keys, and a monitor
  // grouping by statement family needs the field to survive validation.
  //
  // Every label here is a closed enum or a number: no SQL text, no bound values,
  // no table or column name, no filesystem path. `families` is capped at the
  // ENUM'S CARDINALITY rather than a hand-tuned literal (the ISS-5444 lesson):
  // the producer appends each family at most once per window, so a run can never
  // report more than exist, and adding a family moves the cap with it.
  //
  // `dbSizeBytes` / `walSizeBytes` are optional because a `stat` that did not
  // resolve leaves the size UNKNOWN, and the producer OMITS an unknown gauge
  // rather than sending a zero that would read as an empty store.
  storePerf: z
    .object({
      windowMs: z.number().int().nonnegative(),
      slowQueryThresholdMs: z.number().nonnegative(),
      bucketBoundsMs: z.array(z.number().nonnegative()).max(32),
      families: z
        .array(
          z
            .object({
              family: SQL_STATEMENT_FAMILY,
              // POSITIVE, not merely non-negative: a family row that reports
              // zero statements describes a family that did not run, and the
              // producer omits an empty family entirely. Rejecting it here is
              // how a producer that materializes rows before counting them
              // becomes visible instead of quietly diluting a rate.
              count: z.number().int().positive(),
              slowCount: z.number().int().nonnegative(),
              maxDurationMs: z.number().int().nonnegative(),
              buckets: z.array(z.number().int().nonnegative()).max(33),
            })
            .strip()
        )
        .max(SQL_STATEMENT_FAMILIES.length),
      dbSizeBytes: z.number().int().nonnegative().optional(),
      walSizeBytes: z.number().int().nonnegative().optional(),
    })
    .strip()
    .optional(),
  // ISS-6339 — one desktop boot migration step. `name` is a migration directory
  // name from the PRODUCER BUILD'S embedded manifest, so it is bounded by the
  // build rather than by anything the local store holds — unlike the refusal
  // path, whose migration name comes from the store and is deliberately kept off
  // the wire (see `buildMigrationFailureTelemetryError` in apps/desktop).
  migrationStep: z
    .object({
      name: z.string().max(128),
      outcome: MIGRATION_STEP_OUTCOME,
      durationMs: z.number().int().nonnegative(),
    })
    .strip()
    .optional(),
  spawnMeta: z
    .object({
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      claudeVersion: z.string().optional(),
      binaryPath: z.string(),
      authFilesExist: z.boolean(),
      envSnapshot: z.record(z.string(), z.string()),
    })
    .optional(),
  // ISS-5715 — an unexpected desktop db-host exit. Counters and an exit code
  // only; no paths, SQL or row content, so nothing here can carry user data.
  // `exitCode` is deliberately nullable AND untrusted: Electron reports 0 on the
  // utility-process `exit` event whenever the mojo pipe disconnects before the
  // platform termination status is available (electron/electron#42283), so a
  // crash and a clean stop are indistinguishable from it. The event's existence
  // — not its code — is the signal.
  // ISS-8776 — `restartAttempts` is OPTIONAL and set only on the
  // `desktop.db_host.restart_exhausted` category. It has to be its own field
  // because `crashesInWindow` counts crashes inside the 60 s FEA-3072 window
  // while the restart ladder spans roughly two minutes: by the time the ladder
  // gives up the early failures have aged out, and on a run driven purely by
  // spawn failures (no child ever reaching `exit`) that counter reads 0 against
  // 8 failed attempts. An alert grouped on the windowed number would rank the
  // worst db-host state this app can reach as the mildest. Old desktop builds
  // omit it, so it must stay optional.
  dbHostExit: z
    .object({
      exitCode: z.number().int().nullable(),
      crashesInWindow: z.number().int().nonnegative(),
      backoffMs: z.number().int().nonnegative(),
      rejectedOps: z.number().int().nonnegative(),
      restartAlreadyInFlight: z.boolean(),
      restartAttempts: z.number().int().nonnegative().optional(),
    })
    .strip()
    .optional(),
  // ISS-6417 — records a desktop collector read and then dropped. A bounded
  // reason and a count, nothing else, so this can never carry transcript
  // content. Typed (not `extra`) because the top-level diagnostics object strips
  // unknown keys, and an alert that groups by `reason` needs the field to
  // survive validation.
  //
  // `count` is POSITIVE, not merely non-negative: a drop report that says zero
  // describes a drop that did not happen, and this schema rejecting it is how a
  // producer that increments its tally outside the branch where the drop
  // actually occurred becomes visible instead of quietly inflating the alert.
  collectorRecordsDropped: z
    .object({
      reason: COLLECTOR_RECORDS_DROPPED_REASON,
      count: z.number().int().positive(),
    })
    .strip()
    .optional(),
  // ISS-6170 — the pack-install error code the desktop installer gave up on. A
  // bounded code and nothing else: the pack id and the cloud distribution id
  // stay in the desktop-local log, where an operator on that machine can act on
  // them. Typed (not `extra`) because this object strips unknown keys, and an
  // alert that routes "your build's catalog is stale" (`ENOTFOUND`) differently
  // from "this pack has no install command" (`ENOCOMMAND`) needs the field to
  // survive validation.
  //
  // The enum mirrors the producer's whole closed vocabulary
  // (`StreamRunErrorCode` in `apps/desktop/src/shared/install-run-contract.ts`),
  // not just the codes that latch today, so re-classifying one of the remaining
  // codes as permanent does not silently start getting stripped here. This
  // package cannot import from `apps/desktop`, so the mirror is hand-held —
  // the same boundary re-declaration `collectorRecordsDropped` makes above.
  distributionInstallGaveUp: z
    .object({
      reason: z.enum([
        "ENOTFOUND",
        "ENOCOMMAND",
        "ENOCLI",
        "EBADCWD",
        "EINFLIGHT",
        "ECWDREQUIRED",
      ]),
    })
    .strip()
    .optional(),
  // The parts a tick lost to a parent session the cloud could not find, with
  // that parent's local outbox state. Identifiers are carried here and
  // NOWHERE in the keyless transport-health spans; see
  // `invocationSyncDiagnosticIdSchema`, which redacts anything outside the
  // diagnostic id shape.
  invocationSyncMissingParents: invocationSyncMissingParentsSchema.optional(),
  // ISS-7401 — WHICH lane stalled and WHY, as structured fields rather than
  // prose. `sync.durable_cursor.stalled` carried lane and kind only inside
  // `message`, so the dashboard could count events and nothing else: a healthy
  // session lane at flat queue depth and a transcript lane sitting on thousands
  // of dead-letters were one undifferentiated number, and "which population
  // dominates" was unanswerable without reading events by hand. Typed (not
  // `extra`) because the top-level diagnostics object strips unknown keys, and a
  // monitor grouping by `@diagnostics.syncLaneStall.lane` /
  // `.kind` needs both to survive validation.
  //
  // Counts and bounded vocabularies only — no session ids, paths, or payload
  // bodies. Both vocabularies are TOLERANT (see `SYNC_LANE`): a value only
  // a newer desktop knows folds to `unknown` here rather than sinking the event.
  // `itemsRemaining` is OPTIONAL and never defaulted: a lane that cannot measure
  // its remainder must not report `0`, which reads as "nothing owed" on the
  // exact alert that says work is not draining.
  syncLaneStall: z
    .object({
      lane: SYNC_LANE,
      kind: SYNC_LANE_STALL_KIND,
      workCompletedSincePrevious: z.number().int().nonnegative(),
      deadLetteredCount: z.number().int().nonnegative(),
      // ISS-9744 — which quantity the count above is. OPTIONAL and never
      // defaulted: an older desktop omits it, and "undimensioned" must stay
      // distinguishable from a stated basis.
      deadLetteredBasis: SYNC_LANE_DEAD_LETTERED_BASIS.optional(),
      durableCursorAgeMs: z.number().int().nonnegative().optional(),
      itemsRemaining: z.number().int().nonnegative().optional(),
      itemsRemainingIsLowerBound: z.boolean().optional(),
      // ISS-7401 — rows the lane REPORTED clearing since the previous sample.
      // Present-and-zero is the interesting case (cleared nothing), so this is
      // omitted when unmeasured rather than defaulted.
      queueRowsClearedSincePrevious: z.number().int().nonnegative().optional(),
    })
    .strip()
    .optional(),
  // ISS-7201 — a child telemetry event main refused to route. A bounded reason
  // and nothing else: the refused event's content is exactly what failed
  // validation. Typed (not `extra`) because this object strips unknown keys.
  dbHostTelemetryRefused: dbHostTelemetryRefusedDiagnosticsSchema,
  // ISS-8115 — a db-host reply main refused at the IPC boundary. The bounded op
  // path and nothing else, for the same reason as the sibling above.
  dbHostReplyRejected: dbHostReplyRejectedDiagnosticsSchema,
  // ISS-7332 — persisted result envelopes dropped on load; validator sibling-owned.
  harnessResultEnvelopesDropped: harnessResultEnvelopesDroppedDiagnosticsSchema,
  // ISS-6331 — renderer health. Counts and closed enums, plus `detail`, which
  // the producer runs through `sanitizeDesktopException`'s text sanitizer BEFORE
  // it is buffered: a `did-fail-load` payload naturally carries the failing URL,
  // and on a packaged app that URL is a `file://` path containing the OS account
  // name (ISS-6229). What arrives here is already `[redacted-path]`. The cap is
  // belt-and-braces on top of the producer's own.
  rendererHealth: z
    .object({
      /** Reloads the crash breaker had spent in its rolling window. */
      reloadsInWindow: z.number().int().nonnegative(),
      source: RENDERER_LOAD_FAILURE_SOURCE.optional(),
      /** Chromium net error code. An integer, never a URL. */
      errorCode: z.number().int().optional(),
      detail: z.string().max(512).optional(),
    })
    .strip()
    .optional(),
  // ISS-11351 — which local durable read failed. Typed (not `extra`) because
  // this object strips unknown keys, and the log sample a triager reads must
  // keep `read`. It is not a monitor dimension: the presence monitor counts the
  // category alone (see `TelemetryCategory.LocalReadFailed`).
  // OPTIONAL, so an older desktop and every other category validate unchanged.
  localReadFailed: z
    .object({ read: LOCAL_READ_FAILED_READ })
    .strip()
    .optional(),
  // ISS-9418 - a lane that crossed its 24h ENVIRONMENTAL wall clock, and its
  // paired recovery. Typed (not `extra`) because this object STRIPS unknown keys,
  // and a monitor grouping by `@diagnostics.syncLaneGaveUp.lane` / `.reason`
  // needs both to survive validation. Counts, durations and bounded vocabularies
  // only.
  //
  // `reason` is OPTIONAL because the durable give-up stamp records an instant and
  // no cause, so a desktop that RELAUNCHES inside an outage resumes a give-up it
  // cannot explain and omits the field rather than naming a member that means
  // something else. Relaxed here before any desktop can emit the omission: this
  // schema ships with cl-api, which deploys continuously, while a desktop build
  // reaches a user's machine only on update - the receiver-first order
  // `docs/runbooks/backward-compatible-api-contracts.md` requires.
  //
  // `itemsOwed` and `deadLetteredCount` are OPTIONAL and never defaulted: the
  // component lane keeps no queue at all, and a `0` there reads as "nothing was
  // owed" / "nothing was abandoned" on the exact event that says collection has
  // stopped. Same discipline as `itemsRemaining` on the stall event above, and
  // `deadLetteredCount` is deliberately the same NAME that event uses for the
  // same quantity.
  //
  // `stalledForMs` is OPTIONAL for the same reason and not because a producer may
  // forget it. It is the load-bearing number here, so a producer that cannot
  // measure it omits it rather than sending the `0` that renders as an instant
  // give-up; a NEGATIVE is still refused outright below, which is what keeps the
  // omission the only way to say "unmeasured".
  syncLaneGaveUp: z
    .object({
      lane: SYNC_LANE,
      reason: SYNC_LANE_GIVE_UP_REASON.optional(),
      source: SYNC_LANE_GIVE_UP_SOURCE.optional(),
      stalledForMs: z.number().int().nonnegative().optional(),
      itemsOwed: z.number().int().nonnegative().optional(),
      deadLetteredCount: z.number().int().nonnegative().optional(),
    })
    .strip()
    .optional(),
  // ISS-9418 - the recovered half of the pair above. `trigger` is OPTIONAL and
  // OMITTED, never defaulted: a lane whose give-up ended because the server
  // ANSWERED came through no recovery door at all, and that is a third state
  // which must stay distinguishable from `event` and `window`.
  syncLaneReArmed: z
    .object({
      lane: SYNC_LANE,
      trigger: SYNC_LANE_REARM_TRIGGER.optional(),
      gaveUpForMs: z.number().int().nonnegative().optional(),
    })
    .strip()
    .optional(),
});

// Server-emission format — extends desktop with server-only fields.
// The schema split enforces the server-only invariant structurally, so the
// JSDoc is backed by parsing behavior rather than documentation alone.
export const telemetryDiagnosticsSchema =
  desktopTelemetryDiagnosticsSchema.extend({
    /** Server-only lifecycle-protocol field. Semantically scoped to CommandAcknowledged events; must not be set on other categories. Desktop wire parsing strips this field. */
    ackLatencyMs: z.number().optional(),
  });

export type TelemetryDiagnostics = z.infer<typeof telemetryDiagnosticsSchema>;

// ---------------------------------------------------------------------------
// DesktopTelemetryEvent — accepts Electron wire format and transforms
// trace.sessionId → loopSessionId
// ---------------------------------------------------------------------------

export const desktopTelemetryEventInputSchema = z.object({
  schemaVersion: z.string(),
  category: z.string(),
  severity: z.string(),
  timestamp: z.string(),
  // The `satisfies` is load-bearing, not decoration. This object is the DESKTOP
  // WIRE boundary and Zod strips what it does not know, so a field added to
  // `telemetryTraceContextSchema` but not here is dropped silently on every
  // desktop event — no rejection, no log, just an attribute that never arrives.
  // Totality against the canonical key set makes the next such field fail
  // `tsc` instead.
  //
  // `schemaVersion` is the ONE exclusion, and it is a real shape difference: it
  // lives on the event, not the trace. `sessionId` is the extra key — the older
  // spelling. ISS-9759 admitted `loopSessionId` beside it because the desktop's
  // own `TelemetryTraceContext`
  // (apps/desktop/src/main/telemetry/telemetry-protocol.ts) declares only
  // `loopSessionId` and no `sessionId`, so accepting `sessionId` alone stripped
  // the key from every desktop event and the transform rewrote it to
  // `undefined`. Both spellings are accepted and folded into one output field
  // below; `sessionId` stays so a version-skewed build's payload is never
  // rejected.
  trace: z.object({
    commandId: z.string(),
    operationId: z.string(),
    computeTargetId: z.string(),
    gatewaySessionId: gatewaySessionIdSchema.optional(),
    // `.catch(undefined)` for the same reason `desktopBuildCommitSchema` above
    // carries one, and it is load-bearing here in a way it was not before this
    // key was declared. While `loopSessionId` was UNKNOWN to this object, Zod's
    // `.strip` dropped a malformed value and the span still recorded. Declaring
    // it as a bare format check would have turned that into a WHOLE-event
    // rejection — the desktop's own contract is `loopSessionId?: string`
    // (telemetry-protocol.ts) and the value is the untrimmed-then-trimmed
    // contents of an on-disk `session-id.txt`, never UUID-validated at the
    // producer, so a truncated or partially-written file is reachable. That
    // would silence the whole `job.completed` / `job.failed` span and a consumer
    // counting completions would read the absence as "the job never completed".
    // Discard the one dimension instead; the transform below then falls through
    // to `sessionId`.
    loopSessionId: z.uuid().optional().catch(undefined),
    // NOT given the same treatment, deliberately: this is the pre-existing
    // shipped shape and tightening or loosening it is a separate decision.
    sessionId: z.uuid().optional(),
    loopId: z.string().optional(),
    jobId: z.string().optional(),
    requestId: z.string().optional(),
    environment: z.string().optional(),
    serverVersion: z.string().optional(),
    pluginVersion: z.string().optional(),
    desktopClientVersion: z.string().optional(),
    desktopBuildCommit: desktopBuildCommitSchema,
    gatewayProtocolVersion: z.string().optional(),
  } satisfies Record<
    Exclude<keyof TelemetryTraceContext, "schemaVersion"> | "sessionId",
    z.ZodTypeAny
  >),
  diagnostics: desktopTelemetryDiagnosticsSchema.optional(),
  message: z.string().optional(),
  errorClass: z.string().optional(),
});

type DesktopTelemetryEventInput = z.infer<
  typeof desktopTelemetryEventInputSchema
>;

export const desktopTelemetryEventSchema =
  desktopTelemetryEventInputSchema.transform(
    (raw: DesktopTelemetryEventInput) => {
      const { sessionId, loopSessionId, desktopBuildCommit, ...restTrace } =
        raw.trace;
      return {
        schemaVersion: raw.schemaVersion,
        category: raw.category,
        severity: raw.severity,
        timestamp: raw.timestamp,
        trace: {
          ...restTrace,
          // A rejected commit is recorded as NOTHING. `.catch` above turns an
          // invalid value into `undefined`, but Zod keeps the KEY whenever the
          // client sent one, so the omission has to be re-established here: a
          // conditional spread can add a key, it cannot remove one.
          ...(desktopBuildCommit !== undefined && { desktopBuildCommit }),
          // ISS-9759: `loopSessionId` is the spelling the desktop actually
          // emits; `sessionId` is the older one, still read so a skewed build
          // keeps correlating. A build sending both is taken at its newer word.
          loopSessionId: loopSessionId ?? sessionId,
        },
        diagnostics: raw.diagnostics,
        message: raw.message,
        errorClass: raw.errorClass,
      };
    }
  );

export type DesktopTelemetryEvent = z.infer<typeof desktopTelemetryEventSchema>;
