import { fileURLToPath } from "node:url";
import electron from "electron";
import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
import { reportCollectorRecordsDropped } from "../../telemetry/collector-records-dropped-telemetry.js";
import { CollectorRecordsDroppedReason } from "../../telemetry/telemetry-protocol.js";
import {
  createIdleTeardownTimer,
  HELPER_IDLE_TEARDOWN_MS,
  type IdleTeardownTimer,
} from "../../util/idle-teardown-timer.js";
import type { Harness, NormalizedSession } from "../types.js";
import {
  E2E_PARSE_QUARANTINE_ENABLED_VALUE,
  E2E_POISON_WORKER_CAPABILITY_ENV,
} from "./e2e-parse-quarantine-seam.js";
import type {
  AbortableHistoricalParseRunner,
  HistoricalParseRunner,
} from "./historical-parse-runner.js";
import type { HistoricalParseResult } from "./historical-parse-source.js";
import {
  createHistoricalWorkerStderrSummarizer,
  summarizeHistoricalWorkerResponseIssues,
} from "./historical-parse-worker-diagnostics.js";
import {
  errorFromHistoricalParseWorkerFailure,
  type HistoricalParseWorkerRequest,
  HistoricalParseWorkerRequestType,
  type HistoricalParseWorkerResponse,
  HistoricalParseWorkerResponseType,
  type HistoricalParseWorkerResumePoint,
  historicalParseWorkerRequestSchema,
  historicalParseWorkerResponseSchema,
  requestIdFromWorkerMessage,
} from "./historical-parse-worker-protocol.js";

const { utilityProcess } = electron;
const DEFAULT_PARSE_TIMEOUT_MS = 5 * 60_000;
/** ISS-7534: how many truncated session ids one local log line may name. */
const MAX_LOGGED_TRUNCATED_SESSION_IDS = 10;
const WORKER_STDIO: WorkerStdio = ["ignore", "ignore", "pipe"];

type WorkerStdio = ["ignore", "ignore", "pipe"];
type WorkerFatalErrorType = "FatalError";

type PendingParse = {
  resolve: (result: HistoricalParseResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  child: HistoricalParseWorkerProcess;
  /**
   * ISS-5854: which source this request is for, so a loss report can name its
   * subject. The monitored event carries a bounded reason and a count by
   * contract, which leaves the local log as the only place an operator can
   * learn WHICH source under-imported.
   */
  collectorKey: Harness;
  source: string;
  /**
   * ISS-7696: the continuation this request was SENT with, so the response can
   * be judged against what it was asked for. Without it "carries a resume point"
   * reads as progress even when the worker refused the token and re-sent the
   * same window — see {@link resumeAdvanced}.
   */
  resumeAfter?: HistoricalParseWorkerResumePoint;
};

type HistoricalParseWorkerProcess = {
  stderr?: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
  } | null;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(
    event: "error",
    listener: (
      type: WorkerFatalErrorType,
      location: string,
      report: string
    ) => void
  ): unknown;
  postMessage(message: HistoricalParseWorkerRequest): void;
  kill(): void;
};

type HistoricalParseWorkerForkOptions = {
  serviceName: string;
  stdio: typeof WORKER_STDIO;
  env?: NodeJS.ProcessEnv;
};

type HistoricalParseWorkerFork = (
  modulePath: string,
  args: string[],
  options: HistoricalParseWorkerForkOptions
) => HistoricalParseWorkerProcess;

/**
 * Create an Electron utility-process parser runner. The main process owns
 * source enumeration, DB writes, and cache persistence; the utility process only
 * performs CPU-heavy transcript parsing for one bounded source at a time.
 */
