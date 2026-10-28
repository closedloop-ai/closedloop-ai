import {
  BRANCH_FILE_DIFF_CLASS,
  DESKTOP_REPLAY_SNAPSHOT_PATH,
} from "@repo/api/src/types/desktop-session-replay-pilot";
import posthog, {
  type BeforeSendFn,
  Compression,
  type PostHogConfig,
  type QueuedRequestWithOptions,
  type RemoteConfig,
} from "posthog-js/dist/module.full.no-external";
import { z } from "zod";
import { ANALYTICS_REDACTION_MARKER } from "./sensitive-query-params";

/**
 * DOC-39 §2: the desktop replay client ships no project token; the proxy
 * injects the real one. posthog-js still needs a key to file its config under,
 * and it must not look like a project token (ISS-6367 token-surface scan).
 */
export const DESKTOP_REPLAY_PLACEHOLDER_TOKEN = "desktop-replay-keyless";

export type DesktopSessionReplayOptions = {
  /** The proxy origin plus its neutral path prefix (ISS-11866 D2/D7). */
  apiHost: string;
  /** A v4 UUID: the ingress refuses any other distinct id (ISS-11946). */
  distinctId: string;
  /**
   * ISS-12259: the renderer's route patterns with an id param, such as
   * `/sessions/:id`. A link `href` whose hash route matches one is recorded
   * with each id segment replaced by `ANALYTICS_REDACTION_MARKER`.
   */
  recordIdRoutes: readonly string[];
};

/**
 * ISS-11838: start the keyless, replay-only posthog-js in the desktop renderer
 * (ISS-11866 D1/D5), or resume it after {@link stopDesktopSessionReplay}. It
 * captures no product events, and its remote config is preloaded so it never
 * asks PostHog for one. A resume keeps the options of the first start, and
 * does nothing against any other `apiHost`: posthog-js queues every replay
 * batch under one key and sends a queue as one request to its first batch's
 * URL, so the batch a stop flushed would carry the next host's first batch
 * back to the old host. A resume records a new `$session_id` under the same
 * distinct id: the renderer restarts on every sign-in and sign-out, and the
 * ingress stamps a signed-in batch with the user's Clerk id, so one session
 * must not span both states (ISS-12222).
 */
export function startDesktopSessionReplay(
  options: DesktopSessionReplayOptions
): void {
  if (posthog.__loaded) {
    if (posthog.config.api_host === options.apiHost) {
      posthog.sessionManager?.resetSessionId();
      posthog.startSessionRecording();
    }
    return;
  }
  (
    globalThis as { _POSTHOG_REMOTE_CONFIG?: Record<string, unknown> }
  )._POSTHOG_REMOTE_CONFIG = {
    [DESKTOP_REPLAY_PLACEHOLDER_TOKEN]: {
      config: DESKTOP_REPLAY_REMOTE_CONFIG,
    },
  };
  posthog.init(DESKTOP_REPLAY_PLACEHOLDER_TOKEN, {
    api_host: options.apiHost,
    bootstrap: { distinctID: options.distinctId },
    persistence: "memory",
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    remote_config_refresh_interval_ms: 0,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    capture_heatmaps: false,
    capture_performance: false,
    rageclick: false,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    enable_recording_console_log: false,
    // ISS-11838 masking ruling: code views blocked, all other text and every
    // input masked.
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      blockSelector: DESKTOP_REPLAY_BLOCK_SELECTOR,
      recordHeaders: false,
      recordBody: false,
      // posthog-js passes the page URL it records (the rrweb Meta event and
      // its URL-change events) through this hook. The hash route can carry
      // what the user typed (`#/sessions?search=`) or a record id.
      maskCapturedNetworkRequestFn: (request) => ({
        ...request,
        name: request.name?.replace(URL_QUERY_AND_HASH, ""),
      }),
      // Per-event compression would hide the rrweb nodes from before_send,
      // which masks the attributes text masking does not reach.
      compress_events: false,
    },
    before_send: keepMaskedSnapshotsOnly(
      options.recordIdRoutes.map((pattern) => pattern.split("/"))
    ),
  } satisfies Partial<PostHogConfig>);
  dropDiscardedSnapshotsOnSend();
}

const DESKTOP_REPLAY_REMOTE_CONFIG = {
  supportedCompression: [Compression.GZipJS],
  hasFeatureFlags: false,
  autocapture_opt_out: true,
  capturePerformance: false,
  heatmaps: false,
  surveys: false,
  sessionRecording: {
    endpoint: DESKTOP_REPLAY_SNAPSHOT_PATH,
    consoleLogRecordingEnabled: false,
    recordCanvas: false,
  },
} satisfies Partial<RemoteConfig>;

