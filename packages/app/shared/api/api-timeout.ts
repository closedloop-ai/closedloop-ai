/**
 * Client-side request deadline for the shared API client (ISS-5013, split from
 * ISS-5002).
 *
 * `apiFetch` previously issued every request with no timeout and no
 * `AbortSignal`. A request that never settles therefore never rejects: TanStack
 * Query stays `isLoading` forever, no `error` is ever produced, the retry
 * predicate never engages (it requires the request to settle first), and no
 * error boundary can see anything. The surface renders its loading treatment
 * indefinitely with no escape hatch — which is exactly what `/packs` did in
 * production, holding three separate loading treatments past 22 seconds.
 *
 * A bounded deadline converts that permanent "still loading" into a stated,
 * recoverable failure. The deadline is deliberately a CLIENT-side fact: it says
 * "we stopped waiting", NOT "the server said no", and the two are surfaced as
 * distinct errors (see {@link API_TIMEOUT_ERROR_CODE}) so a surface can tell a
 * user which one happened. A timed-out request is NOT retried — see
 * `shouldRetryQuery` in `../query/query-client.ts`, which documents that
 * decision — so the surface reaches its stated failure immediately rather than
 * after several more full-length waits.
 *
 * SURFACE CAVEAT (desktop): the Electron renderer's injected transport
 * (`createCloudIpcFetch`) cannot forward `init.signal` across the IPC bridge —
 * an `AbortSignal` does not survive structured cloning — so on desktop this
 * deadline does not itself cancel anything. What DOES cross is the number:
 * {@link toRequestInit} leaves the deadline's REMAINING budget on the init, the
 * renderer transport marshals it over the bridge, and the main process bounds
 * the request at that value instead of its own 60s `DEFAULT_TIMEOUT_MS`
 * (ISS-5082). A per-call override is therefore no longer silently dropped at
 * the bridge; before that, EVERY bridged request was pinned to 60s no matter
 * what its call site asked for. It is the remaining budget rather than the
 * original duration because main arms a FRESH timer from the number it
 * receives — forwarding the full duration after the auth-hydration wait had
 * already spent part of it would let a bridged request outlive the client's
 * own deadline by almost the whole duration again.
 *
 * That is the transport half only, and it is not by itself enough to make a
 * long-running WRITE work on desktop. Every long-running WRITE call site is a
 * POST, and the bridge's per-method write allowlist (`WRITE_ALLOWLIST` in
 * `apps/desktop/src/main/ipc/cloud-api-fetch-ipc.ts`) admits only the
 * trace-comment routes — so a bridged pack/Drive import is refused before any
 * deadline applies, and those surfaces are not mounted in the desktop renderer
 * today either. Reads are not allowlist-gated, so a long-running GET benefits
 * immediately — and long-running READS are no longer hypothetical: the branch
 * selected-PR files and diff queries
 * (`packages/app/branches/hooks/use-branch-selected-pull-request-files.ts`,
 * ISS-4471) raise this deadline on a GET, making them the first call sites the
 * forwarded number actually serves. A long-running write still needs its route
 * added to that allowlist first.
 *
 * Because the bound is enforced in main rather than by this signal, main is
 * the only side that knows an abort was the DEADLINE. It says so: its
 * network-error result carries `reason: "timeout"`, and the desktop adapter
 * maps that onto this same {@link API_TIMEOUT_ERROR_CODE} (ISS-5082), so a
 * desktop deadline expiry reaches the identical non-retried "we stopped
 * waiting" state as on web. An unlabeled transport failure still arrives as a
 * generic `ApiError(message, 0)`; note that this is NOT a retried state either
 * — `isResponseBackedError` short-circuits on `error instanceof ApiError`
 * without inspecting the status, so `shouldRetryQuery` returns false for every
 * `ApiError` this client throws, and its `status === 0` "stays retryable"
 * branch is unreachable from here. (A caller-initiated `AbortError` is the one
 * thing this function re-throws un-wrapped; React Query treats it as a
 * cancellation, not a failure to retry.)
 *
 * One gap remains, deliberately, as separate work: a CALLER abort (React Query
 * cancelling a superseded query, a user navigating away) still does not reach
 * the in-flight main-process request. And a `null` `timeoutMs` (deadline
 * opt-out) is not unbounded on desktop: the bridge has no "no deadline" mode,
 * so it applies the longest bound it can express instead — see
 * `forwardableTimeoutMs` in the desktop adapter for what that choice costs when
 * it fires.
 */