export function createUtilityProcessHistoricalParseRunner(options?: {
  log?: (message: string) => void;
  forkWorker?: HistoricalParseWorkerFork;
  parseTimeoutMs?: number;
  /**
   * ISS-4573 / PR #4085 review (whitlockk): arm the TEST-ONLY poison-parse capability
   * in the forked worker. The main-process composition root sets this to `true`
   * ONLY after clearing the `!app.isPackaged` + E2E-sentinel gate. When true the
   * runner forks the worker with {@link E2E_POISON_WORKER_CAPABILITY_ENV} set to
   * the enabled sentinel; when false (production, and the default) it STRIPS any
   * inherited value from the worker env so a packaged/production worker can never
   * wedge a real parse off a leaked flag.
   */
  enablePoisonWorkerCapability?: boolean;
  idleTeardownMs?: number;
}): AbortableHistoricalParseRunner {
  return new UtilityProcessHistoricalParseRunner(
    options?.log ?? (() => {}),
    options?.forkWorker ?? forkHistoricalParseWorker,
    options?.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS,
    options?.enablePoisonWorkerCapability ?? false,
    options?.idleTeardownMs ?? HELPER_IDLE_TEARDOWN_MS
  );
}

class UtilityProcessHistoricalParseRunner implements HistoricalParseRunner {
  private readonly log: (message: string) => void;
  private readonly forkWorker: HistoricalParseWorkerFork;
  private readonly parseTimeoutMs: number;
  private readonly enablePoisonWorkerCapability: boolean;
  private readonly pending = new Map<string, PendingParse>();
  private readonly exitingChildren = new Set<HistoricalParseWorkerProcess>();
  private child: HistoricalParseWorkerProcess | null = null;
  private nextRequestId = 0;
  // ISS-4444 (codex P1): the runner shares ONE worker child across all five
  // concurrent boot-import harness loops. `abortInFlightParse`/timeout kills the
  // child, and killing a child rejects EVERY request pending on it — so if two
  // sources were dispatched to the same child at once, a poison parse's abort
  // would also discard the unrelated healthy source, whose manager would then
  // enter its generic parse-error catch and silently skip a good source. We
  // therefore SERIALIZE worker dispatch: at most one request is ever posted to
  // the worker at a time, so there is never unrelated in-flight work for an abort
  // to discard. Each caller chains onto this tail; the next dispatches only after
  // the prior settles.
  private dispatchTail: Promise<unknown> = Promise.resolve();
  // ISS-4572 (davetho / whitlockk review): `stop()` rejects requests that already
  // reached `pending`, but closures chained on `dispatchTail` BEFORE stop have not
  // run `dispatchParse` yet — without a guard they would still fork a fresh worker
  // AFTER shutdown and run a full parse window ahead of a restarted generation.
  // Every `parseSource` captures this generation at enqueue; `stop()` bumps it, so
  // a queued turn whose generation is stale rejects on dispatch instead of spawning
  // a worker. Increment-on-stop keeps the runner reusable — a `parseSource` after a
  // stop starts a fresh generation and dispatches normally.
  private generation = 0;
  private readonly idleTeardown: IdleTeardownTimer;

  constructor(
    log: (message: string) => void,
    forkWorker: HistoricalParseWorkerFork,
    parseTimeoutMs: number,
    enablePoisonWorkerCapability: boolean,
    idleTeardownMs: number
  ) {
    this.log = log;
    this.forkWorker = forkWorker;
    this.parseTimeoutMs = parseTimeoutMs;
    this.enablePoisonWorkerCapability = enablePoisonWorkerCapability;
    this.idleTeardown = createIdleTeardownTimer(idleTeardownMs, () =>
      this.teardownIdleChild()
    );
  }

