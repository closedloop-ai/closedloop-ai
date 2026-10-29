import { AgentComponentInvocationSyncRejectReason } from "@repo/api/src/types/agent-component-invocation";
import { z } from "zod";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX,
  AGENT_COMPONENT_INVOCATION_SYNC_OUTBOX_TABLE,
  AgentComponentInvocationSyncLocalError,
} from "../agent-sync/agent-component-invocation-sync-constants.js";
import { isReadableRowTimestamp } from "../agent-sync/invocation-sync-rejection-policy.js";
import type { StoreIntegrityIssue } from "../telemetry/telemetry-protocol.js";
import {
  defineStoreIntegrityOptionalCheck,
  type StoreIntegrityOptionalCheck,
} from "./database-integrity/store-integrity-probe.js";
import {
  readInvocationSyncOutboxObservedThroughMs,
  recordInvocationSyncOutboxObservedThroughMs,
  shouldRecordInvocationSyncOutboxObservation,
} from "./invocation-sync-integrity-observation.js";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";

/** Maximum rows retained by the integrity scan at one time. */
export const INVOCATION_SYNC_OUTBOX_INTEGRITY_PAGE_SIZE = 200;

/**
 * How long a row PARKED by this lane keeps its issue raised, measured from the
 * `updated_at` the dead-letter write stamps. One window for both reported
 * populations (ISS-6209 corruption, ISS-5855 abandonment), because the reason it
 * exists is identical for each and two constants would drift.
 *
 * It has to clear the probe's own worst-case first-observation latency by a wide
 * margin, not merely exceed it: within one launch that latency is
 * `STORE_INTEGRITY_INITIAL_DELAY_MS_DEFAULT + STORE_INTEGRITY_INTERVAL_MS_DEFAULT`
 * (35 minutes), but a quarantine can also be followed immediately by a quit, a
 * sleep, or a boot-import skip that defers the next completed run into a later
 * launch. A day absorbs all of those while still being finite, which is what gives
 * the cadence back the recovery edge that scanning `pending` alone used to supply.
 * `test/invocation-sync-corrupt-created-at.test.ts` pins it against those two probe
 * constants so retuning the probe cadence cannot silently invalidate it.
 *
 * Clearing that latency BY A MARGIN is still not the same as clearing it in every
 * case, because a shutdown defers the next completed run indefinitely rather than by
 * a bounded 35 minutes. So this window does not stand alone: it may only age out a
 * row that has already been reported at least once
 * (`invocation-sync-integrity-observation.ts`). Sizing it larger would not have
 * bought that property — no finite duration does.
 */
export const INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS =
  24 * 60 * 60 * 1000;

/** Clone-safe aggregate returned across the DB-host boundary. */
export type InvocationSyncOutboxIntegrityResult = {
  unreadableCreatedAtRows: number;
  /**
   * Rows the lane already quarantined for an unreadable `created_at`, still inside
   * {@link INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS}.
   *
   * OPTIONAL because a db-host older than this build answers without it, and a
   * missing count must degrade to "none seen" rather than fail the whole read.
   */
  recentlyQuarantinedCorruptRows?: number;
  /**
   * ISS-5855: rows the lane ABANDONED because their parent session never reached
   * the cloud within {@link SESSION_MISSING_MAX_RETRY_AGE_MS}, still inside
   * {@link INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS}.
   *
   * A different finding from the corrupt population above, and the reason this
   * ticket exists: nothing is wrong with the local store here. The row is
   * well-formed and its content is intact — it is the PARENT that is gone, so this
   * data is missing from the cloud unless a later materialization path supersedes
   * it. That is the loss the ticket calls silent.
   *
   * OPTIONAL for the same reason its sibling is: a db-host older than this build
   * answers without it, and a missing count must degrade to "none seen" rather
   * than fail the whole read.
   */
  recentlyAbandonedPartRows?: number;
};

/** Optional DB-host read surface consumed by the regularly wired probe. */
export type InvocationSyncOutboxIntegrityReader = {
  runInvocationSyncOutboxIntegrityCheck?(): Promise<InvocationSyncOutboxIntegrityResult>;
};