/**
 * Default ceiling on a single API request, in milliseconds.
 *
 * 60s matches the budget the desktop cloud-API transport already applies to this
 * exact traffic (`DEFAULT_TIMEOUT_MS` in
 * `apps/desktop/src/main/ipc/cloud-api-fetch-ipc.ts`). Matching it means the web
 * surface does not enforce a second, tighter number than the one the team
 * already judged safe for the same endpoints.
 *
 * It is a default, not a universal ceiling. The large-payload paths (transcript
 * bytes, attachment blobs) never go through this client — they presign here and
 * transfer over their own `fetch` — but a handful of endpoints DO run long work
 * synchronously before responding (repo/zip pack imports, GitHub backfill,
 * Google Drive folder import). Those raise the deadline explicitly at the call
 * site via {@link ApiRequestOptions.timeoutMs} — see
 * {@link LONG_RUNNING_API_TIMEOUT_MS} — rather than the default being widened
 * for the ~230 calls that legitimately answer in under a second.
 */
export const DEFAULT_API_TIMEOUT_MS = 60_000;

/**
 * Deadline for the few endpoints that do genuinely long synchronous work before
 * they respond (pack import from a repo or zip, GitHub backfill in Apply mode,
 * Google Drive folder import).
 *
 * 5 minutes is not an arbitrary "big number": it is the serverless
 * `maxDuration` each of those routes explicitly declares (`export const
 * maxDuration = 300`), so a request that outlives it cannot still be doing
 * useful work on the server — at that point waiting longer only withholds the
 * failure from the user.
 *
 * That premise only holds while the routes actually declare it. Before PR
 * #4321 they did not, so the platform default terminated the function first and
 * the client surfaced a 504 long before this deadline could fire. The
 * declarations are pinned by `apps/api/app/long-running-route-max-duration.test.ts`
 * — if a new call site raises its deadline to this constant, give its route the
 * matching `maxDuration` and add it there.
 */
export const LONG_RUNNING_API_TIMEOUT_MS = 5 * 60_000;

/**
 * Status carried by an error that never received an HTTP response at all. `0` is
 * the existing fetch "no response" sentinel this client already uses for network
 * failures; a deadline abort is the same class of fact (no answer was received)
 * and must not masquerade as an HTTP status the server never sent.
 */
export const API_NO_RESPONSE_STATUS = 0;

/**
 * Error code marking a request the CLIENT gave up on. Distinct from every
 * server-sent code on purpose: "we stopped waiting" and "the server answered
 * with an error" are different facts and a surface may legitimately offer
 * different recovery for each (retry vs. report). Read it via
 * `ApiError#isTimeout()` rather than comparing the string at call sites.
 */
export const API_TIMEOUT_ERROR_CODE = "client_request_timeout";

/** User-facing message for a request that exceeded its client-side deadline. */
export const API_TIMEOUT_ERROR_MESSAGE =
  "The request timed out before the server responded.";

/**
 * Options accepted by the shared API client's methods: a standard `RequestInit`
 * plus the per-call deadline override.
 */
export type ApiRequestOptions = RequestInit & {
  /**
   * Override {@link DEFAULT_API_TIMEOUT_MS} for this one request. Pass `null` to
   * opt out of the deadline entirely for a genuinely unbounded call — a
   * deliberate, reviewable choice at the call site, never the default.
   */
  timeoutMs?: number | null;
};

/**
 * A started request deadline. `signal` is what the request must be issued with;
 * `timedOut()` reports whether THIS deadline (rather than the caller) aborted
 * it; `dispose()` must run in a `finally` so the timer is always cleared.
 */
export type ApiRequestDeadline = {
  readonly signal: AbortSignal | undefined;
  /**
   * Milliseconds LEFT on the deadline actually in effect (already clamped;
   * floored at 1), or `null` when the caller opted out. Exposed because a
   * transport that cannot observe `signal` — the desktop IPC bridge — has to
   * be told the number instead; {@link toRequestInit} puts it on the request
   * init for that reason. It reports the REMAINING budget rather than the
   * original duration because such a transport arms a fresh timer from the
   * number it is handed — the original duration would not account for the
   * time the auth-hydration wait already spent.
   */
  readonly remainingMs: () => number | null;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
};

