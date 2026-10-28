/**
 * Bounded HTTP timeouts for every AWS SDK client in this repo (ISS-7016).
 *
 * The SDK v3 Node request handler ships with every timeout disabled and retries
 * 3 times, so a client constructed without a `requestHandler` waits on a hung
 * socket forever. Whatever awaits that call inherits the unbounded wait — a
 * request path blocks until the platform kills it, a cron pass burns its whole
 * budget on one dead connection.
 *
 * Getting the bound to actually ABORT takes two options that are easy to
 * confuse, so they are set here once rather than copied per client:
 *
 * - `socketTimeout` is the socket INACTIVITY bound and is the one that
 *   destroys the request. A transfer that keeps making progress is never cut
 *   off by it, no matter how long it runs. It must stay under
 *   {@link MAX_EFFECTIVE_IDLE_TIMEOUT_MS} — see that constant.
 * - `requestTimeout` is a TOTAL-ELAPSED bound and, on its own, only logs a
 *   warning and lets the request continue. It aborts only when paired with
 *   `throwOnRequestTimeout` — see `NodeHttpHandlerOptions` in `@smithy/types`
 *   ("users must also opt-in for request timeout thrown errors"), and
 *   `setRequestTimeout` in `@smithy/node-http-handler`.
 *
 * Passing `requestTimeout` alone — the shape that reads like a bound and is
 * not one — is exactly the trap this module exists to keep a caller out of.
 */

/**
 * The `requestHandler` config an AWS SDK client constructor receives. Declared
 * structurally rather than importing `NodeHttpHandlerOptions`, so this module
 * needs no direct `@smithy/node-http-handler` dependency.
 */
export type BoundedRequestHandlerConfig = {
  connectionTimeout: number;
  socketTimeout: number;
  requestTimeout?: number;
  throwOnRequestTimeout?: boolean;
};

/**
 * Ceiling (exclusive) on any {@link RequestBounds.idleTimeoutMs}.
 *
 * `setSocketTimeout` in `@smithy/node-http-handler` registers the idle listener
 * immediately only when the timeout is under 6000 ms. At or above that it defers
 * registration by 3s — and `handle()` clears every pending timer the moment the
 * response resolves, which happens as soon as the response HEADERS arrive. So a
 * 6s-or-longer idle bound on a response whose headers come back promptly is
 * never armed at all, and a body that then stalls hangs forever: exactly the
 * failure this module exists to prevent, wearing the costume of a fix.
 *
 * Measured against @smithy/node-http-handler 4.4.14 with a server that sends
 * headers, writes one chunk, and stalls: 5000 aborts at ~5.0s, 6000 and 30_000
 * never settle.
 */
export const MAX_EFFECTIVE_IDLE_TIMEOUT_MS = 6000;

/** The per-caller deadlines {@link boundedRequestHandler} translates. */
export type RequestBounds = {
  /**
   * Budget for establishing the connection. This timer also covers waiting for
   * a free socket out of the keep-alive agent, so a client that fans out past
   * the SDK's default `maxSockets` needs enough room here for its own queueing,
   * not just for the TCP handshake. Must be positive — see
   * {@link boundedRequestHandler}.
   */
  connectionTimeoutMs: number;
  /**
   * Abort once this long passes with no bytes moving on the socket. Must be
   * under {@link MAX_EFFECTIVE_IDLE_TIMEOUT_MS} or the SDK never arms it.
   */
  idleTimeoutMs: number;
  /**
   * Optional total-elapsed ceiling for the whole request and response. Omit it
   * for callers that stream a body of unbounded size — for those, elapsed time
   * is not evidence of a stall and {@link idleTimeoutMs} is the real bound.
   * Omitting it is the way to declare "no ceiling"; 0 is rejected, because it
   * reads as one and is not.
   */
  totalTimeoutMs?: number;
};