/**
 * Runtime boundary for a version-skewed DB-host response.
 *
 * The `satisfies` is a COMPILE-TIME keys-covered guard, not decoration: this
 * schema is the process boundary between the db-host child and the probe, and
 * `z.object` STRIPS a key it does not declare. A field added to
 * {@link InvocationSyncOutboxIntegrityResult} but not here would therefore be
 * silently dropped on the way out of the host and read as absent forever — the
 * count would be produced, discarded, and never alerted on. `keyof` includes
 * optional keys, so a new optional count fails `tsc` here until it is declared.
 */
export const INVOCATION_SYNC_OUTBOX_INTEGRITY_SCHEMA = z.object({
  unreadableCreatedAtRows: z.number().int().nonnegative().safe(),
  recentlyQuarantinedCorruptRows: z
    .number()
    .int()
    .nonnegative()
    .safe()
    .optional(),
  recentlyAbandonedPartRows: z.number().int().nonnegative().safe().optional(),
} satisfies Record<keyof InvocationSyncOutboxIntegrityResult, z.ZodTypeAny>);

/**
 * Scan delivery rows in stable primary-key pages, counting those whose `created_at`
 * the lane cannot read and those it already quarantined for that reason inside the
 * report window. Neither the offending value nor the row's identity is retained —
 * only how many there were.
 *
 * `nowMs` is injected so the window is evaluated against a caller-supplied instant
 * rather than a clock read buried in a query, which is what lets the tests pin the
 * boundary without touching timers.
 */
export async function runInvocationSyncOutboxIntegrityCheck(
  prisma: DesktopPrisma,
  nowMs: number = Date.now()
): Promise<InvocationSyncOutboxIntegrityResult> {
  const scan = await prisma.read((reader) =>
    reader.$transaction(async (transaction) => {
      // Read on the scan's own snapshot, so the marker and the rows compared
      // against it cannot come from two different moments.
      const observedThroughMs =
        await readInvocationSyncOutboxObservedThroughMs(transaction);
      return {
        observedThroughMs,
        result: await scanInvocationSyncOutboxRows(
          transaction,
          nowMs,
          observedThroughMs
        ),
      };
    })
  );
  // Only after the scan has completed, and with the instant the CALLER supplied
  // rather than one read here — see the observation module for why recording the
  // finish instant would let a row parked during the scan be marked observed.
  if (
    shouldRecordInvocationSyncOutboxObservation(nowMs, scan.observedThroughMs)
  ) {
    await recordInvocationSyncOutboxObservedThroughMs(prisma, nowMs);
  }
  return scan.result;
}

/**
 * Convert the scan's counts into content-free table issues.
 *
 * TWO categories, not one, because they are two different findings about the same
 * table and an operator acts on them differently. Unreadable timestamps say the
 * local STORE is wrong — inspect the store, suspect a partial write or a bad
 * migration. An abandoned part says the store is fine and the DATA IS GONE: a
 * parent session never reached the cloud inside the retry horizon, so that
 * session's invocation data is incomplete upstream unless it is superseded.
 * Collapsing them would let a corruption alert mask a data-loss
 * alert, and vice versa.
 *
 * Within the corrupt category the two populations DO collapse (still queued vs.
 * already quarantined), because that distinction is one of timing, not of what the
 * operator does about it.
 */
export function classifyInvocationSyncOutboxIntegrity(
  result: InvocationSyncOutboxIntegrityResult,
  issues: StoreIntegrityIssue[]
): void {
  if (
    result.unreadableCreatedAtRows > 0 ||
    (result.recentlyQuarantinedCorruptRows ?? 0) > 0
  ) {
    issues.push({
      check: "invocation_sync_outbox",
      category: "unreadable_invocation_sync_outbox_timestamp",
      object: AGENT_COMPONENT_INVOCATION_SYNC_OUTBOX_TABLE,
      objectType: "table",
    });
  }
  if ((result.recentlyAbandonedPartRows ?? 0) > 0) {
    issues.push({
      check: "invocation_sync_outbox",
      category: "abandoned_invocation_sync_outbox_part",
      object: AGENT_COMPONENT_INVOCATION_SYNC_OUTBOX_TABLE,
      objectType: "table",
    });
  }
}

/**
 * Compose the clone-safe read, validation, and classifier for probe wiring.
 *
 * The read is a CLOSURE, never
 * `reader.runInvocationSyncOutboxIntegrityCheck?.bind(reader)` — detaching a method
 * off the db-host proxy builds the op path `…Check.bind` and posts the
 * non-clone-safe proxy as an argument, which is how ISS-4818 took Desktop down.
 */
