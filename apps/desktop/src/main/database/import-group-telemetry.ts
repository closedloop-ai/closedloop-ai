/**
 * ISS-6003 — per-group wall time for one `importSession`.
 *
 * The ISS-4410 bound reports only that a session's whole import exceeded
 * 120,000ms; it never says WHICH of the twelve record groups spent the time. On
 * a store where every source hit that bound (`parse 2932ms, import 120003ms`,
 * codex stuck at 0/2465 for eight days) the log therefore carried no signal a
 * maintainer could act on — the wedge was diagnosable only by attaching to a
 * developer's machine.
 *
 * This records each group's elapsed time and, on the way out, names the ones
 * that were actually slow. It is deliberately a REPORT, not a gate: nothing here
 * changes what is written or whether the import proceeds.
 *
 * It also carries the ISS-4572 EVICTION label, because the wedge this exists for
 * ends in an eviction rather than a clean finish: `importSessionIsolated` calls
 * {@link ImportGroupTimer.noteEviction} with the label whose write the
 * per-session timeout evicted, stops queuing further groups (an abandoned import
 * must not commit more, and the evicted transaction still holds the writer), and
 * reports. The evicted group is named in the line and always carries its
 * duration, however small — for a wedge it is the whole point of the line.
 *
 * {@link createImportGroupWriter} is the one place both concerns meet: it wraps
 * `prisma.write` so the clock starts on DISPATCH and an eviction is attributed to
 * the group that was holding the writer. It lives here rather than inline in
 * `write-core.ts` because it IS the measurement, and because that file is over
 * the size ceiling and shrink-only.
 */
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { WriteQueueCancelledError } from "./write-queue.js";

/**
 * Per-group threshold for inclusion in the slow-group report. A healthy group on
 * a large store commits in tens of milliseconds, so a group at or over this has
 * genuinely misbehaved rather than merely done a lot of work.
 */
export const SLOW_IMPORT_GROUP_LOG_MS = 1000;

/** Log prefix for the slow-group report, greppable in `main.log`. */
export const SLOW_IMPORT_GROUP_LOG_PREFIX = "sqlite import slow groups";

/** Field naming the group whose write was evicted (ISS-4572), when one was. */
export const EVICTED_IMPORT_GROUP_FIELD = "evicted";

export type ImportGroupTimer = {
  /** Run `fn` under the label, accumulating its wall time. Rethrows unchanged. */
  time<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /**
   * ISS-4572: record that `label`'s write was EVICTED by the per-session
   * timeout. First eviction wins — it is the one that abandoned the import.
   */
  noteEviction(label: string): void;
  /** True once a group was evicted, i.e. the import was abandoned mid-flight. */
  evicted(): boolean;
  /**
   * Emit the report for this import: when a group qualified as slow, or when the
   * import was evicted. Silent for a healthy import.
   */
  report(sessionId: string): void;
};

/**
 * Build a timer for one import. Durations ACCUMULATE per label: a couple of
 * groups (the artifact-link snapshots) legitimately run twice in a pass, and
 * their combined cost is what matters to a reader chasing a wedge.
 *
 * `now` is injected so the threshold and accumulation behavior can be driven
 * deterministically from tests instead of by real elapsed wall time.
 */
export function createImportGroupTimer(
  log: (message: string) => void,
  now: () => number = Date.now
): ImportGroupTimer {
  const durationsMs = new Map<string, number>();
  let evictedLabel: string | null = null;
  return {
    async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const startedAt = now();
      try {
        return await fn();
      } finally {
        durationsMs.set(
          label,
          (durationsMs.get(label) ?? 0) + (now() - startedAt)
        );
      }
    },
    noteEviction(label: string): void {
      evictedLabel ??= label;
    },
    evicted(): boolean {
      return evictedLabel !== null;
    },
    report(sessionId: string): void {
      const line = formatSlowImportGroups(sessionId, durationsMs, evictedLabel);
      if (line !== null) {
        log(line);
      }
    },
  };
}

/**
 * Build the "run one import group as a serialized write" verb for a single
 * import, rethrowing unchanged so every call site keeps its own failure contract
 * (the FK gate aborts, `runGroup` tolerates, the activity-metrics rollup
 * tolerates without flipping `incomplete`).
 *
 * ISS-6003: the clock starts on DISPATCH — inside the queued task — so a group is
 * never charged for the time this session spent waiting behind ANOTHER session's
 * transaction at the head of the shared writer queue. ISS-4572: an eviction is
 * attributed to `label`, which is what lets {@link ImportGroupTimer.report} name
 * the group that was holding the writer when the import was abandoned.
 */
export function createImportGroupWriter<TCtx>(input: {
  timer: ImportGroupTimer;
  prisma: Pick<DesktopPrisma, "write">;
  /** ISS-4572 owner token for the queue — the session id on the import path. */
  writeToken: string;
  ctx: TCtx;
}): <T>(
  label: string,
  group: (tx: Prisma.TransactionClient, ctx: TCtx) => Promise<T>
) => Promise<T> {
  return (label, group) =>
    input.prisma
      .write(
        (client) =>
          input.timer.time(label, () =>
            client.$transaction((tx) => group(tx, input.ctx))
          ),
        input.writeToken
      )
      .catch((error: unknown) => {
        if (error instanceof WriteQueueCancelledError) {
          input.timer.noteEviction(label);
        }
        throw error;
      });
}

/**
 * The report line, or `null` when every group was fast and nothing was evicted.
 *
 * Exported for direct testing: the formatting IS the contract here (a reader
 * chasing a wedge needs the slowest group named first, with its milliseconds),
 * and asserting it through a full import would be asserting a log call from
 * inside a mock rather than the string a maintainer will actually read.
 */
export function formatSlowImportGroups(
  sessionId: string,
  durationsMs: ReadonlyMap<string, number>,
  evictedLabel?: string | null
): string | null {
  const reported = [...durationsMs.entries()]
    .filter(
      ([label, ms]) => ms >= SLOW_IMPORT_GROUP_LOG_MS || label === evictedLabel
    )
    .sort(([, a], [, b]) => b - a);
  if (reported.length === 0 && !evictedLabel) {
    return null;
  }
  const total = [...durationsMs.values()].reduce((sum, ms) => sum + ms, 0);
  const fields = [`${SLOW_IMPORT_GROUP_LOG_PREFIX} ${sessionId}:`];
  if (evictedLabel) {
    fields.push(`${EVICTED_IMPORT_GROUP_FIELD}=${evictedLabel}`);
  }
  for (const [label, ms] of reported) {
    fields.push(`${label}=${ms}ms`);
  }
  fields.push(`(all groups ${total}ms)`);
  return fields.join(" ");
}