/**
 * True for an abort raised by an `AbortSignal` — either the caller's own
 * cancellation or a deadline. Browsers and Node both surface this as a
 * `DOMException`/`Error` named `AbortError`.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Start the deadline for one request, composing it with any caller-supplied
 * `signal` so a user-initiated cancellation still aborts the request and a
 * caller abort is never misreported as a timeout.
 *
 * Always pair with `dispose()` in a `finally`: a settled request must not leave
 * a pending timer behind, and the caller's `abort` listener must be removed so a
 * long-lived caller signal does not accumulate listeners per request.
 */
export function startApiRequestDeadline(
  options?: ApiRequestOptions
): ApiRequestDeadline {
  const callerSignal = options?.signal ?? undefined;
  const requested =
    options?.timeoutMs === undefined
      ? DEFAULT_API_TIMEOUT_MS
      : options.timeoutMs;
  // Clamp to a positive floor: `0` or a negative override would arm a timer that
  // fires immediately, turning every request into an instant fake timeout.
  const timeoutMs = requested === null ? null : Math.max(1, requested);

  // Explicit opt-out: hand back the caller's signal untouched and never arm a
  // timer, so `dispose()` has nothing to clean up.
  if (timeoutMs === null) {
    return {
      signal: callerSignal,
      remainingMs: () => null,
      timedOut: () => false,
      dispose: () => {
        // No timer and no listener were installed on the opt-out path.
      },
    };
  }

  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  let timedOut = false;
  // Cleared as soon as the timer FIRES as well as on dispose, so a fired timer
  // never leaves a stale handle that a later `clearTimeout` would act on.
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined =
    globalThis.setTimeout(() => {
      timer = undefined;
      timedOut = true;
      controller.abort();
    }, timeoutMs);

  const forwardCallerAbort = () => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      forwardCallerAbort();
    } else {
      callerSignal.addEventListener("abort", forwardCallerAbort, {
        once: true,
      });
    }
  }

  return {
    signal: controller.signal,
    // Floored at 1 rather than 0: a fully-spent budget still has to cross the
    // desktop bridge as a valid (positive) deadline, and by the time it could
    // read 0 the timer has fired and aborted the request through `signal`.
    remainingMs: () => Math.max(1, expiresAt - Date.now()),
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) {
        globalThis.clearTimeout(timer);
        timer = undefined;
      }
      callerSignal?.removeEventListener("abort", forwardCallerAbort);
    },
  };
}

/**
 * Build the request init: the caller's options with the deadline's composed
 * signal applied and `timeoutMs` normalized to what is LEFT of the deadline
 * actually in effect (clamped, defaulted, or `null` for an opt-out) rather
 * than whatever the caller passed. The remaining budget matters because this
 * runs AFTER the auth-hydration waits: a transport that arms a fresh timer
 * from this number (the desktop bridge) must not be handed time the request
 * has already spent, or the request outlives the client's own deadline.
 *
 * `timeoutMs` rides along rather than being stripped because a transport that
 * cannot observe an `AbortSignal` has no other way to learn the deadline — see
 * the desktop surface caveat at the top of this module. The platform `fetch`
 * ignores init members it does not know, so carrying it costs the web path
 * nothing.
 */
export function toRequestInit(
  options: ApiRequestOptions | undefined,
  deadline: ApiRequestDeadline
): ApiRequestOptions {
  const init: ApiRequestOptions = {
    ...options,
    timeoutMs: deadline.remainingMs(),
  };
  if (deadline.signal) {
    init.signal = deadline.signal;
  }
  return init;
}

/** Build the `AbortError` a deadline or cancellation surfaces as. */
function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Run `work` under a deadline that `work` itself cannot observe.
 *
 * `fetch` takes the signal directly, but the auth-hydration wait in front of it
 * does not — and that wait is itself unbounded, so without this the deadline
 * would only ever cover the second half of a request. Racing the abort against
 * the work bounds those steps too. The listener is removed in a `finally` so a
 * settled request leaves nothing attached.
 */
export async function raceRequestDeadline<T>(
  work: Promise<T>,
  deadline: ApiRequestDeadline
): Promise<T> {
  const { signal } = deadline;
  if (!signal) {
    return await work;
  }
  if (signal.aborted) {
    throw abortError();
  }

  let onAbort: () => void = () => {
    // Replaced below; only referenced by the `finally` cleanup.
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