/**
 * ISS-11838 masking ruling: rrweb masks text nodes only, so a session name in
 * a `title` or `aria-label` would otherwise leave readable.
 */
const MASKED_ATTRIBUTES = ["title", "aria-label"] as const;
const NON_WHITESPACE = /\S/g;
const URL_QUERY_AND_HASH = /[?#].*/s;
const jsonObjectSchema = z.record(z.string(), z.unknown());

function keepMaskedSnapshotsOnly(routes: RecordIdRoutes): BeforeSendFn {
  return (capture) =>
    capture?.event === "$snapshot"
      ? {
          ...capture,
          properties: {
            ...capture.properties,
            $snapshot_data: maskAttributeValues(
              capture.properties.$snapshot_data,
              routes
            ),
          },
        }
      : null;
}

/** Masks the attributes text masking does not reach, in snapshots and mutations. */
function maskAttributeValues(value: unknown, routes: RecordIdRoutes): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => maskAttributeValues(child, routes));
  }
  const object = jsonObjectSchema.safeParse(value);
  if (!object.success) {
    return value;
  }
  const masked = Object.fromEntries(
    Object.entries(object.data).map(([key, child]) => [
      key,
      maskAttributeValues(child, routes),
    ])
  );
  const attributes = jsonObjectSchema.safeParse(masked.attributes);
  if (attributes.success) {
    masked.attributes = maskNamedAttributes(attributes.data, routes);
  }
  return masked;
}

function maskNamedAttributes(
  attributes: Record<string, unknown>,
  routes: RecordIdRoutes
): Record<string, unknown> {
  const masked = { ...attributes };
  for (const name of MASKED_ATTRIBUTES) {
    const value = masked[name];
    if (typeof value === "string") {
      masked[name] = value.replace(NON_WHITESPACE, "*");
    }
  }
  if (typeof masked.href === "string") {
    masked.href = maskRecordIdSegments(masked.href, routes);
  }
  return masked;
}

/**
 * Stops recording. posthog-js flushes what it buffered while recording, then
 * sends nothing until the next start.
 */
export function stopDesktopSessionReplay(): void {
  posthog.stopSessionRecording();
}

/**
 * ISS-12257, on Perrin Upcott's ruling of 2026-10-08 ("Discard tail batch on
 * flip"): at a sign-in or sign-out, stops recording and drops every snapshot
 * recorded so far that has not left yet, instead of flushing it. Main
 * attaches the identity as a batch leaves, so a flushed tail would carry the
 * identity from the other side of the flip.
 */
export function discardDesktopSessionReplay(): void {
  if (!posthog.__loaded) {
    return;
  }
  posthog.stopSessionRecording();
  discardedThroughUuid = lastCapturedSnapshotUuid;
}

/**
 * ISS-12257: resolves once every batch already on the network has been
 * answered. posthog-js 1.372.6 compresses a batch before it calls `fetch`
 * (`lib/src/request.js:355-372`), so a batch it sent before the renderer heard
 * of a flip can reach main's request hook later still; the renderer waits for
 * these before main stops refusing replay. posthog-js answers every fetch,
 * aborting one still open at its own request timeout of 60 s
 * (`lib/src/request.js:247-252`, `:278`, `:284`, `:344`).
 */
export function waitForSentDesktopReplayBatches(): Promise<void> {
  return Promise.all(unansweredBatches).then(() => undefined);
}

/**
 * ISS-11838 masking ruling: transcript, diff and source views are blocked from
 * the recording. `.sd3-trace` is the session transcript region, `.st` the trace
 * shared with branch detail, `pre`/`code` every rendered code and diff line,
 * `table.font-mono` the line-numbered code and unified-diff tables, and
 * `BRANCH_FILE_DIFF_CLASS` the branch Files changed diff viewer.
 */
const DESKTOP_REPLAY_BLOCK_SELECTOR = `.sd3-trace, .st, pre, code, table.font-mono, .${BRANCH_FILE_DIFF_CLASS}`;

/** Batches handed to the network that posthog-js has not answered yet. */
const unansweredBatches = new Set<Promise<void>>();
/**
 * The largest snapshot UUID posthog-js has captured, sent or not: after a
 * clock rollback the newest one is smaller than those captured before it.
 */
let lastCapturedSnapshotUuid: string | null = null;
/** Snapshots up to this one were captured before the latest sign-in flip. */
let discardedThroughUuid: string | null = null;
const snapshotEventSchema = z.object({
  uuid: z.string(),
  event: z.literal("$snapshot"),
});

