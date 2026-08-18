/**
 * @file soak-types.ts
 * @description Types shared across the Stage-0 soak harness modules. Kept in
 * one module so the harness has a single canonical declaration of its record
 * shape and per-cycle state, and so no two modules need to import each other
 * just to name a type.
 */

import type { ChildProcess } from "node:child_process";
import type { ElectronApplication, Page } from "@playwright/test";
import type { MockCloudServer } from "./mock-cloud-server";
import type { ContentViolation, RelationCounts } from "./soak-cloud-content";

export type Mode = "clean" | "dbkill" | "appkill";

/** Parsed CLI invocation — the immutable configuration of one battery. */
export type SoakOptions = {
  cycles: number;
  mode: Mode;
  out: string;
  snapshot: string;
  drainBudgetMs: number;
  workRoot: string;
  loadGateMax: number;
};

/** Outbox row counts read straight off the profile's SQLite file. */
export type OutboxDepths = {
  pending: number;
  deadLettered: number;
  invocationPending: number;
};

export type PageReadStats = {
  ok: number;
  errors: number;
  timeouts: number;
  /** ISS-6100: answered with a zero-row list — previously scored `ok`. */
  empty: number;
  /** ISS-6100: answered with a total below the established population. */
  short: number;
  /**
   * The population established for this cycle's page-read query, from the read
   * taken after auth and before the drain poll. `null` until established (or
   * when the establishing read itself failed).
   */
  expectedTotal: number | null;
  /** Smallest `total` seen on a short read — the depth of the shortfall. */
  shortestTotal: number | null;
  latenciesMs: number[];
};

/** One graded page-read sample. See `soak-page-read.ts`. */
export type PageReadGrade = {
  outcome: "ok" | "empty" | "short" | "malformed";
  itemCount: number | null;
  total: number | null;
};

export type AuthBlobs = {
  sessionFile: string;
  signingKeysFile: string;
};

export type LaunchedSoakApp = {
  app: ElectronApplication;
  page: Page;
  /**
   * OOM signatures seen in this launch's output, accumulated AS IT ARRIVES.
   *
   * This used to be a capped in-memory tail of the output (last ~2000 chunks),
   * scanned once at the end. That was a correctness bug, not just a forensics
   * one: a heap-death signature printed early was spliced away before the scan,
   * so a cycle that DID die of OOM could report `noOom: true`. Detection now
   * happens per chunk and the full stream goes to disk, so nothing that ever
   * appeared on the app's output can be lost.
   */
  oomHits: Set<string>;
  /**
   * The launch-time child handle. Held so liveness and PID reads never call
   * `app.process()` again: that re-enters Playwright's dispatcher registry,
   * which throws `TypeError: ... reading '_object'` once the app's dispatcher
   * is disposed — turning any late Playwright teardown into a harness_error
   * that aborts an otherwise-measurable cycle.
   */
  child: ChildProcess;
};

