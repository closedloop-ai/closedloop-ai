import { fileURLToPath } from "node:url";
import electron from "electron";
import type { Harness } from "../types.js";
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
  errorFromHistoricalParseWorkerFailure,
  type HistoricalParseWorkerRequest,
  HistoricalParseWorkerRequestType,
  type HistoricalParseWorkerResponse,
  HistoricalParseWorkerResponseType,
  historicalParseWorkerRequestSchema,
  historicalParseWorkerResponseSchema,
  requestIdFromWorkerMessage,
  summarizeHistoricalWorkerResponseIssues,
} from "./historical-parse-worker-protocol.js";
import { summarizeHistoricalWorkerStderr } from "./historical-parse-worker-stderr-sanitize.js";

const { utilityProcess } = electron;
const DEFAULT_PARSE_TIMEOUT_MS = 5 * 60_000;
const WORKER_STDIO: WorkerStdio = ["ignore", "ignore", "pipe"];

type WorkerStdio = ["ignore", "ignore", "pipe"];
type WorkerFatalErrorType = "FatalError";

type PendingParse = {
  resolve: (result: HistoricalParseResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  child: HistoricalParseWorkerProcess;
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
   * ISS-4573 / PR #4085 review (wongk): arm the TEST-ONLY poison-parse capability
   * in the forked worker. The main-process composition root sets this to `true`
   * ONLY after clearing the `!app.isPackaged` + E2E-sentinel gate. When true the
   * runner forks the worker with {@link E2E_POISON_WORKER_CAPABILITY_ENV} set to
   * the enabled sentinel; when false (production, and the default) it STRIPS any
   * inherited value from the worker env so a packaged/production worker can never
   * wedge a real parse off a leaked flag.
   */
  enablePoisonWorkerCapability?: boolean;
}): AbortableHistoricalParseRunner {
  return new UtilityProcessHistoricalParseRunner(
    options?.log ?? (() => {}),
    options?.forkWorker ?? forkHistoricalParseWorker,
    options?.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS,
    options?.enablePoisonWorkerCapability ?? false
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
  // ISS-4572 (shafty023 / wongk review): `stop()` rejects requests that already
  // reached `pending`, but closures chained on `dispatchTail` BEFORE stop have not
  // run `dispatchParse` yet — without a guard they would still fork a fresh worker
  // AFTER shutdown and run a full parse window ahead of a restarted generation.
  // Every `parseSource` captures this generation at enqueue; `stop()` bumps it, so
  // a queued turn whose generation is stale rejects on dispatch instead of spawning
  // a worker. Increment-on-stop keeps the runner reusable — a `parseSource` after a
  // stop starts a fresh generation and dispatches normally.
  private generation = 0;

  constructor(
    log: (message: string) => void,
    forkWorker: HistoricalParseWorkerFork,
    parseTimeoutMs: number,
    enablePoisonWorkerCapability: boolean
  ) {
    this.log = log;
    this.forkWorker = forkWorker;
    this.parseTimeoutMs = parseTimeoutMs;
    this.enablePoisonWorkerCapability = enablePoisonWorkerCapability;
  }

  parseSource(
    collectorKey: Harness,
    source: string,
    onDispatch?: () => void
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
    // rejects instead of forking a worker after shutdown (shafty023 / wongk).
    const enqueuedGeneration = this.generation;
    const result = this.dispatchTail.then(
      () =>
        this.dispatchParse(
          collectorKey,
          source,
          onDispatch,
          enqueuedGeneration
        ),
      () =>
        this.dispatchParse(collectorKey, source, onDispatch, enqueuedGeneration)
    );
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
    enqueuedGeneration = this.generation
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
    const parsedRequest = historicalParseWorkerRequestSchema.safeParse({
      type: HistoricalParseWorkerRequestType.ParseSource,
      requestId,
      collectorKey,
      source,
    });
    if (!parsedRequest.success) {
      return Promise.reject(new Error("invalid historical parse request"));
    }
    const request = parsedRequest.data;
    let child: HistoricalParseWorkerProcess;
    try {
      child = this.ensureChild();
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error))
      );
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error("historical parse worker timed out");
        this.rejectPendingForChild(child, error);
        this.killChild(child);
      }, this.parseTimeoutMs);
      timeout.unref();
      this.pending.set(requestId, { resolve, reject, timeout, child });
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
  }

  stop(): void {
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
    child.stderr?.on("data", (chunk: Buffer) => {
      const summary = summarizeHistoricalWorkerStderr(chunk);
      if (summary) {
        this.log(summary);
      }
    });
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
      // ISS-5266: carry the parse's side-report back with its sessions. The
      // field is optional on the wire, so a worker build that does not send one
      // (and every non-OpenCode parse) yields a plain `{ sessions }` here.
      pending.resolve({
        sessions: response.sessions,
        ...(response.withheldOpencodeSubagents
          ? { withheldOpencodeSubagents: response.withheldOpencodeSubagents }
          : {}),
      });
      return;
    }
    const error = errorFromHistoricalParseWorkerFailure(response);
    if (response.diagnostic) {
      this.log(`${response.message}: ${response.diagnostic}`);
    }
    pending.reject(error);
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
   * ISS-4573 / PR #4085 review (wongk): build the worker's env. The worker cannot
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

function forkHistoricalParseWorker(
  modulePath: string,
  args: string[],
  options: HistoricalParseWorkerForkOptions
): HistoricalParseWorkerProcess {
  return utilityProcess.fork(modulePath, args, options);
}
