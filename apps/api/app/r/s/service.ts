import { gunzipSync, gzipSync } from "node:zlib";
import { keys as analyticsKeys } from "@repo/analytics/keys";
import { isUuidV4 } from "@repo/api/src/types/onboarding-analytics";
import { isDesktopSessionToken } from "@repo/auth/desktop-session-jwt";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { resolveDesktopSessionContext } from "@/lib/auth/desktop-session-auth";
import { FixedWindowRateLimiter } from "@/lib/fixed-window-rate-limiter";

/**
 * Below Vercel's 4.5 MB function body limit, so a request near that limit is
 * refused here, where its size is logged, rather than by the platform, where it
 * is not (ISS-11944: a 413 is a finding, not a missing data point).
 */
export const DESKTOP_REPLAY_REQUEST_MAX_BYTES = 4 * 1024 * 1024;

/** Zip-bomb ceiling for the decompressed batch. */
export const DESKTOP_REPLAY_DECODED_MAX_BYTES = 64 * 1024 * 1024;

/** posthog-js `Compression.GZipJS`, sent as the `compression` query param. */
export const POSTHOG_GZIP_COMPRESSION = "gzip-js";

export const DesktopReplayRejection = {
  OverCap: "over_cap",
  DecodedOverCap: "decoded_over_cap",
  UnsupportedCompression: "unsupported_compression",
  Undecodable: "undecodable",
  InvalidBatch: "invalid_batch",
  OverBudget: "over_budget",
} as const;
export type DesktopReplayRejection =
  (typeof DesktopReplayRejection)[keyof typeof DesktopReplayRejection];

export type DesktopReplaySnapshotMeasurement = {
  wireBytes: number;
  decodedBytes: number;
  compression: string;
  events: number;
  snapshotItems: number;
  replaySessionId: string;
  sessionCount: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
};

// The batch is forwarded to PostHog. Its top level keeps only what posthog-js
// 1.372.6 sends on a `$snapshot` besides `$set`/`$set_once`, so a top-level
// token or distinct id a caller adds is dropped; `properties` and the snapshot
// items stay loose so the recording reaches PostHog intact. A timed flush
// replaces `timestamp` with `offset` (request-queue.js `_setFlushTimeout`); an
// unload sends `timestamp`.
const snapshotEventSchema = z.object({
  // The anonymous-ingest controls (ISS-11866): snapshots only, so `$identify`
  // and `$create_alias` are refused, under a v4-UUID distinct id.
  event: z.literal("$snapshot"),
  uuid: z.string().optional(),
  timestamp: z.string().optional(),
  offset: z.number().optional(),
  properties: z.looseObject({
    distinct_id: z.string().refine(isUuidV4),
    $session_id: z.string().min(1).max(128),
    $snapshot_data: z.array(
      z.looseObject({ timestamp: z.number().optional() })
    ),
  }),
});

// One install per batch: its distinct id keys the per-install budget.
const snapshotBatchSchema = z
  .array(snapshotEventSchema)
  .min(1)
  .refine((batch) =>
    batch.every(
      ({ properties }) =>
        properties.distinct_id === batch[0].properties.distinct_id
    )
  );

export type DesktopReplaySnapshotBatch = z.infer<typeof snapshotBatchSchema>;

