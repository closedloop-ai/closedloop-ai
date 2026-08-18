/**
 * The "Switzerland" cascade: walk a configured, reorderable list of (harness,
 * model) steps, giving each a fresh full timeout window, treating a stall as a
 * fall-through to the next engine, and retrying only genuine transient
 * API/network errors with backoff. Cascade order is DATA (a list of steps), not
 * code. Backward compatible: a bare harness-name string is accepted as a step
 * with no model (⇒ that harness's default model). This is the single home for
 * what the legacy `run_llm_phase()` did across the bash scripts.
 */
import {
  type CascadeAttempt,
  type CascadeStep,
  cascadeStepSchema,
  type HarnessName,
  resolveModel,
} from "../model.js";
import { detectElicitation } from "./elicitation.js";
import { defaultRegistry, type HarnessRegistry } from "./index.js";
import type { Harness, RunOpts } from "./types.js";

/**
 * A cascade entry as callers may supply it: either a normalized `(harness,
 * model?)` step, or the backward-compatible bare harness-name string (or
 * `"harness:model"` shorthand) that `cascadeStepSchema` normalizes to a step.
 */
export type CascadeEntry = CascadeStep | HarnessName | string;

/** Normalize a caller-supplied cascade to `(harness, model?)` steps. */
function normalizeCascade(cascade: readonly CascadeEntry[]): CascadeStep[] {
  return cascade.map((entry) => cascadeStepSchema.parse(entry));
}

/** Substrings that mark a retryable transient failure (from the legacy bash). */
const TRANSIENT = [
  "socket",
  "api error",
  "connection error",
  "econnreset",
  "etimedout",
  "rate limit",
  "429",
  "500",
  "502",
  "503",
  "504",
];

function isTransient(outputTail: string): boolean {
  const t = outputTail.toLowerCase();
  return TRANSIENT.some((m) => t.includes(m));
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Bounded per-attempt wall-clock default (20m) applied at the SHARED cascade
 * entry point (FEA-4012) so every caller — the audit pass, the nightly review
 * pass, and custom scheduled tasks — hands each harness a finite window. A
 * harness that stalls (or ends awaiting input the runner can't detect) is then
 * SIGTERM/SIGKILLed and cascades, rather than hanging the run forever. Callers
 * that pass an explicit positive value override it; an explicit `0` opts back
 * into a truly unbounded window (`undefined` ⇒ this default).
 */
export const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Resolve the per-attempt timeout: `undefined` ⇒ the bounded default; an
 * explicit `0` (or any non-positive value) ⇒ unbounded (`0`); a positive value
 * is honored as-is. Keeps the "explicit 0 = unbounded" opt-out contract while
 * making the SAFE bounded window the default at every entry point.
 */
function resolvePerAttemptTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PER_ATTEMPT_TIMEOUT_MS;
  }
  return value > 0 ? value : 0;
}

export interface CascadeOpts extends Omit<RunOpts, "timeoutMs" | "model"> {
  /**
   * Ordered `(harness, model?)` steps to try; first that succeeds wins. Bare
   * harness-name strings are accepted for backward compatibility and normalize
   * to a step with no model (⇒ that harness's default model).
   */
  cascade: readonly CascadeEntry[];
  /**
   * Fresh wall-clock budget handed to EACH engine. `undefined` ⇒ the bounded
   * {@link DEFAULT_PER_ATTEMPT_TIMEOUT_MS} default (FEA-4012); an explicit `0`
   * opts back into an unbounded window; a positive value overrides the default.
   */
  perAttemptTimeoutMs?: number;
  /**
   * Opt into treating a clean-exit attempt that ended by ELICITING input (asking
   * the operator a question / interviewing instead of doing the work) as a FAILED
   * attempt that cascades onward (FEA-4012). Only the audit/review passes — whose
   * sole job is to produce a findings file, and which run non-interactively so a
   * question can never be answered — enable this. Custom tasks leave it off (their
   * prompt may legitimately end by asking or drafting a question), so `undefined`/
   * `false` keeps the historical "a clean exit is a success" behavior for them.
   */
  rejectElicitation?: boolean;
  /** Transient-error retries within a single engine (default 3). */
  maxTransientRetries?: number;
  /** Registry override (tests inject mock harnesses). */
  registry?: HarnessRegistry;
  /** Backoff sleeper (tests inject a no-op). Default: attempt*30s. */
  sleep?: (ms: number) => Promise<void>;
}

export type CascadeResult = {
  ok: boolean;
  harnessUsed: HarnessName | null;
  attempts: CascadeAttempt[];
};

type EngineRun = {
  harness: Harness;
  name: HarnessName;
  /** Resolved model this engine drives with (step model or harness default). */
  model: string;
  opts: CascadeOpts;
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
  /** Shared trail — every attempt (success/timeout/failed) is appended here. */
  attempts: CascadeAttempt[];
  /** True when at least one more cascade step follows this engine. */
  hasNextStep: boolean;
};

