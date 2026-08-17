/**
 * 5-field cron evaluation with Claude-Code-style jitter and missed-tick
 * catch-up. Pure functions over a supplied `now`, so it is fully testable
 * without a clock and reproducible (no Math.random — jitter is a deterministic
 * hash of task id + fire slot).
 */
import cronParser from "cron-parser";

export type CronOpts = {
  /** IANA tz; empty/undefined = host local time. */
  timezone?: string;
};

/** Deterministic 0..1 fraction from a string (FNV-1a). Stable across processes. */
function hashFraction(seed: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < seed.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a hash — bitwise XOR is the algorithm; changing it breaks the deterministic jitter tests assert on.
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93);
  }
  // >>> 0 coerces to an unsigned 32-bit int before dividing by 2^32.
  // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a hash — the unsigned shift is load-bearing for the stable fraction.
  return (h >>> 0) / 0xff_ff_ff_ff;
}

function opts(o?: CronOpts): { tz?: string } {
  return o?.timezone ? { tz: o.timezone } : {};
}

export type CronValidation = {
  ok: boolean;
  error?: string;
};

export function validateCron(cron: string): CronValidation {
  try {
    cronParser.parseExpression(cron, { currentDate: new Date(0) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Next fire strictly after `from`. */
export function nextRun(cron: string, from: Date, o?: CronOpts): Date {
  const it = cronParser.parseExpression(cron, {
    currentDate: from,
    ...opts(o),
  });
  return it.next().toDate();
}

/** Most recent fire at or before `from`, or null if none in range. */
export function prevRun(cron: string, from: Date, o?: CronOpts): Date | null {
  // parseExpression.prev() is strictly-before; nudge forward 999ms so a fire
  // landing exactly on `from` counts as "at or before".
  const cursor = new Date(from.getTime() + 999);
  const it = cronParser.parseExpression(cron, {
    currentDate: cursor,
    ...opts(o),
  });
  try {
    return it.prev().toDate();
  } catch {
    return null;
  }
}

/** Seconds between the slot at `fire` and the following slot. */
function periodSeconds(cron: string, fire: Date, o?: CronOpts): number {
  const next = nextRun(cron, new Date(fire.getTime() + 1000), o);
  return Math.max(1, Math.round((next.getTime() - fire.getTime()) / 1000));
}

/**
 * Claude-Code-style jitter, in milliseconds, added AFTER a scheduled slot:
 * a recurring fire may land up to min(10% of period, 15 min) late. Deterministic
 * per (taskId, slot) so it does not reshuffle every tick.
 */
export function jitterMs(
  taskId: string,
  fire: Date,
  cron: string,
  o?: CronOpts
): number {
  const periodSec = periodSeconds(cron, fire, o);
  const capSec = Math.min(periodSec * 0.1, 15 * 60);
  const frac = hashFraction(`${taskId}@${fire.toISOString()}`);
  return Math.round(frac * capSec * 1000);
}

export type DueInput = {
  taskId: string;
  cron: string;
  now: Date;
  /** Last time this task actually fired, or null if never. */
  lastRunAt: Date | null;
  catchUp: boolean;
  timezone?: string;
  /**
   * How stale a missed slot may be and still fire when catchUp is false
   * (guards against firing an ancient slot on first boot). Default 90s ≈ 3 ticks.
   */
  catchUpGraceSec?: number;
};

export type DueResult = {
  due: boolean;
  /** The slot this decision is about (for logging / marking lastRunAt). */
  slot: Date | null;
  reason: "due" | "no-slot" | "jitter-pending" | "already-ran" | "stale-missed";
};

/**
 * Decide whether a task should fire on this tick. Catch-up falls out naturally:
 * if a slot was missed while asleep, prevRun(now) is that slot and lastRunAt
 * precedes it, so it is due — unless catchUp is off and the slot is stale.
 */
export function computeDue(input: DueInput): DueResult {
  const o: CronOpts = { timezone: input.timezone };
  const slot = prevRun(input.cron, input.now, o);
  if (!slot) {
    return { due: false, slot: null, reason: "no-slot" };
  }

  const fireAt = slot.getTime() + jitterMs(input.taskId, slot, input.cron, o);
  if (input.now.getTime() < fireAt) {
    return { due: false, slot, reason: "jitter-pending" };
  }
  if (input.lastRunAt && input.lastRunAt.getTime() >= slot.getTime()) {
    return { due: false, slot, reason: "already-ran" };
  }
  if (!input.catchUp) {
    // Measure staleness from the JITTERED fire time, not the raw cron slot: a
    // non-catch-up task stays `jitter-pending` until `fireAt`, so anchoring the
    // grace window on `slot` would make any task whose deterministic jitter
    // exceeds the grace window (e.g. an hourly task can jitter up to 6 min)
    // return `stale-missed` the instant it becomes eligible, and it would never
    // run. `fireAt` is the intended fire instant, so grace applies from there.
    const graceSec = input.catchUpGraceSec ?? 90;
    if (input.now.getTime() - fireAt > graceSec * 1000) {
      return { due: false, slot, reason: "stale-missed" };
    }
  }
  return { due: true, slot, reason: "due" };
}