export const desktopReplaySnapshotService = {
  measure(
    body: Buffer,
    compression: string | null
  ):
    | {
        ok: true;
        batch: DesktopReplaySnapshotBatch;
        measurement: DesktopReplaySnapshotMeasurement;
      }
    | { ok: false; reason: DesktopReplayRejection } {
    const decoded = decodeBatch(body, compression);
    if (!decoded.ok) {
      return decoded;
    }
    let parsed: DesktopReplaySnapshotBatch;
    try {
      const result = snapshotBatchSchema.safeParse(JSON.parse(decoded.text));
      if (!result.success) {
        return { ok: false, reason: DesktopReplayRejection.InvalidBatch };
      }
      parsed = result.data;
    } catch {
      return { ok: false, reason: DesktopReplayRejection.Undecodable };
    }
    return {
      ok: true,
      batch: parsed,
      measurement: {
        wireBytes: body.byteLength,
        decodedBytes: Buffer.byteLength(decoded.text),
        compression: compression ?? "none",
        ...summarizeBatch(parsed),
      },
    };
  },

  /** ISS-11946: the per-install request and byte budgets, in code. */
  consumeInstallBudget(
    distinctId: string,
    wireBytes: number,
    now = Date.now()
  ): boolean {
    return (
      desktopReplayInstallRequestBudget.attempt(distinctId, now) &&
      desktopReplayInstallByteBudget.attempt(distinctId, now, wireBytes)
    );
  },

  /**
   * ISS-12222 (DOC-39 §2: the API stamps identity, the client never asserts
   * it): the Clerk user id of the desktop access token the desktop main process
   * attaches to a signed-in install's replay requests, resolved the way
   * `withDesktopSessionAuth` resolves it for `/desktop/analytics`. Null, so the
   * install's `node_uuid` stays the distinct id, for no token or one that does
   * not verify or resolve: the replay is never refused for it (ISS-12222 AC4).
   */
  async resolveSignedInDistinctId(
    bearerToken: string | null
  ): Promise<string | null> {
    if (!(bearerToken && isDesktopSessionToken(bearerToken))) {
      return null;
    }
    try {
      const resolved = await resolveDesktopSessionContext(bearerToken);
      return resolved?.user.clerkId || null;
    } catch (error) {
      log.warn(DESKTOP_REPLAY_IDENTITY_UNRESOLVED_EVENT, {
        error: parseError(error),
      });
      return null;
    }
  },

  /**
   * ISS-11946 (ISS-11866 D5): forwards the batch to PostHog's `/s/` with the
   * deployment's project token injected into every event, so the desktop
   * client never holds one. A `signedInDistinctId` (ISS-12222) replaces the
   * install's `node_uuid` on every event.
   */
  async forward(
    batch: DesktopReplaySnapshotBatch,
    signedInDistinctId: string | null
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        reason: DesktopReplayForwardFailure;
        error: unknown;
        upstreamStatus?: number;
      }
  > {
    const { NEXT_PUBLIC_POSTHOG_KEY: token, NEXT_PUBLIC_POSTHOG_HOST: host } =
      analyticsKeys();
    if (!token) {
      return {
        ok: false,
        reason: DesktopReplayForwardFailure.Unconfigured,
        error: new Error("NEXT_PUBLIC_POSTHOG_KEY is unset"),
      };
    }
    const tokened = batch.map((event) => ({
      ...event,
      properties: {
        ...event.properties,
        token,
        ...(signedInDistinctId ? { distinct_id: signedInDistinctId } : {}),
      },
    }));
    const base = (host ?? POSTHOG_DEFAULT_INGEST_HOST).replace(
      TRAILING_SLASHES,
      ""
    );
    try {
      const response = await fetch(
        `${base}/s/?compression=${POSTHOG_GZIP_COMPRESSION}`,
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: new Uint8Array(gzipSync(JSON.stringify(tokened))),
          signal: AbortSignal.timeout(POSTHOG_FORWARD_TIMEOUT_MS),
        }
      );
      return response.ok
        ? { ok: true }
        : {
            ok: false,
            reason: DesktopReplayForwardFailure.Refused,
            error: new Error(`PostHog answered ${response.status}`),
            upstreamStatus: response.status,
          };
    } catch (error) {
      return {
        ok: false,
        reason: DesktopReplayForwardFailure.Unreachable,
        error,
      };
    }
  },
};

function decodeBatch(
  body: Buffer,
  compression: string | null
): { ok: true; text: string } | { ok: false; reason: DesktopReplayRejection } {
  if (compression === null) {
    return { ok: true, text: body.toString("utf8") };
  }
  if (compression !== POSTHOG_GZIP_COMPRESSION) {
    return { ok: false, reason: DesktopReplayRejection.UnsupportedCompression };
  }
  try {
    return {
      ok: true,
      text: gunzipSync(body, {
        maxOutputLength: DESKTOP_REPLAY_DECODED_MAX_BYTES,
      }).toString("utf8"),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof RangeError
          ? DesktopReplayRejection.DecodedOverCap
          : DesktopReplayRejection.Undecodable,
    };
  }
}