/** Note recorded on an attempt reclassified as an elicitation (FEA-4012). */
function elicitationNote(hasNextStep: boolean): string {
  return hasNextStep
    ? "elicited input instead of working — cascading to next harness"
    : "elicited input instead of working — no harness left to cascade to";
}

/**
 * Drive a single engine: try up to `maxRetries` times, retrying only transient
 * failures with backoff. A stall (`timedOut`) hands a fresh window to the next
 * engine without retrying this one. Returns true once this engine succeeds.
 */
async function runEngine(run: EngineRun): Promise<boolean> {
  const {
    harness,
    name,
    model,
    opts,
    maxRetries,
    sleep,
    attempts,
    hasNextStep,
  } = run;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const startedAt = new Date().toISOString();
    const res = await harness.run({
      ...opts,
      model,
      timeoutMs: opts.perAttemptTimeoutMs,
    });

    if (res.ok) {
      // FEA-4012: an audit/review harness that exits cleanly but ended by
      // ELICITING — asking a clarifying question / interviewing the operator
      // instead of doing the work — is not a live success: the run is
      // non-interactive (stdin is closed), so nothing can answer, and treating
      // it as success would abandon the session awaiting input. Reclassify as a
      // FAILED attempt so the cascade steers to the next harness — bounded
      // progress, never a hang. Guarded by `rejectElicitation` so custom tasks
      // (which may legitimately end by asking) keep the historical behavior.
      if (opts.rejectElicitation && detectElicitation(res.outputTail)) {
        attempts.push({
          harness: name,
          model,
          outcome: "failed",
          startedAt,
          durationMs: res.durationMs,
          exitCode: res.exitCode,
          note: elicitationNote(hasNextStep),
        });
        return false;
      }
      attempts.push({
        harness: name,
        model,
        outcome: "success",
        startedAt,
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        note: "",
      });
      return true;
    }

    if (res.timedOut) {
      // A stall does not retry the same engine — hand a FRESH window to the next.
      attempts.push({
        harness: name,
        model,
        outcome: "timeout",
        startedAt,
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        note: `timed out (${opts.perAttemptTimeoutMs}ms)`,
      });
      return false;
    }

    const transient = isTransient(res.outputTail);
    attempts.push({
      harness: name,
      model,
      outcome: "failed",
      startedAt,
      durationMs: res.durationMs,
      exitCode: res.exitCode,
      note: transient
        ? `transient (attempt ${attempt}/${maxRetries})`
        : "non-transient failure",
    });
    if (transient && attempt < maxRetries) {
      await sleep(attempt * 30_000);
      continue;
    }
    // Non-transient, or retries exhausted → next engine.
    return false;
  }
  return false;
}

export async function runCascade(opts: CascadeOpts): Promise<CascadeResult> {
  const registry = opts.registry ?? defaultRegistry;
  const sleep = opts.sleep ?? realSleep;
  const maxRetries = opts.maxTransientRetries ?? 3;
  const attempts: CascadeAttempt[] = [];
  // FEA-4012: resolve the bounded per-attempt window ONCE at the shared entry
  // point so every caller (audit/review/custom) hands each harness a finite
  // budget; `undefined` ⇒ the default, explicit `0` stays unbounded. The
  // normalized opts are what each engine drives with.
  const engineOpts: CascadeOpts = {
    ...opts,
    perAttemptTimeoutMs: resolvePerAttemptTimeoutMs(opts.perAttemptTimeoutMs),
  };

  const steps = normalizeCascade(opts.cascade);
  if (steps.length === 0) {
    return { ok: false, harnessUsed: null, attempts };
  }

  for (const [index, step] of steps.entries()) {
    const name = step.harness;
    const model = resolveModel(step);
    const harness: Harness | undefined = registry[name];
    const startedAt = new Date().toISOString();
    const hasNextStep = index < steps.length - 1;
    if (!harness) {
      attempts.push({
        harness: name,
        model,
        outcome: "skipped",
        startedAt,
        durationMs: 0,
        exitCode: null,
        note: "unknown harness",
      });
      continue;
    }
    if (!(await harness.isAvailable())) {
      attempts.push({
        harness: name,
        model,
        outcome: "skipped",
        startedAt,
        durationMs: 0,
        exitCode: null,
        note: "not on PATH",
      });
      continue;
    }

    const succeeded = await runEngine({
      harness,
      name,
      model,
      opts: engineOpts,
      maxRetries,
      sleep,
      attempts,
      hasNextStep,
    });
    if (succeeded) {
      return { ok: true, harnessUsed: name, attempts };
    }
  }

  return { ok: false, harnessUsed: null, attempts };
}