  parseSource(
    collectorKey: Harness,
    source: string,
    onDispatch?: () => void,
    resumeAfter?: HistoricalParseWorkerResumePoint,
    parsePolicy?: ParsePolicy
  ): Promise<HistoricalParseResult> {
    // Serialize dispatch: run this parse only after the previous one has settled
    // so at most one request is in flight on the shared worker at any moment. A
    // rejected predecessor must not break the chain, so swallow its outcome
    // before starting the next turn (the predecessor already surfaced its own
    // rejection to its own caller).
    //
    // ISS-4572: `onDispatch` fires inside `dispatchParse`, i.e. only AFTER this
    // dispatch-tail wait drains and the request is actually posted to the worker
    // — so a caller's deadline starts at dispatch, not at this enqueue.
    //
    // Capture the generation at enqueue: if a `stop()` lands while this turn is
    // still waiting on the tail, `dispatchParse` sees a stale generation and
    // rejects instead of forking a worker after shutdown (davetho / whitlockk).
    const enqueuedGeneration = this.generation;
    const dispatch = (): Promise<HistoricalParseResult> =>
      this.dispatchParse(
        collectorKey,
        source,
        onDispatch,
        enqueuedGeneration,
        resumeAfter,
        parsePolicy
      );
    const result = this.dispatchTail.then(dispatch, dispatch);
    // Keep the tail alive even if this parse rejects, so a later parseSource can
    // still chain after it.
    this.dispatchTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private dispatchParse(
    collectorKey: Harness,
    source: string,
    onDispatch?: () => void,
    enqueuedGeneration = this.generation,
    resumeAfter?: HistoricalParseWorkerResumePoint,
    parsePolicy?: ParsePolicy
  ): Promise<HistoricalParseResult> {
    // ISS-4572: a turn that was queued behind the dispatch tail before a `stop()`
    // must NOT fork a fresh worker after shutdown and race a restarted generation.
    // Reject it here — its caller's own catch treats this like any other aborted
    // parse. `onDispatch` is deliberately NOT fired (no deadline to arm for a turn
    // that never reaches the worker).
    if (enqueuedGeneration !== this.generation) {
      return Promise.reject(
        new Error("historical parse worker stopped before dispatch")
      );
    }
    const requestId = `historical-parse-${++this.nextRequestId}`;
    // ISS-7696: the caller owns the continuation (see
    // `collector-manager-pass-resources.parseHistoricalSource`); this runner
    // holds none of its own. Omitted — never sent as `null` — when there is
    // nothing outstanding, so the common request is byte-for-byte what it was.
    const parsedRequest = historicalParseWorkerRequestSchema.safeParse({
      type: HistoricalParseWorkerRequestType.ParseSource,
      requestId,
      collectorKey,
      source,
      ...(resumeAfter ? { resumeAfter } : {}),
      ...(parsePolicy ? { parsePolicy } : {}),
    });
    if (!parsedRequest.success) {
      return Promise.reject(new Error("invalid historical parse request"));
    }
    const request = parsedRequest.data;
    this.idleTeardown.cancel();
    let child: HistoricalParseWorkerProcess;
    try {
      child = this.ensureChild();
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error))
      );
    }
    const parse = new Promise<HistoricalParseResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error("historical parse worker timed out");
        this.rejectPendingForChild(child, error);
        this.killChild(child);
      }, this.parseTimeoutMs);
      timeout.unref();
      this.pending.set(requestId, {
        resolve,
        reject,
        timeout,
        child,
        collectorKey,
        source,
        ...(resumeAfter ? { resumeAfter } : {}),
      });
      // ISS-4572: signal DISPATCH the instant before the request is posted to the
      // worker (the dispatch-tail wait has already drained by the time we reach
      // dispatchParse), so a caller's per-source deadline starts here and not at
      // enqueue. Best-effort: a throwing hook must not abort the dispatch.
      try {
        onDispatch?.();
      } catch {
        /* deadline arming is best-effort; the parse still dispatches */
      }
      try {
        child.postMessage(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const armIfQuiet = () => this.armIdleTeardownIfQuiet();
    parse.then(armIfQuiet, armIfQuiet);
    return parse;
  }

  stop(): void {
    this.idleTeardown.cancel();
    // ISS-4572: bump the generation FIRST so any turn still queued on the dispatch
    // tail rejects on dispatch (see `dispatchParse`) instead of forking a worker
    // after shutdown. Then reject the already-dispatched pending requests and kill
    // the active child. The runner stays reusable: the next `parseSource` enqueues
    // under the new generation and dispatches normally.
    this.generation += 1;
    this.rejectPending(new Error("historical parse worker stopped"));
    this.exitingChildren.clear();
    this.killChild();
  }

  /**
   * ISS-4444: kill the worker running the current parse turn so a CPU-spinning
   * parser stops pegging a core after the manager's per-source parse watchdog gave
   * up. Because dispatch is serialized (see `dispatchTail`), the child has at most
   * ONE request in flight — the timed-out one — so killing it settles only that
   * request's promise and never discards unrelated healthy work. The next
   * parseSource turn lazily spawns a fresh worker. A no-op when no worker is
   * active.
   */
  abortInFlightParse(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.rejectPendingForChild(
      child,
      new Error("historical parse worker aborted (per-source watchdog)")
    );
    this.killChild(child);
  }

  private ensureChild(): HistoricalParseWorkerProcess {
    if (this.child) {
      return this.child;
    }
    const workerPath = fileURLToPath(
      new URL("./historical-parse-worker.js", import.meta.url)
    );
    const workerEnv = this.buildWorkerEnv();
    // Only include the `env` key when we actually have an env to set. Electron's
    // `utilityProcess.fork` fails the option parse (gin `opts.Has("env") &&
    // !opts.Get("env", &env_map)` → `ThrowTypeError("Invalid value for env")`) when
    // the `env` key is PRESENT but `undefined` — a present-undefined value is not a
    // valid map and throws synchronously, killing every historical parse (ISS-4573:
    // this is what red-lined the launched-app import specs). Omitting the key keeps
    // Electron's documented default (inherit `process.env`).
    const child = this.forkWorker(
      workerPath,
      [],
      workerEnv === undefined
        ? { serviceName: "closedloop-historical-parser", stdio: WORKER_STDIO }
        : {
            serviceName: "closedloop-historical-parser",
            stdio: WORKER_STDIO,
            env: workerEnv,
          }
    );
    child.on("message", (message) => this.handleMessage(child, message));
    child.on("exit", (code) => this.handleChildExit(child, code));
    child.on("error", (type, location) =>
      this.handleChildError(child, type, location)
    );
    // Summarize on LINE boundaries, not on `data` events: a chunk boundary is
    // arbitrary, so a credential straddling two of them would miss every pattern
    // and reach the log as two halves that reconstruct it.
    const stderrSummarizer = createHistoricalWorkerStderrSummarizer();
    child.stderr?.on("data", (chunk: Buffer) => {
      const summary = stderrSummarizer.push(chunk);
      if (summary) {
        this.log(summary);
      }
    });
    // The unterminated last line is usually the one saying why the worker died,
    // so it is flushed rather than held for a newline that is no longer coming.
    // `exit` is the ONLY edge that can carry that flush, and the stream's own
    // `end`/`close` are deliberately not wired: Electron's `ForkUtilityProcess`
    // wraps the internal emitter and, in the `finally` of the SAME turn it emits
    // `exit`, calls `stderr.removeAllListeners()` and drops the stream
    // (electron@43, `lib/browser/api/utility-process.ts`), so a listener waiting
    // on either is never called and the line is simply lost.
    //
    // Deferred one turn, though. That same teardown means the Electron path
    // delivers no `data` after `exit` — but fired INLINE against a stream that
    // does, the carry would be logged as one record and its continuation as
    // another, which is the split-credential leak the accumulator exists to
    // close. One turn costs nothing and does not depend on that guarantee.
    const flushWorkerStderr = () => {
      const summary = stderrSummarizer.flush();
      if (summary) {
        this.log(summary);
      }
    };
    child.on("exit", () => setImmediate(flushWorkerStderr));
    this.child = child;
    return child;
  }

  private handleMessage(
    child: HistoricalParseWorkerProcess,
    message: unknown
  ): void {
    if (!(this.child === child || this.exitingChildren.has(child))) {
      return;
    }
    const parsedResponse =
      historicalParseWorkerResponseSchema.safeParse(message);
    if (!parsedResponse.success) {
      const requestId = requestIdFromWorkerMessage(message);
      const error = new Error(
        requestId
          ? `historical parse worker sent an invalid response for ${requestId}`
          : "historical parse worker sent an invalid response"
      );
      this.rejectPendingForChild(child, error);
      this.killChild(child);
      this.log(
        `${error.message}: ${summarizeHistoricalWorkerResponseIssues(parsedResponse.error)}`
      );
      return;
    }
    this.resolveResponse(child, parsedResponse.data);
  }

  private handleChildExit(
    child: HistoricalParseWorkerProcess,
    code: number | null
  ): void {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.exitingChildren.add(child);
    setImmediate(() => {
      this.exitingChildren.delete(child);
      this.rejectPendingForChild(
        child,
        new Error(`historical parse worker exited with code ${String(code)}`)
      );
    });
  }

  private handleChildError(
    child: HistoricalParseWorkerProcess,
    type: WorkerFatalErrorType,
    location: string
  ): void {
    if (this.child !== child) {
      return;
    }
    const message = `historical parse worker error: ${type} at ${location}`;
    this.log(message);
    this.rejectPendingForChild(child, new Error(message));
    this.killChild(child);
  }

  private resolveResponse(
    child: HistoricalParseWorkerProcess,
    response: HistoricalParseWorkerResponse
  ): void {
    if (
      response.type === HistoricalParseWorkerResponseType.Failed &&
      response.fatal
    ) {
      const error = errorFromHistoricalParseWorkerFailure(response);
      this.rejectPendingForChild(child, error);
      this.killChild(child);
      if (response.diagnostic) {
        this.log(`${response.message}: ${response.diagnostic}`);
      }
      return;
    }

    const pending = this.pending.get(response.requestId);
    if (!(pending && pending.child === child)) {
      return;
    }
    this.pending.delete(response.requestId);
    clearTimeout(pending.timeout);
    if (response.type === HistoricalParseWorkerResponseType.Parsed) {
      this.reportDroppedSessions(response, pending);
      this.reportTokenSeriesTruncation(response.sessions);
      // ISS-5266: carry the parse's side-report back with its sessions. The
      // field is optional on the wire, so a worker build that does not send one
      // (and every non-OpenCode parse) yields a plain `{ sessions }` here.
      pending.resolve({
        sessions: response.sessions,
        ...(response.withheldOpencodeSubagents
          ? { withheldOpencodeSubagents: response.withheldOpencodeSubagents }
          : {}),
        // ISS-5854: the count must reach the IMPORT decision, not just the
        // operator. Telemetry is fire-and-forget; the manager is what decides
        // whether to seal this source as fully imported.
        ...(response.droppedSessions
          ? { droppedSessions: response.droppedSessions }
          : {}),
        // ISS-7625: an all-malformed source parses to zero sessions in the
        // WORKER, so this is the only way its counts reach the main process at
        // all — a main-process-only carry would never fire on the historical
        // path, which is where production does this parsing.
        ...(response.unreadableParseQuality
          ? { unreadableParseQuality: response.unreadableParseQuality }
          : {}),
        // ISS-7696: the continuation rides the result to the collector that owns
        // the fingerprint, which parks it PENDING until this pass reaches its
        // seal gate. The runner deliberately keeps no copy: a boundary-local
        // cursor would advance on "the worker sent a window" rather than on
        // "the import consumed one", and the two are not the same event.
        ...(response.resumeAfter ? { resumeAfter: response.resumeAfter } : {}),
      });
      return;
    }
    const error = errorFromHistoricalParseWorkerFailure(response);
    if (response.diagnostic) {
      this.log(`${response.message}: ${response.diagnostic}`);
    }
    pending.reject(error);
  }

  /**
   * ISS-5854: report sessions the response budget dropped on the MONITORED path.
   *
   * A dropped session has no row to carry a marker — it does not exist locally
   * or upstream — so unlike a truncated field this can only be surfaced on the
   * response and from here. The clamp runs in the utility process, which has no
   * telemetry transport, so the emit belongs in the main process, the one place
   * `Observability.init` runs (the ISS-7109 note in `database/live-hook.ts`:
   * "monitored" is a claim about a process, not just a call).
   *
   * `undefined` is the normal case — nothing dropped, and every pre-ISS-5854
   * worker payload — and must stay silent, or the alert fires on healthy parses.
   *
   * ISS-7696 splits the remaining case by whether the window ADVANCED, which is
   * not the same question as whether it carries a token. A response that moved
   * past what we asked for deferred those sessions to a pass that will get them,
   * and alerting on it would fire the loss monitor on every large store that is
   * importing correctly. A response that did NOT move past it is under-importing
   * exactly as ISS-5854 described, and there are two ways to get there: a worker
   * too old to continue at all, and a resume the worker REFUSED because the
   * store reordered under it (`resolveHistoricalParseResumeOffset`; OpenCode
   * selects `ORDER BY time_updated DESC`, so touching any session reshuffles the
   * prefix). Both keep the monitor, because in both the tail did not arrive and
   * nothing in this response promises it ever will.
   */
  private reportDroppedSessions(
    response: Extract<
      HistoricalParseWorkerResponse,
      { type: typeof HistoricalParseWorkerResponseType.Parsed }
    >,
    pending: PendingParse
  ): void {
    const droppedSessions = response.droppedSessions;
    if (!droppedSessions || droppedSessions <= 0) {
      return;
    }
    if (resumeAdvanced(pending.resumeAfter, response.resumeAfter)) {
      this.log(
        `historical parse: response budget deferred ${droppedSessions} whole session(s) to a later pass; harness=${pending.collectorKey} source=${pending.source} resumes after session ${response.resumeAfter?.sessionId} (index ${response.resumeAfter?.sessionIndex})`
      );
      return;
    }
    // The monitored event is bounded to a reason and a count by contract, so the
    // local log is the only place the SUBJECT can be named. Without it an
    // operator holding a `session_response_budget` alert cannot tell which of
    // many sources under-imported — the same local/monitored split
    // `database/live-hook.ts` uses beside this emit.
    this.log(
      `historical parse: response budget dropped ${droppedSessions} whole session(s); harness=${pending.collectorKey} source=${pending.source} imported a SUBSET of its parse${pending.resumeAfter ? ` (the resume from index ${pending.resumeAfter.sessionIndex} did not advance — the store moved under it)` : ""}`
    );
    reportCollectorRecordsDropped({
      reason: CollectorRecordsDroppedReason.SessionResponseBudget,
      count: droppedSessions,
    });
  }

  /**
   * ISS-7534: report a truncated `tokenSeries` on the MONITORED path.
   *
   * The clamp runs in the utility process, which has only `parentPort` and no
   * telemetry transport — so the truncation rides the response and is emitted
   * here, in the main process, the one place `Observability.init` runs (see the
   * ISS-7109 note in `database/live-hook.ts`: "monitored" is a claim about a
   * process, not just a call).
   *
   * One event per RESPONSE, not per session, so a source that truncates many
   * sessions cannot turn one over-budget parse into a burst. The local log gets
   * the session ids; the monitored event carries a bounded reason and the count
   * and nothing else, matching `reportCollectorRecordsDropped`'s contract.
   */
  private reportTokenSeriesTruncation(sessions: NormalizedSession[]): void {
    let droppedRecords = 0;
    let truncatedSessions = 0;
    // A source may carry up to `maxWorkerSessionsPerSource` sessions, so the id
    // list is capped rather than joined whole — a log line is a diagnostic, not
    // a place to accumulate one entry per session.
    const namedSessionIds: string[] = [];
    for (const session of sessions) {
      if (session.tokenSeriesTruncation) {
        droppedRecords += session.tokenSeriesTruncation.droppedRecords;
        truncatedSessions++;
        if (namedSessionIds.length < MAX_LOGGED_TRUNCATED_SESSION_IDS) {
          namedSessionIds.push(session.sessionId);
        }
      }
    }
    if (droppedRecords === 0) {
      return;
    }
    const elided = truncatedSessions - namedSessionIds.length;
    this.log(
      `historical parse: response budget dropped ${droppedRecords} tokenSeries record(s) across ${truncatedSessions} session(s): ${namedSessionIds.join(", ")}${elided > 0 ? ` (+${elided} more)` : ""}`
    );
    reportCollectorRecordsDropped({
      reason: CollectorRecordsDroppedReason.TokenSeriesResponseBudget,
      count: droppedRecords,
    });
  }

  private killChild(child = this.child): void {
    if (this.child === child) {
      this.child = null;
    }
    if (child) {
      this.exitingChildren.delete(child);
    }
    child?.kill();
  }

  private armIdleTeardownIfQuiet(): void {
    if (this.child && this.pending.size === 0) {
      this.idleTeardown.arm();
    }
  }

  private teardownIdleChild(): void {
    if (this.pending.size === 0) {
      this.killChild();
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectPendingForChild(
    child: HistoricalParseWorkerProcess,
    error: Error
  ): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.child !== child) {
        continue;
      }
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  /**
   * ISS-4573 / PR #4085 review (whitlockk): build the worker's env. The worker cannot
   * read `app.isPackaged`, so we do not let it trust the raw inherited app-level
   * E2E sentinel. When the main process cleared the `!isPackaged` + sentinel gate
   * (`enablePoisonWorkerCapability`), thread the poison capability in EXPLICITLY;
   * otherwise STRIP any inherited value so a packaged/production worker can never
   * wedge a real parse off a leaked flag. Returns `undefined` in the common
   * production case; the caller then OMITS the `env` fork option entirely (a
   * present-but-`undefined` `env` throws in Electron's option parse — see
   * `ensureChild`), so the worker keeps Electron's default inherited `process.env`
   * with no capability set.
   */
  private buildWorkerEnv(): NodeJS.ProcessEnv | undefined {
    if (this.enablePoisonWorkerCapability) {
      return {
        ...process.env,
        [E2E_POISON_WORKER_CAPABILITY_ENV]: E2E_PARSE_QUARANTINE_ENABLED_VALUE,
      };
    }
    if (process.env[E2E_POISON_WORKER_CAPABILITY_ENV] === undefined) {
      return;
    }
    const stripped = { ...process.env };
    delete stripped[E2E_POISON_WORKER_CAPABILITY_ENV];
    return stripped;
  }
}

/**
 * ISS-7696: did this response get FURTHER than the continuation we sent?
 *
 * A first request (nothing sent) that comes back with a resume point advanced by
 * definition — it delivered a window and named the next one. A later request
 * advanced only when the returned index is strictly past the one we asked from;
 * an equal or smaller index is the worker having REFUSED our token and started
 * over, which delivers the same prefix again and leaves the tail exactly where
 * it was. That distinction is the difference between a deferral and the
 * ISS-5854 under-import, and only the caller — which knows what it sent — can
 * draw it.
 */
function resumeAdvanced(
  sent: HistoricalParseWorkerResumePoint | undefined,
  received: HistoricalParseWorkerResumePoint | undefined
): boolean {
  if (!received) {
    return false;
  }
  return sent === undefined || received.sessionIndex > sent.sessionIndex;
}

function forkHistoricalParseWorker(
  modulePath: string,
  args: string[],
  options: HistoricalParseWorkerForkOptions
): HistoricalParseWorkerProcess {
  return utilityProcess.fork(modulePath, args, options);
}