/**
 * Drops every snapshot captured before the latest discard, wherever posthog-js
 * holds it: the request queue, the retry queue, or the stop's own flush.
 *
 * posthog-js 1.372.6 stamps each event with a UUIDv7 as it captures it
 * (`lib/src/posthog-core.js:964`), all from one generator whose UUIDs only
 * increase unless the clock goes back ten seconds or more
 * (`lib/src/uuidv7.js:135-180`, `:223-233`), so their lowercase hex strings
 * sort in capture order. A larger clock rollback breaks that order, so the
 * cutoff is the largest UUID captured, and snapshots captured after the
 * discard but below it are dropped too; none is sent mislabelled.
 *
 * It sends every batch through `_send_request`: the request queue and the
 * retry queue (`lib/src/posthog-core.js:396`, `:782-788`,
 * `lib/src/retry-queue.js:97`) and the unload beacons
 * (`lib/src/retry-queue.js:190`). That is a public member of the `PostHog`
 * type (`dist/module.full.no-external.d.ts:3087`) but not a documented API, so
 * `desktop-session-replay.test.ts` fails if a discarded batch still leaves.
 */
function dropDiscardedSnapshotsOnSend(): void {
  posthog.on("eventCaptured", (event: unknown) => {
    const snapshot = snapshotEventSchema.safeParse(event);
    if (
      snapshot.success &&
      (lastCapturedSnapshotUuid === null ||
        snapshot.data.uuid > lastCapturedSnapshotUuid)
    ) {
      lastCapturedSnapshotUuid = snapshot.data.uuid;
    }
  });
  const send = posthog._send_request.bind(posthog);
  posthog._send_request = (request) => {
    const kept = withoutDiscardedSnapshots(request);
    if (kept) {
      send(willBeAnswered(kept) ? trackAnswer(kept) : kept);
    }
  };
}

/**
 * posthog-js sends nothing, so answers nothing, for a batch key the server has
 * rate-limited (`lib/src/posthog-core.js:756-758`), and never answers a beacon
 * (`lib/src/request.js:289-310`).
 */
function willBeAnswered(request: QueuedRequestWithOptions): boolean {
  return (
    request.transport !== "sendBeacon" &&
    !posthog.rateLimiter.isServerRateLimited(request.batchKey)
  );
}

function trackAnswer(
  request: QueuedRequestWithOptions
): QueuedRequestWithOptions {
  let answer: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  unansweredBatches.add(answered);
  return {
    ...request,
    callback: (response) => {
      unansweredBatches.delete(answered);
      answer();
      request.callback?.(response);
    },
  };
}

/** The request without discarded snapshots, or null when nothing is left to send. */
function withoutDiscardedSnapshots(
  request: QueuedRequestWithOptions
): QueuedRequestWithOptions | null {
  const { data } = request;
  if (!Array.isArray(data)) {
    return isDiscardedSnapshot(data) ? null : request;
  }
  const kept = data.filter((event) => !isDiscardedSnapshot(event));
  if (kept.length === data.length) {
    return request;
  }
  return kept.length === 0 ? null : { ...request, data: kept };
}

function isDiscardedSnapshot(event: unknown): boolean {
  const snapshot = snapshotEventSchema.safeParse(event);
  return (
    snapshot.success &&
    discardedThroughUuid !== null &&
    snapshot.data.uuid <= discardedThroughUuid
  );
}

/** Route patterns split on `/`, as `["", "sessions", ":id"]`. */
type RecordIdRoutes = readonly (readonly string[])[];

/** rrweb records `#/sessions/x` as the absolute `<page url>#/sessions/x`. */
const HASH_ROUTE_HREF = /^([^#]*#)([^?]*)(.*)$/s;

/** Replaces the id segments of a hash-route href, keeping the route shape and query. */
function maskRecordIdSegments(href: string, routes: RecordIdRoutes): string {
  const match = HASH_ROUTE_HREF.exec(href);
  if (!match) {
    return href;
  }
  const [, beforePath, path, query] = match;
  const segments = path.split("/");
  const route = routes.find(
    (pattern) =>
      pattern.length === segments.length &&
      pattern.every((part, index) =>
        part.startsWith(":") ? segments[index] !== "" : part === segments[index]
      )
  );
  if (!route) {
    return href;
  }
  const maskedPath = segments
    .map((segment, index) =>
      route[index].startsWith(":") ? ANALYTICS_REDACTION_MARKER : segment
    )
    .join("/");
  return `${beforePath}${maskedPath}${query}`;
}
