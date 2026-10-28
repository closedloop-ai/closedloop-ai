import { z } from "zod";

// Its own module so `keys.ts` can declare `DD_LOGS_MIN_LEVEL` and
// `DD_LOGS_SAMPLE_RATE` without importing `log.ts`, which imports `keys.ts` and
// runs side effects at load (ISS-12265).

export const LogLevel = {
  Debug: "debug",
  Info: "info",
  Warn: "warn",
  Error: "error",
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** The lowest level `log.*` emits. Unset emits every level. */
export const logMinLevelSchema = z.enum(LogLevel);

/**
 * The fraction of log calls `log.*` emits, 0 to 1. Unset emits all.
 * Not `z.coerce.number()`: it reads a whitespace-only value as 0 (zod 4.3.6),
 * which would silence every log call.
 */
export const logSampleRateSchema = z
  .string()
  .trim()
  .min(1)
  .transform(Number)
  .pipe(z.number().min(0).max(1));

/**
 * Entry key carrying `DD_LOGS_SAMPLE_RATE` on each kept call when it is below
 * 1, so a sampled count can be scaled back up. Not `sampleRate`: the
 * `telemetry.tracing_initialized` call already sends that key with the trace
 * sample rate.
 */
export const LOG_SAMPLE_RATE_KEY = "logSampleRate";
