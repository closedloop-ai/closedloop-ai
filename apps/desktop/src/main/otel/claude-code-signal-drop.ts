/**
 * @file claude-code-signal-drop.ts
 * @description ISS-10717 — the dropped-signal counter.
 *
 * Three places can lose a Claude Code OTel signal, and before this module all
 * three logged the loss and discarded it:
 *
 * 1. the OTLP receiver evicts an already-ACKed export when more than
 *    `MAX_PENDING_DISPATCHES` are awaiting persistence (ISS-7482);
 * 2. the normalizer cannot turn a decoded record into a signal (`unusable`,
 *    previously logged and dropped at `otlp-receiver-wiring.ts`);
 * 3. the write boundary rejects a signal that failed validation.
 *
 * Without a count, a consumer of the synced corpus cannot tell a session that
 * genuinely produced no permission events from one whose export was evicted.
 * That distinction is the completeness signal ISS-10717 ships, and this table is
 * what it is computed from.
 *
 * ── Why the counters are aggregate ─────────────────────────────────────────
 * Two of the three losses happen before anything knows the signal's session: an
 * evicted export was never decoded past its envelope, and an unusable record is
 * by definition one whose fields could not be read. Keying by session would mean
 * inventing an attribution, so the grain is `(harness, reason)` — exactly what is
 * knowable — and the completeness signal is reported at the machine level.
 *
 * ── Why it cannot lie ──────────────────────────────────────────────────────
 * The write is an upsert with an atomic `increment`, so two exports dropping
 * concurrently cannot lose a count to a read-modify-write race, and a count is
 * never re-derived from anything. A non-positive or non-integral `count`
 * argument is refused rather than written, because a fractional or negative drop
 * count is not a smaller measurement — it is a wrong one, and it would render as
 * a confident number downstream.
 */

import { ClaudeCodeTelemetryDropReason } from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import type { DesktopPrisma } from "../database/prisma-client.js";

/**
 * Why a signal was lost — the CANONICAL wire vocabulary, re-exported rather
 * than re-declared.
 *
 * These three strings are written to `claude_code_signal_drop.reason`, shipped
 * on the wire, persisted into `claude_code_signal_drop_counter.reason`, and
 * handed to cloud readers. The wire schema bounds them as a string rather than
 * an enum (a newer desktop's reason must not fail the payload), so nothing
 * downstream would catch a second declaration drifting — which is exactly why
 * there is only one.
 *
 * What each member means at ITS drop site:
 *
 *  - `ReceiverBackpressure` — an already-ACKed export was evicted from the
 *    receiver's pending queue before its callback ran (ISS-7482). Nothing about
 *    its contents is known — not the signal count, not the session — so one
 *    eviction counts as one lost EXPORT, which is why the read contract names
 *    this reason separately rather than summing it with the two signal-grained
 *    ones.
 *  - `NormalizerUnusable` — the normalizer decoded the export but could not turn
 *    a record into a signal. Counted per record.
 *  - `PersistenceRejected` — the write boundary refused a normalized signal: a
 *    validation failure, or a `token_usage` signal reaching the side-table lane
 *    it does not belong to.
 */
export const ClaudeCodeSignalDropReason = ClaudeCodeTelemetryDropReason;
export type ClaudeCodeSignalDropReason = ClaudeCodeTelemetryDropReason;

/**
 * Whether `count` is a number of dropped signals that could actually have
 * happened.
 *
 * Covers the whole impossible set rather than the two that are usually
 * remembered: a negative, a non-finite, a fraction (half a signal was not
 * dropped), a zero (nothing to record — writing a row for it would create a
 * drop reason on a machine that has never dropped anything), and a magnitude
 * past the safe-integer range, which arrives as an already-wrong number because
 * the addition that produced it lost precision.
 */
export function isRecordableDropCount(count: number): boolean {
  return Number.isSafeInteger(count) && count > 0;
}

export type ClaudeCodeSignalDropRecorder = {
  record(input: {
    harness: string;
    reason: ClaudeCodeSignalDropReason;
    count: number;
  }): Promise<void>;
};

export type ClaudeCodeSignalDropRecorderOptions = {
  prisma: Pick<DesktopPrisma, "write">;
  now?: () => string;
  /** Where a refused count is reported. Server-side (main process) logging. */
  warn?: (message: string) => void;
};

/** The id a `(harness, reason)` pair is keyed by. */
export function claudeCodeSignalDropId(
  harness: string,
  reason: ClaudeCodeSignalDropReason
): string {
  return `${harness}:${reason}`;
}

export function createClaudeCodeSignalDropRecorder(
  options: ClaudeCodeSignalDropRecorderOptions
): ClaudeCodeSignalDropRecorder {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async record({ harness, reason, count }) {
      if (!isRecordableDropCount(count)) {
        // Routed to the main-process log rather than coerced: a bad count here
        // means an upstream counter is wrong, and silently clamping it would
        // publish a completeness figure derived from a defect.
        options.warn?.(
          `claude-code signal drop refused: ${reason} reported an unrecordable count (${count})`
        );
        return;
      }
      const observedAt = now();
      const id = claudeCodeSignalDropId(harness, reason);
      await options.prisma.write((client) =>
        client.claudeCodeSignalDrop.upsert({
          where: { id },
          create: {
            id,
            harness,
            reason,
            droppedCount: BigInt(count),
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
          },
          update: {
            droppedCount: { increment: BigInt(count) },
            lastObservedAt: observedAt,
          },
        })
      );
    },
  };
}