function summarizeBatch(
  batch: DesktopReplaySnapshotBatch
): Pick<
  DesktopReplaySnapshotMeasurement,
  | "events"
  | "snapshotItems"
  | "replaySessionId"
  | "sessionCount"
  | "firstEventAt"
  | "lastEventAt"
> {
  const sessionIds = new Set<string>();
  let snapshotItems = 0;
  let firstEventAt: number | null = null;
  let lastEventAt: number | null = null;
  for (const { properties } of batch) {
    sessionIds.add(properties.$session_id);
    snapshotItems += properties.$snapshot_data.length;
    for (const { timestamp } of properties.$snapshot_data) {
      if (timestamp === undefined) {
        continue;
      }
      firstEventAt = Math.min(firstEventAt ?? timestamp, timestamp);
      lastEventAt = Math.max(lastEventAt ?? timestamp, timestamp);
    }
  }
  return {
    events: batch.length,
    snapshotItems,
    replaySessionId: batch[0].properties.$session_id,
    sessionCount: sessionIds.size,
    firstEventAt,
    lastEventAt,
  };
}

/**
 * ISS-11946 per-install byte budget per window: one capped request's worth,
 * 34x the measured peak of 122,320 wire bytes a minute. Not set lower: the
 * sample is one developer workspace, the full DOM snapshot is 78% of that peak
 * window, and a lower budget would refuse a single request the body cap
 * (under Vercel's 4.5 MB limit) admits.
 * Re-derive as p99 x headroom from R1b's 7-day prod `wireBytes`.
 */
export const DESKTOP_REPLAY_INSTALL_MAX_BYTES_PER_WINDOW =
  DESKTOP_REPLAY_REQUEST_MAX_BYTES;

/**
 * ISS-11946 per-install requests per window. The measured peak is 10 in any
 * 60 s (stage pilot, Datadog `service:cl-api env:stage
 * "desktop_replay_snapshot_measured"`, 2026-10-05 17:00Z to 10-06 00:00Z: 81
 * requests, 3 sessions, 1 install). posthog-js 1.372.6 sends at most one
 * request per batch key per 3,000 ms flush (request-queue.js
 * DEFAULT_FLUSH_INTERVAL_MS), so 20 a minute; doubled for one retry per flush,
 * since the retry queue polls every 3 s and retries status 0 and 5xx
 * (retry-queue.js).
 */
export const DESKTOP_REPLAY_INSTALL_MAX_REQUESTS_PER_WINDOW = 40;

/** posthog-node's default ingestion host, for a deployment that sets none. */
export const POSTHOG_DEFAULT_INGEST_HOST = "https://us.i.posthog.com";

/** posthog-node's default request timeout, so a stalled PostHog answers 502. */
export const POSTHOG_FORWARD_TIMEOUT_MS = 10_000;

export const DesktopReplayForwardFailure = {
  Unconfigured: "posthog_unconfigured",
  Refused: "posthog_refused",
  Unreachable: "posthog_unreachable",
} as const;
export type DesktopReplayForwardFailure =
  (typeof DesktopReplayForwardFailure)[keyof typeof DesktopReplayForwardFailure];

export const desktopReplayInstallRequestBudget = new FixedWindowRateLimiter({
  maxRequests: DESKTOP_REPLAY_INSTALL_MAX_REQUESTS_PER_WINDOW,
});
export const desktopReplayInstallByteBudget = new FixedWindowRateLimiter({
  maxRequests: DESKTOP_REPLAY_INSTALL_MAX_BYTES_PER_WINDOW,
});

const TRAILING_SLASHES = /\/+$/;

export const DESKTOP_REPLAY_IDENTITY_UNRESOLVED_EVENT =
  "desktop_replay_identity_unresolved";