/** One JSONL row: everything measured about one cycle. */
export type CycleRecord = {
  cycle: number;
  mode: Mode;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  loadAvgStart: number;
  loadAvgEnd: number;
  outboxStart: number;
  outboxEnd: number;
  outboxDeadLetteredEnd: number;
  invocationOutboxStart: number;
  invocationOutboxEnd: number;
  baselineSessionCount: number;
  /** Sessions present in the local corpus, not only the pending outbox. */
  localSessionCount: number;
  syncedSessionCount: number;
  lostSessionCount: number;
  lostSessionSample: string[];
  /**
   * ISS-6098: delivered ids with NO local session at all — a genuine population
   * mismatch. Sessions delivered outside the pending-outbox baseline but present
   * locally are counted in {@link CycleRecord.backfilledSyncedCount} instead;
   * see `summarizeCloudDelivery` for the ruling this encodes.
   */
  extraSyncedCount: number;
  unknownSyncedSample: string[];
  /** Delivered, absent from the pending baseline, present locally — by design. */
  backfilledSyncedCount: number;
  rawSessionReceives: number;
  resendWaste: number;
  maxReceivesForOneSession: number;
  /**
   * ISS-6101: sessions delivered more than once across all data revisions —
   * the pre-correction `dup` number, kept as a visible waste signal. Only the
   * subset that repeated the SAME revision fails the cycle.
   */
  redeliveredSessionCount: number;
  /** ISS-6101: deliveries below a revision already sent for the same session. */
  staleRevisionDeliveryCount: number;
  /**
   * ISS-6101: the `${sessionId}#${dataRevision}` keys behind that count. The
   * mock carries them all the way through `CloudDeliverySummary`, so the JSONL
   * row names which sessions regressed instead of leaving a bare number that
   * sends the reader back to the cycle log.
   */
  staleRevisionDeliverySample: string[];
  /**
   * ISS-6101: deliveries that declared no usable `dataRevision` — absent, or
   * below production's `.int().min(1)` floor (the ISS-4572 `-1` import-pending
   * sentinel). Not a fail reason; see the summary field's doc.
   */
  unrevisionedDeliveryCount: number;
  gzipBatches: number;
  identityBatches: number;
  helloCount: number;
  refreshCount: number;
  invocationPartReceives: number;
  componentBatchReceives: number;
  unknownPaths: string[];
  incompleteChunkSessions: string[];
  dbHostKills: number;
  dbHostRecovered: boolean | null;
  appKills: number;
  appRelaunched: boolean | null;
  oomSignatures: string[];
  unexpectedAppExit: boolean;
  monotonicViolations: { atMs: number; from: number; to: number }[];
  drainCompleted: boolean;
  sessionsSyncedPerMinute: number | null;
  pageReads: {
    ok: number;
    errors: number;
    timeouts: number;
    empty: number;
    short: number;
    expectedTotal: number | null;
    shortestTotal: number | null;
    p50Ms: number | null;
    maxMs: number | null;
  };
  /** ISS-6099: what was INSIDE the delivered envelopes. */
  content: {
    /** Sessions with at least one fully-assembled delivery whose content was retained. */
    deliveredSessions: number;
    /** Summed relation rows across every delivered session. */
    relationTotals: RelationCounts;
    violationCount: number;
    violationSample: string[];
    /**
     * Delivered sessions the local DB says HAVE events that arrived carrying
     * zero of them — the cap-safe field-drop detector.
     */
    relationDropSessions: string[];
    /** Sessions the read-back pass returned, and whether it covered the delivered set. */
    readBackSessions: number;
    readBackComplete: boolean;
    readBackSampleBodies: number;
    readBackSampleBytes: number;
    /** The forensic body sample hit a cap — diagnostic, not correctness-bearing. */
    readBackSampleTruncated: boolean;
  };
  invariants: {
    noOom: boolean;
    monotonicDrain: boolean;
    noLoss: boolean;
    noDup: boolean;
    readsAnswer: boolean;
    /** ISS-6099: delivered payloads were internally coherent and complete. */
    contentIntact: boolean;
    /** ISS-6099: the cloud returned every session it was given. */
    readBackComplete: boolean;
    crashRecovered: boolean | null;
  };
  failReasons: string[];
  notes: string[];
};

/**
 * Per-cycle filesystem layout and the pre-drain baseline, all fixed once the
 * profile is seeded and never mutated afterwards.
 */
export type CycleWorkspace = {
  userDataDir: string;
  dbPath: string;
  artifactsDir: string;
  stdioLogPath: string;
  /** Outbox session ids pending at cycle start — the no-loss oracle. */
  baseline: string[];
  /**
   * ISS-6098: every session id in the local corpus. Backfill enumerates
   * sessions independently of the outbox BY DESIGN (operator ruling,
   * 2026-08-12), so a delivered id outside `baseline` but inside this set is
   * expected, not a population mismatch. An id in neither still is.
   */
  localSessionIds: string[];
  /**
   * Sessions the local DB says have at least one event row. Used one-
   * directionally: local-has-events ⇒ delivered-must-carry-events. Producer
   * caps only ever SHRINK a relation, never zero it, so this cross-check
   * cannot fire on a legitimate cap.
   */
  localSessionsWithEvents: string[];
  startDepths: OutboxDepths;
};

