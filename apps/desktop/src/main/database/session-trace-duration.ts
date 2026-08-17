import { computeSessionTiming } from "../../shared/session-timing.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";

/**
 * The subset of a trace timeline row the duration projection reads. The full
 * `TraceTimelineRow` (in `session-trace.ts`) carries more, but the wall / active
 * / waiting-on-user timing only needs the event role and its timestamp.
 */
type DurationTimelineRow = {
  eventType: string;
  createdAt: string;
};

/**
 * FEA-4275: the wall / active / waiting-on-user duration projection for a
 * session's Duration row, extracted from `session-trace.ts` (a shrink-only
 * grandfathered file) into its own module.
 *
 * Emits the three components as pre-formatted duration strings. `waitingUser`
 * (time the agent spent waiting on the person) is emitted as a CLEAN duration,
 * with no label baked into the value — baking one in is what produced the
 * doubled "41s idle idle". The display authority that used to apply the label
 * (`resolveSessionDurationBreakdown`) is GONE: ISS-5131 retired the Duration
 * row's sub-facts, so nothing renders `activeAgent`/`waitingUser` today. The
 * clean-value contract still holds, because it is what `parseTraceDurationMs`
 * reads and what any surface re-presenting these (ISS-4571) will inherit.
 *
 * ISS-4569: `activeAgent`/`waitingUser` distinguish a MEASURED zero from an
 * UNMEASURED value, because they are different facts and this is the only layer
 * that still knows which one it holds. A measured zero emits `"0s"`; `null` is
 * reserved for "nothing to measure", which includes a trace whose rows all carry
 * unparseable timestamps — presence of a row is not evidence of a measurement.
 * Both were previously `null`, which handed
 * every consumer one value for two facts: a session that genuinely spent 0s
 * waiting on the person read as unknown, and the components stopped reconciling
 * against the `wallClock` they are the sub-facts of — the reconciliation
 * FEA-4275 set out to restore. `parseTraceDurationMs`
 * (`packages/api/src/utils/trace-duration.ts`), the reader on the other side of
 * this contract, already keeps the two apart: `"0s"` parses to `0`, absent
 * parses to `null`.
 *
 * BOTH cases still emit a PRESENT key rather than an omitted field, so the
 * FEA-3427 patch semantics are untouched by that split: the cloud patch
 * preserves omitted trace fields, so omitting a recomputed value on reimport
 * would leave a stale nonzero duration stuck. `"0s"` overwrites it as any other
 * duration string would, and `null` clears it (the field is nullable on the
 * contract). `wallClock` stays omitted when its bounds are unresolvable — there
 * is no stale "measured zero wall" to clear.
 */
export function buildTraceDurationFields(input: {
  // FEA-3427: startMs/endMs are resolved once by buildSessionTraceSyncFields and
  // shared with buildTraceActivityFields — do not recompute resolveTraceEndMs.
  startMs: number;
  endMs: number;
  timelineRows: readonly DurationTimelineRow[];
}): Pick<SyncedAgentSession, "activeAgent" | "waitingUser" | "wallClock"> {
  const { startMs, endMs } = input;
  const fields: Pick<
    SyncedAgentSession,
    "activeAgent" | "waitingUser" | "wallClock"
  > = {};
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    fields.wallClock = formatTraceDuration(endMs - startMs);
  }
  // ISS-4569: a row is only a MEASURABLE row if its timestamp parses.
  // `createdAt` is a bare `string` off persisted SQLite rows and folded
  // `metadata.messages` entries — nothing upstream of here validates it — and
  // `computeSessionTiming` silently skips a gap that computes to NaN. So an
  // unparseable row contributes nothing to either sum yet would still count as
  // evidence under a raw-length discriminator, letting an all-malformed trace
  // assert a measured `"0s"` over data that could not be measured at all. Drop
  // them once, up front, and both the sums and the discriminator below run over
  // the same surviving rows: a mixed trace still measures over its parseable
  // ones, an all-malformed trace correctly reports unmeasured.
  const timingRows = input.timelineRows
    .filter((row) => Number.isFinite(Date.parse(row.createdAt)))
    .map((row) => ({
      eventType: row.eventType,
      createdAt: row.createdAt,
    }));
  // FEA-3582: clamp the active/idle gap sum to the same wall window
  // [startMs, endMs] used for `wallClock`, so `activeAgent` (and `waitingUser`)
  // can never exceed wall time. Timeline rows are drawn from metadata.messages +
  // hook events whose timestamps can fall before the declared `startedAt` or
  // past the resolved last-activity end (e.g. folded concurrent-subagent
  // events); without clamping their out-of-window gaps inflated active time
  // above wall (2h 57m active on a 2h 51m session, session 019f7d4c).
  const timing = computeSessionTiming(timingRows, { startMs, endMs });
  // ISS-4569: the measured-vs-unmeasured discriminator. `computeSessionTiming`
  // returns a bare `0` for both "the gaps summed to zero" and "there were no
  // rows to sum", so the honest signal is upstream of it: with at least one
  // PARSEABLE timeline row the sum is a REAL measurement over real data (a
  // session with a single row, or with no human turn after an agent turn, has
  // genuinely spent 0s in that bucket); with none there is nothing to measure
  // and the answer is unknown. Deliberately NOT a `> 0` check on the sums
  // themselves — that is the conflation being removed.
  const measured = timingRows.length > 0;
  fields.activeAgent = measured
    ? formatTraceDuration(timing.activeAgentMs)
    : null;
  fields.waitingUser = measured
    ? formatTraceDuration(timing.waitingUserMs)
    : null;
  return fields;
}

/**
 * Render a duration in ms as a compact `Ns` / `Nm` / `Nh Nm` string — the format
 * of the sync payload's `wallClock` / `activeAgent` / `waitingUser` fields.
 *
 * ISS-5135: its second in-repo caller (the wall-clock resync candidate check, which
 * rendered both anchors to compare them) is deleted, so nothing imports this symbol
 * today. The `export` STAYS deliberately: this is the producer side of a
 * cross-package format contract that `packages/api/src/utils/trace-duration.ts`
 * documents and parses against by name, and `test/e2e/sessions-duration-wallclock-
 * parity.spec.ts` pins end to end. Keep the output shape stable, or update that
 * parser in the same change.
 */
export function formatTraceDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