/**
 * Small request/response calls: KMS Encrypt/Decrypt, ECS RunTask/StopTask.
 * These answer in well under a second and are awaited on the request path under
 * a 60s ceiling, so they take a total-elapsed ceiling as well as an idle one:
 * worst case per attempt is 3s + 10s, and the SDK's 3 attempts still fit.
 *
 * The idle bound carries its own weight even here, because the elapsed ceiling
 * is cleared as soon as the response headers arrive — a reply that stalls
 * mid-body afterwards is bounded by nothing else.
 */
export const CONTROL_PLANE_BOUNDS: RequestBounds = {
  connectionTimeoutMs: 3000,
  idleTimeoutMs: 5000,
  totalTimeoutMs: 10_000,
};

/**
 * Calls that stream an object body: S3 GETs and PUTs of conversation state,
 * work snapshots, transcripts, attachments, and catalog bundles.
 *
 * No total-elapsed ceiling — a large healthy transfer legitimately outlives any
 * number we could pick, and cutting it off mid-stream would be a new failure
 * rather than a bound. The idle timeout is the whole bound here, so it has to
 * be one the SDK actually arms: five seconds of a stream moving zero bytes is a
 * stall, not backpressure. The wider connect budget is for socket acquisition —
 * these clients fan out across a shared keep-alive agent, so a queued request
 * waits on the connect timer.
 */
export const STREAMING_BOUNDS: RequestBounds = {
  connectionTimeoutMs: 10_000,
  idleTimeoutMs: 5000,
};

/**
 * Build the `requestHandler` config for an AWS SDK client from the caller's own
 * deadlines, so a hung socket can never outlive them.
 *
 * @throws RangeError if `idleTimeoutMs` lands in the SDK's deferred-registration
 *   range, or if either deadline is non-positive. That is enforced rather than
 *   documented because every one of those failures is silent: the client still
 *   looks bounded, and only a stalled request reveals that nothing was ever
 *   armed.
 */
export function boundedRequestHandler(
  bounds: RequestBounds
): BoundedRequestHandlerConfig {
  if (bounds.idleTimeoutMs >= MAX_EFFECTIVE_IDLE_TIMEOUT_MS) {
    throw new RangeError(
      `idleTimeoutMs must be under ${MAX_EFFECTIVE_IDLE_TIMEOUT_MS}ms (got ${bounds.idleTimeoutMs}ms): the AWS SDK defers registering the idle listener at or above that and cancels it once response headers arrive, leaving a stalled body unbounded.`
    );
  }
  if (bounds.idleTimeoutMs <= 0) {
    throw new RangeError(
      `idleTimeoutMs must be positive (got ${bounds.idleTimeoutMs}ms); 0 disables the bound entirely.`
    );
  }
  if (bounds.connectionTimeoutMs <= 0) {
    throw new RangeError(
      `connectionTimeoutMs must be positive (got ${bounds.connectionTimeoutMs}ms); 0 disables the connect timer, and the idle timer cannot stand in for it — Node only arms a socket's timeout once the agent assigns one, so a request queued behind a saturated keep-alive agent waits with no bound at all.`
    );
  }

  if (bounds.totalTimeoutMs !== undefined && bounds.totalTimeoutMs <= 0) {
    throw new RangeError(
      `totalTimeoutMs must be positive when set (got ${bounds.totalTimeoutMs}ms); omit it to declare no elapsed ceiling. Smithy skips the timer entirely for 0 — a config that reads as an aborting ceiling and is not — and fires immediately for a negative value.`
    );
  }

  const config: BoundedRequestHandlerConfig = {
    connectionTimeout: bounds.connectionTimeoutMs,
    socketTimeout: bounds.idleTimeoutMs,
  };

  if (bounds.totalTimeoutMs !== undefined) {
    config.requestTimeout = bounds.totalTimeoutMs;
    // Without this the SDK only warns and lets the request run on.
    config.throwOnRequestTimeout = true;
  }

  return config;
}
