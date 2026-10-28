import {
  SessionTraceCorrectionSourceKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
} from "@repo/api/src/types/agent-session";
import { z } from "zod";
import {
  isoDateSchema,
  truncatedMarkerLabelSchema,
} from "./desktop-agent-sessions-schema-primitives";

/**
 * ISS-7229 (#6406): the desktop payload's TRACE shapes, split out of
 * `desktop-agent-sessions-schema.ts` when that file crossed the 1,000-line
 * ceiling.
 *
 * A real seam rather than a slice at a line count: every schema here describes
 * the session TIMELINE — spans, markers, throttles, phases and the provenance
 * of each — and they are consumed together by `session-trace-source-reads.ts`
 * and `projections.ts`. Nothing else in the payload schema depends on them, so
 * they move as a unit and the parse module keeps only the session envelope.
 */

/**
 * ISS-5850: `startMs`/`endMs` are the absolute extent the producer's activity
 * bins tile — see `SessionSpan`, which carries the full rationale.
 *
 * OPTIONAL, and the `.optional()` is load-bearing in a way `.nullish()` would
 * not be: this schema is a plain `z.object`, so an UNDECLARED key is STRIPPED
 * rather than rejected (the route-wide non-strict posture at the top of this
 * file is deliberate — a strict boundary would drop a 200-session batch over
 * one unknown key). Stripping is the quieter failure: a producer that starts
 * emitting a field this schema was never taught loses it silently at ingest,
 * with nothing red anywhere. `desktop-agent-sessions-session-span-extent-schema.test.ts`
 * holds the compile-time keys-covered guard that makes the NEXT field added to
 * `SessionSpan` fail `tsc` instead.
 *
 * Not `.nonnegative().int()`: these are epoch instants, and the consumer
 * validates ordering itself (`resolveTimelineSourceExtent`) because a
 * half-stated or inverted extent must degrade to "unknown" rather than reject
 * the surrounding session.
 */
export const sessionSpanSchema = z.object({
  first: z.string().trim().min(1),
  last: z.string().trim().min(1),
  startMs: z.number().finite().optional(),
  endMs: z.number().finite().optional(),
});

export const sessionMarkerSchema = z.object({
  kind: z.enum(["commit", "pr", "fail", "frust", "prompt"]),
  x: z.number().finite().min(0).max(100),
  t: z.string().trim().min(1),
  label: truncatedMarkerLabelSchema,
  tl: z.number().int().nonnegative(),
  illustrative: z.boolean().optional(),
});

export const sessionThrottleSchema = z.object({
  x0: z.number().finite().min(0).max(100),
  t0: z.string().trim().min(1),
  t1: z.string().trim().min(1),
  durMin: z.number().finite().nonnegative(),
  tl: z.number().int().nonnegative(),
});

export const sessionTracePhaseSourceSchema = z.object({
  sourceType: z.enum(SessionTracePhaseSourceType),
  phaseKey: z.string().trim().min(1),
  label: z.string().trim().nullish(),
  startedAt: isoDateSchema,
  endedAt: isoDateSchema.nullish(),
});

export const sessionTraceThrottleSourceSchema = z.object({
  sourceType: z.enum(SessionTraceThrottleSourceType),
  provider: z.string().trim().min(1),
  observedAt: isoDateSchema,
  limitKind: z.string().trim().nullish(),
  statusCode: z.number().int().min(100).max(599).nullish(),
  errorCode: z.string().trim().nullish(),
  resetAt: isoDateSchema.nullish(),
  retryAfterSeconds: z.number().finite().nonnegative().nullish(),
});

export const sessionTraceCorrectionSourceSchema = z.object({
  kind: z.enum(SessionTraceCorrectionSourceKind),
  observedAt: isoDateSchema,
  label: z.string().trim().nullish(),
  sourceType: z.string().trim().nullish(),
});

export const sessionPhaseSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  dur: z.string().trim().min(1),
  cost: z.string().trim().min(1),
  cOut: z.number().finite().nonnegative(),
  cCache: z.number().finite().nonnegative(),
  cIn: z.number().finite().nonnegative(),
});

export const phaseLoopbackSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  label: z.string().trim().min(1),
  depth: z.number().finite().nonnegative(),
});