export function invocationSyncOutboxIntegrityCheck(
  reader: InvocationSyncOutboxIntegrityReader
): StoreIntegrityOptionalCheck {
  return defineStoreIntegrityOptionalCheck({
    name: "invocation_sync_outbox",
    label: "invocation sync outbox timestamp integrity check",
    read: reader.runInvocationSyncOutboxIntegrityCheck
      ? () => Promise.resolve(reader.runInvocationSyncOutboxIntegrityCheck?.())
      : undefined,
    schema: INVOCATION_SYNC_OUTBOX_INTEGRITY_SCHEMA,
    classify: classifyInvocationSyncOutboxIntegrity,
  });
}

async function scanInvocationSyncOutboxRows(
  transaction: DesktopPrismaReader,
  nowMs: number,
  observedThroughMs: number | undefined
): Promise<InvocationSyncOutboxIntegrityResult> {
  const parkedRowFloor = parkedRowFetchFloor(nowMs, observedThroughMs);
  let unreadableCreatedAtRows = 0;
  let recentlyQuarantinedCorruptRows = 0;
  let recentlyAbandonedPartRows = 0;
  let cursor:
    | {
        sourceKey: string;
        externalSessionId: string;
        externalGenerationId: string;
        partIndex: number;
      }
    | undefined;

  while (true) {
    const rows = await transaction.agentComponentInvocationSyncOutbox.findMany({
      where: {
        // Delivery keys are `<template>:<computeTargetId>`; the bare template key
        // is excluded by the separator, which is exactly what
        // `buildAgentComponentInvocationSyncSourceKey` appends.
        sourceKey: {
          startsWith: AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX,
        },
        OR: [
          { status: OutboxStatus.Pending },
          {
            status: OutboxStatus.DeadLettered,
            lastError: { in: REPORTED_DEAD_LETTER_CAUSES },
            // The fetch floor, applied in SQL and not only in JS. Without it this
            // branch FETCHES the whole historical parked population on every probe
            // run (every 30 minutes) just to discard all but the reportable part of
            // it in `classifyScannedOutboxRow` — and that population only ever
            // grows, because nothing in this lane deletes a dead-lettered row.
            // Widening the branch to the ISS-5855 cause is what made that matter:
            // an abandoned parent is an ordinary outcome of a cloud outage, so
            // this set is orders of magnitude larger than ISS-6209's corruption
            // set was on its own.
            //
            // `undefined` omits the bound entirely, which happens only on a store
            // this probe has never swept — see {@link parkedRowFetchFloor}.
            ...(parkedRowFloor === undefined
              ? {}
              : { updatedAt: { gte: parkedRowFloor } }),
          },
        ],
      },
      select: {
        sourceKey: true,
        externalSessionId: true,
        externalGenerationId: true,
        partIndex: true,
        status: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [
        { sourceKey: "asc" },
        { externalSessionId: "asc" },
        { externalGenerationId: "asc" },
        { partIndex: "asc" },
      ],
      take: INVOCATION_SYNC_OUTBOX_INTEGRITY_PAGE_SIZE,
      ...(cursor
        ? {
            cursor: {
              sourceKey_externalSessionId_externalGenerationId_partIndex:
                cursor,
            },
            skip: 1,
          }
        : {}),
    });
    for (const row of rows) {
      const kind = classifyScannedOutboxRow(row, nowMs, observedThroughMs);
      if (kind === OutboxFindingKind.PendingUnreadable) {
        unreadableCreatedAtRows += 1;
      } else if (kind === OutboxFindingKind.RecentQuarantine) {
        recentlyQuarantinedCorruptRows += 1;
      } else if (kind === OutboxFindingKind.RecentAbandonment) {
        recentlyAbandonedPartRows += 1;
      }
    }
    const last = rows.at(-1);
    if (
      last === undefined ||
      rows.length < INVOCATION_SYNC_OUTBOX_INTEGRITY_PAGE_SIZE
    ) {
      break;
    }
    cursor = {
      sourceKey: last.sourceKey,
      externalSessionId: last.externalSessionId,
      externalGenerationId: last.externalGenerationId,
      partIndex: last.partIndex,
    };
  }

  return {
    unreadableCreatedAtRows,
    recentlyQuarantinedCorruptRows,
    recentlyAbandonedPartRows,
  };
}

/**
 * The oldest `updated_at` a parked row may carry and still be FETCHED, as the string
 * the column actually stores — or `undefined` for no bound at all.
 *
 * Two reasons a row is still reportable, so the floor is the earlier of the two
 * instants they imply: the report window (parked recently), and never having been
 * observed (parked at or after the last completed scan). A steady-state probe runs
 * every 30 minutes, so the second instant is almost always the later one and the
 * floor is just the window start — the bound ISS-6209 established. It widens only
 * across a gap in probe coverage, and then only as far as that gap.
 *
 * `undefined` — an unbounded fetch — is reachable only when no marker exists, i.e.
 * the first run on a store this probe has never swept. Every parked row on it is
 * unreported by definition, so bounding the fetch would silently decide that some
 * losses are too old to mention; the scan is paged, so the cost of saying them once
 * is bounded, and the marker it writes means it never happens again.
 *
 * Lexicographic comparison is sound for the SQL bound because every write that can
 * produce a `dead_lettered` row on this table stamps `new Date().toISOString()` — a
 * fixed-width UTC instant, for which string order IS chronological order. This is
 * deliberately NOT applied to the `pending` branch, whose rows are selected on
 * `created_at` readability rather than recency.
 *
 * It narrows what is FETCHED. `classifyScannedOutboxRow` still re-checks both rules
 * on the parsed value and remains the authority — a row whose `updated_at` is itself
 * unreadable sorts unpredictably here, so the SQL bound may admit it, and the JS
 * check is what drops it rather than judging it recent on a value it cannot read.
 */
function parkedRowFetchFloor(
  nowMs: number,
  observedThroughMs: number | undefined
): string | undefined {
  if (observedThroughMs === undefined) {
    return undefined;
  }
  return new Date(
    Math.min(
      nowMs - INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS,
      observedThroughMs
    )
  ).toISOString();
}

/** Which reported population, if any, one scanned row belongs to. */
const OutboxFindingKind = {
  PendingUnreadable: "pending_unreadable",
  RecentQuarantine: "recent_quarantine",
  RecentAbandonment: "recent_abandonment",
} as const;
type OutboxFindingKind =
  (typeof OutboxFindingKind)[keyof typeof OutboxFindingKind];

/**
 * Which finding each reported dead-letter cause counts as, and — through
 * {@link REPORTED_DEAD_LETTER_CAUSES} below — which causes are fetched at all.
 *
 * Deliberately an ALLOW-LIST rather than "every dead-lettered row". The other
 * causes in {@link AgentComponentInvocationSyncLocalError}, and the cloud ack
 * reasons `validation_failed` / `part_conflict` / `generation_conflict`, describe a
 * row the cloud examined and refused on its own content. Those are attributable
 * delivery failures with their own bounded recovery path; raising a
 * store-integrity issue for each would fire the monitored event on ordinary
 * rejection traffic and train exactly the wrong reflex about it. These two are
 * the causes where the ROW was not sendable because persisted state was corrupt,
 * or where the row was fine and the parent was permanently missing.
 */
const DEAD_LETTER_CAUSE_FINDINGS: Record<string, OutboxFindingKind> =
  Object.assign(Object.create(null), {
    [AgentComponentInvocationSyncLocalError.CorruptCreatedAt]:
      OutboxFindingKind.RecentQuarantine,
    [AgentComponentInvocationSyncLocalError.InvalidPersistedDurabilityState]:
      OutboxFindingKind.RecentQuarantine,
    [AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted]:
      OutboxFindingKind.RecentAbandonment,
    // LEGACY COMPATIBILITY ALIAS, and the reason the allow-list is keyed on
    // `string` rather than on the local-error enum alone.
    //
    // The marker above is what THIS build writes. Every Desktop build before it
    // persisted the ACK REASON on an outlived row — `deadLetterInvocationSyncPart`
    // received `input.ackReason` unless the row was corrupt — so an installation
    // that upgrades into this build carries durable dead letters marked
    // `session_missing` that are the SAME finding under the previous name. This
    // lane neither recovers nor deletes them, so a rename that only recognised the
    // new value would omit that population forever: the loss stays exactly as
    // silent as it was before the ticket, on precisely the installs that already
    // suffered it. AGENTS.md ("Cross-Repo Compatibility Requirements") settles
    // which way that goes — a renamed durable value keeps the previous one
    // ACCEPTED until a human approves dropping it — and an alias is preferable to
    // a migration here because the two values are read identically and rewriting
    // the column would destroy the only evidence of what the earlier build
    // concluded.
    //
    // It cannot over-report, because it is reachable only from the
    // `dead_lettered` half of the scan. Every row still healthily deferring inside
    // its horizon carries this same `last_error` — that ambiguity is the whole
    // reason the new marker exists — but such a row is `pending`, and the pending
    // branch of {@link classifyScannedOutboxRow} never consults `last_error` at
    // all. Nor can it double-count a CURRENT-build row: `terminalCauseForRejection`
    // always resolves `session_missing` to a lane-side cause, so this build never
    // writes the ack reason onto a parked row.
    [AgentComponentInvocationSyncRejectReason.SessionMissing]:
      OutboxFindingKind.RecentAbandonment,
  });

/**
 * The `last_error` values the scan fetches, DERIVED from the classifier above
 * rather than restated beside it.
 *
 * The two are read as a pair — this list scopes what the query returns, the record
 * decides what each returned row becomes — and a hand-maintained copy could drift
 * either way in silence, since neither `string[]` nor `Record<string, …>` makes
 * `tsc` compare them. A cause added here only would be fetched and then counted by
 * nothing, leaving the very issue this ticket exists to raise silent while the code
 * read as though it were covered.
 */
const REPORTED_DEAD_LETTER_CAUSES: string[] = Object.keys(
  DEAD_LETTER_CAUSE_FINDINGS
);

/** The columns the scan reads; `null` means the row is not reportable evidence. */
type ScannedOutboxRow = {
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

function classifyScannedOutboxRow(
  row: ScannedOutboxRow,
  nowMs: number,
  observedThroughMs: number | undefined
): OutboxFindingKind | null {
  if (row.status === OutboxStatus.Pending) {
    return isReadableRowTimestamp(row.createdAt)
      ? null
      : OutboxFindingKind.PendingUnreadable;
  }
  // A parked row reached this scan only via its `last_error` marker, so WHICH
  // finding it is, is the LANE's own conclusion and is deliberately not re-derived
  // from `created_at` here — re-deriving it is exactly how the probe and the policy
  // would drift apart about which rows are corrupt or abandoned (see
  // `isReadableRowTimestamp` and `terminalCauseForRejection`). What is read instead
  // is WHEN it was parked. The dead-letter write stamps a fresh `updated_at`, so an
  // unreadable one means a second, independent corruption of the same row: its
  // parking instant is unknown, and an unknown instant cannot be judged recent
  // without inventing an age the row does not carry.
  if (!isReadableRowTimestamp(row.updatedAt)) {
    return null;
  }
  const parkedAtMs = Date.parse(row.updatedAt);
  if (
    !isUnreportedParkedRow(parkedAtMs, observedThroughMs) &&
    nowMs - parkedAtMs >= INVOCATION_SYNC_OUTBOX_QUARANTINE_REPORT_WINDOW_MS
  ) {
    return null;
  }
  return row.lastError === null
    ? null
    : (DEAD_LETTER_CAUSE_FINDINGS[row.lastError] ?? null);
}

/**
 * Has no completed scan ever been in a position to report this parked row?
 *
 * The window above may only age out a row the monitor has already been told about,
 * which without this is not what it does: a part dead-lettered shortly before
 * Desktop exits, on a machine then closed or asleep for longer than the window, is
 * discarded by the first probe after restart on age alone and never reported at all
 * (codex, ISS-5855). The row is unreported exactly when it was parked at or after
 * the instant the last completed scan covered — `>=`, not `>`, because that instant
 * is captured before the scan opens its snapshot, so a row stamped with it may or
 * may not have been inside it and the safe reading is that it was not.
 *
 * `undefined` means no scan has ever completed on this store, which makes every
 * parked row on it unreported. See
 * `invocation-sync-integrity-observation.ts` for why that state exists and why the
 * marker is monotone.
 */
function isUnreportedParkedRow(
  parkedAtMs: number,
  observedThroughMs: number | undefined
): boolean {
  return observedThroughMs === undefined || parkedAtMs >= observedThroughMs;
}