/** The inputs every phase helper needs, none of which a phase may change. */
export type CycleContext = {
  cycleIndex: number;
  options: SoakOptions;
  mock: MockCloudServer;
  homes: Record<string, string>;
  workspace: CycleWorkspace;
  startMs: number;
};

/**
 * Everything the drain phase accumulates or replaces, in ONE mutable record.
 *
 * The phases were extracted from a single function whose locals they all
 * shared, so they must keep sharing exactly that aliasing — `launched` above
 * all, which is REPLACED (not mutated) by an appkill relaunch and must still be
 * the handle teardown closes. Passing this record by reference reproduces the
 * original closure semantics; returning copies would not.
 */
export type CycleState = {
  launched: LaunchedSoakApp;
  /** One hit set per launch, so OOM detection covers relaunches too. */
  oomHitSets: Set<string>[];
  pageReads: PageReadStats;
  monotonicViolations: CycleRecord["monotonicViolations"];
  notes: string[];
  failReasons: string[];
  dbHostKills: number;
  dbHostRecovered: boolean | null;
  appKills: number;
  appRelaunched: boolean | null;
  unexpectedAppExit: boolean;
  drainCompleted: boolean;
  lastDepth: number;
};

/** Derived no-loss / no-dup / re-send-waste facts for one cycle. */
export type CloudDeliverySummary = {
  syncedSet: Set<string>;
  lost: string[];
  /** Delivered ids with no local session at all — a real population mismatch. */
  extraSynced: string[];
  /** Delivered outside the pending baseline but present locally (ISS-6098). */
  backfilled: string[];
  maxReceives: number;
  resendWaste: number;
  /**
   * ISS-6101: `${sessionId}#${dataRevision}` entries whose EXACT revision was
   * completely delivered more than once in a CLEAN cycle — a dup violation. A
   * second delivery at a NEWER revision is a required re-sync and is excluded;
   * see `redeliveredSessionCount` for that (non-failing) volume.
   */
  cleanDupSessions: [string, number][];
  /**
   * Sessions completely delivered more than once across ALL revisions. Reported,
   * never failed: the boot data-revision rebuild re-derives the corpus mid-drain
   * and the re-sync of an already-delivered session is correct.
   */
  redeliveredSessionCount: number;
  /**
   * ISS-6101: complete deliveries carrying a revision BELOW one already
   * delivered for that session. The real upsert is forward-only, so these are
   * sends the cloud would reject — a fail reason in every mode.
   */
  staleRevisionDeliveries: string[];
  /**
   * ISS-6101: complete deliveries that declared no usable `dataRevision`.
   * Reported, never failed here: production types the field `.nullish()` so an
   * absent revision is legal, and an unusable one (the ISS-4572 `-1`
   * import-pending sentinel included) is already scored as a
   * `data_revision_invalid` content violation. Carried so such a delivery
   * cannot be scored on the duplicate or stale axes — where it would be a
   * guess — and still leave no trace anywhere.
   */
  unrevisionedDeliveryCount: number;
};

/** ISS-6099 content facts for one cycle, derived from the read-back corpus. */
export type CloudContentSummary = {
  deliveredSessions: number;
  relationTotals: RelationCounts;
  /** Bounded forensic sample; {@link CloudContentSummary.violationCount} is exact. */
  violations: ContentViolation[];
  violationCount: number;
  relationDropSessions: string[];
  readBackSessions: number;
  readBackComplete: boolean;
  readBackSampleBodies: number;
  readBackSampleBytes: number;
  readBackSampleTruncated: boolean;
};
