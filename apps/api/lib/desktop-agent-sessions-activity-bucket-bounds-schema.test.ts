/**
 * #4949 review: the producer's bin bounds SURVIVE the sync ingress.
 *
 * `activityBucketSchema` is a plain `z.object`, which STRIPS keys it does not
 * declare. So the two lines declaring `binStartMs`/`binEndMs` are the only thing
 * carrying the producer's clock across this boundary — delete them and every
 * synced bucket arrives without bounds, `hasProducerBinBounds` refuses the strip,
 * and the entire cloud population silently drops back to the ordinal bars. That
 * is a total loss of the clock projection with nothing red anywhere: the
 * renderer's own suites build their fixtures in-process and never cross this
 * schema, so they keep passing.
 *
 * This file is that missing boundary. The round-trip below fails the moment the
 * declaration goes, and `ACTIVITY_BUCKET_WIRE_KEYS` fails `tsc` the moment the
 * shape gains a field this schema has not been taught.
 *
 * DB-free: exercises only `parseDesktopAgentSessionsPayload` (the pure ingress
 * contract), matching its sibling schema suites.
 */
import type { ActivityBucket } from "@repo/api/src/types/activity-bucket";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  activityBucketSchema,
  parseDesktopAgentSessionsPayload,
} from "./desktop-agent-sessions-schema";

const AGENT_SESSION_SYNC_SCHEMA_VERSION = 2 as const;

const BIN_START_MS = Date.UTC(2026, 5, 10, 9, 0, 0);
const BIN_END_MS = Date.UTC(2026, 5, 10, 9, 5, 0);

/**
 * Every wire field of an {@link ActivityBucket}, mapped to the schema's own shape.
 *
 * `key` is excluded because it is a RENDER identity, minted locally for React and
 * never sent — the one field of the type that is deliberately not on the wire.
 *
 * The value of this map is entirely in its TYPE: `Record<keyof …, …>` over
 * `activityBucketSchema.shape` means a field added to `ActivityBucket` without a
 * matching schema entry is a compile error here, rather than a key silently
 * stripped at ingress and a feature that quietly does nothing in production.
 */
const ACTIVITY_BUCKET_WIRE_KEYS: Record<
  keyof Omit<ActivityBucket, "key">,
  unknown
> = activityBucketSchema.shape;

function buildPayload(bucket: Record<string, unknown>): unknown {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000001",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "sess-1",
        status: "active",
        startedAt: "2026-06-10T10:00:00.000Z",
        updatedAt: "2026-06-10T11:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
        activityBuckets: [
          {
            label: "9:00 AM",
            cIn: 1,
            cOut: 0.5,
            cCache: 0.5,
            total: 2,
            toolStart: 1,
            tl0: 0,
            byModel: { "gpt-5.5": { cIn: 1, cOut: 0.5, cCache: 0.5 } },
            ...bucket,
          },
        ],
      },
    ],
  };
}

/**
 * The parsed bucket, or a thrown failure naming why the payload was rejected.
 *
 * Throws rather than asserting: an assertion buried in a helper is one that can
 * silently not run, and the interesting expectations all belong to the bucket it
 * returns.
 */
function parseFirstBucket(bucket: Record<string, unknown>) {
  const parsed = parseDesktopAgentSessionsPayload(buildPayload(bucket));
  if (!parsed.ok) {
    throw new Error(`payload did not parse: ${JSON.stringify(parsed)}`);
  }
  return parsed.payload.sessions[0].activityBuckets?.[0];
}

describe("desktop sync schema — activity-bucket producer bin bounds (#4949)", () => {
  it("carries a bin's own bounds through the ingress unchanged", () => {
    const bucket = parseFirstBucket({
      binStartMs: BIN_START_MS,
      binEndMs: BIN_END_MS,
    });

    // The falsifier for the whole feature: undeclared keys are STRIPPED, so this
    // is red the moment the schema stops declaring them — which is the only
    // signal that the clock projection has been disabled cloud-wide.
    expect(bucket?.binStartMs).toBe(BIN_START_MS);
    expect(bucket?.binEndMs).toBe(BIN_END_MS);
  });

  it("preserves omission for a desktop build that predates the bounds", () => {
    const bucket = parseFirstBucket({});

    // Absent, NOT null: the renderer reads absence as "this bin has no usable
    // clock" and keeps the strip on its ordinal bars. A `null` would be a value
    // an older reader has to re-interpret.
    expect(bucket).toBeDefined();
    expect(bucket?.binStartMs).toBeUndefined();
    expect(bucket?.binEndMs).toBeUndefined();
    expect(Object.hasOwn(bucket ?? {}, "binStartMs")).toBe(false);
  });

  it("accepts a bucket carrying only one of the two bounds", () => {
    // Skew must never hard-fail the batch: a half-stamped bucket still validates,
    // and the renderer's own gate is what declines to project it.
    const bucket = parseFirstBucket({ binStartMs: BIN_START_MS });

    expect(bucket?.binStartMs).toBe(BIN_START_MS);
    expect(bucket?.binEndMs).toBeUndefined();
  });

  it("rejects a non-finite bound rather than storing it", () => {
    // `NaN` fails every comparison downstream, so it would put `NaN` cost into a
    // column. JSON cannot carry it, but a hand-built or future producer can.
    const parsed = parseDesktopAgentSessionsPayload(
      buildPayload({
        binStartMs: Number.POSITIVE_INFINITY,
        binEndMs: BIN_END_MS,
      })
    );

    expect(parsed.ok).toBe(false);
  });

  it("declares a schema entry for every wire field of the bucket shape", () => {
    // The runtime half of the compile-time guard above: names the two fields
    // explicitly so a reader sees WHICH keys the type check is protecting.
    expect(Object.keys(ACTIVITY_BUCKET_WIRE_KEYS)).toEqual(
      expect.arrayContaining(["binStartMs", "binEndMs"])
    );
  });
});
