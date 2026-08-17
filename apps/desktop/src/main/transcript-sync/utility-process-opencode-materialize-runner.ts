/**
 * @file utility-process-opencode-materialize-runner.ts
 * @description ISS-5337: the main-process driver for the OpenCode materialize
 * utilityProcess (`opencode-materialize-worker.ts`).
 *
 * `utilityProcess.fork` is only available in the main process, so this runner
 * lives here; everything it drives — the foreign-SQLite read, the per-session
 * serialization, and the byte-compare against every existing projection — runs
 * in the child, which is what keeps the sweep off the main event loop.
 *
 * A child is forked PER PASS and killed as soon as the pass settles, rather than
 * kept alive like the historical-parse/pack-scan runners: the discovery sweep
 * that drives materialization runs on a 30-minute cadence (plus the occasional
 * tier-change kick), so a resident process would idle far longer than it works.
 *
 * Passes are single-flighted. The pass used to be a synchronous main-process
 * call, which the event loop serialized for free; now that it is asynchronous,
 * two overlapping sweeps could otherwise run two passes against the same
 * materialized root, where the older pass's prune can delete a projection the
 * newer one just published.
 *
 * The child's stdio is deliberately left at Electron's default (stderr
 * inherited) rather than piped into `gatewayLog` the way the pack-scan and
 * historical-parse runners do. Their sanitizer —
 * `collectors/engine/historical-parse-worker-stderr-sanitize.ts`, which is what
 * makes piped stderr safe to log by redacting paths and credentials — lives
 * under `src/main/collectors/`, and this runner is on the boot static-import
 * graph, where dependency-cruiser's `boot-no-design-system-runtime` rule forbids
 * reaching into that tree. Piping stderr into the log UNsanitized would be worse
 * than not piping it, and a third copy of that 140-line redactor worse still.
 * Inheriting matches what the pass already did when it ran in the main process,
 * and the runner still logs `exited with code N` / the worker's own diagnostics.
 */
import { fileURLToPath } from "node:url";
import electron from "electron";
import {
  type OpencodeMaterializeWorkerRequest,
  OpencodeMaterializeWorkerRequestType,
  type OpencodeMaterializeWorkerResponse,
  OpencodeMaterializeWorkerResponseType,
  opencodeMaterializeWorkerResponseSchema,
  summarizeMaterializeResponseIssues,
  WORKER_INVALID_RESPONSE_MESSAGE,
} from "./opencode-materialize-worker-protocol.js";

const { utilityProcess } = electron;
const DEFAULT_MATERIALIZE_TIMEOUT_MS = 5 * 60_000;
const WORKER_SERVICE_NAME = "closedloop-opencode-materializer";

type WorkerFatalErrorType = "FatalError";

export type OpencodeMaterializeWorkerProcess = {
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
  postMessage(message: OpencodeMaterializeWorkerRequest): void;
  kill(): void;
};

export type OpencodeMaterializeWorkerFork = (
  modulePath: string,
  args: string[],
  options: { serviceName: string }
) => OpencodeMaterializeWorkerProcess;

export type OpencodeMaterializeRunner = {
  /**
   * Re-derive the OpenCode projections in the worker. Rejects when the pass
   * failed, the worker died, or it outran the timeout; the caller (the discovery
   * sweep) logs and proceeds with the existing projections.
   *
   * Single-flighted: an overlapping sweep joins the in-flight pass rather than
   * starting a second one, so it observes the store as of that pass's start
   * rather than its own. That is inside the lane's existing eventual-consistency
   * window — the fingerprint gate already means projections trail `opencode.db`
   * until a sweep re-derives them — and the next sweep picks up the difference.
   */
  materialize(): Promise<void>;
  /**
   * Cancel the in-flight pass and kill its worker. Required by the lane's
   * shutdown contract (ISS-4903): `TranscriptSyncService.stop()` runs BEFORE
   * `quiesceDesktopSyncLanes`, on a 2s budget, and the sweep awaiting this pass
   * is one of the detached tasks the quiesce waits for. Without a cancel the
   * sweep can stay parked for the whole 5-minute timeout, miss the budget, and
   * resume against an already-disposed db-host — and the worker would keep
   * writing projections after the lane reported itself stopped.
   */
  stop(): void;
};

export function createUtilityProcessOpencodeMaterializeRunner(options: {
  stateDir: string;
  log?: (message: string) => void;
  forkWorker?: OpencodeMaterializeWorkerFork;
  materializeTimeoutMs?: number;
}): OpencodeMaterializeRunner {
  return new UtilityProcessOpencodeMaterializeRunner(
    options.stateDir,
    options.log ?? (() => undefined),
    options.forkWorker ?? forkOpencodeMaterializeWorker,
    options.materializeTimeoutMs ?? DEFAULT_MATERIALIZE_TIMEOUT_MS
  );
}

class UtilityProcessOpencodeMaterializeRunner
  implements OpencodeMaterializeRunner
{
  private readonly stateDir: string;
  private readonly log: (message: string) => void;
  private readonly forkWorker: OpencodeMaterializeWorkerFork;
  private readonly materializeTimeoutMs: number;
  private inFlight: Promise<void> | null = null;
  /** Settles the in-flight pass early (kills its child); null when idle. */
  private cancelInFlight: ((error: Error) => void) | null = null;

  constructor(
    stateDir: string,
    log: (message: string) => void,
    forkWorker: OpencodeMaterializeWorkerFork,
    materializeTimeoutMs: number
  ) {
    this.stateDir = stateDir;
    this.log = log;
    this.forkWorker = forkWorker;
    this.materializeTimeoutMs = materializeTimeoutMs;
  }

  materialize(): Promise<void> {
    const existing = this.inFlight;
    if (existing) {
      return existing;
    }
    const pass = this.runPass().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = pass;
    return pass;
  }

  stop(): void {
    this.cancelInFlight?.(new Error("opencode materialize worker stopped"));
  }

  private runPass(): Promise<void> {
    let child: OpencodeMaterializeWorkerProcess;
    try {
      child = this.forkChild();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // Every exit path funnels through here so the child is always reaped and
      // the late `exit` that follows a kill can never re-settle the promise.
      const settle = (error: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.cancelInFlight = null;
        clearTimeout(timeout);
        child.kill();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      // Published synchronously (the executor runs before `runPass` returns) so
      // `stop()` can reach this pass for its whole lifetime.
      this.cancelInFlight = settle;
      const timeout = setTimeout(
        () => settle(new Error("opencode materialize worker timed out")),
        this.materializeTimeoutMs
      );
      timeout.unref();
      child.on("message", (message) =>
        settle(this.errorFromWorkerMessage(message))
      );
      child.on("exit", (code) =>
        settle(
          new Error(
            `opencode materialize worker exited with code ${String(code)}`
          )
        )
      );
      child.on("error", (type, location) =>
        settle(
          new Error(`opencode materialize worker error: ${type} at ${location}`)
        )
      );
      try {
        child.postMessage({
          type: OpencodeMaterializeWorkerRequestType.Run,
          stateDir: this.stateDir,
        });
      } catch (error) {
        settle(toError(error));
      }
    });
  }

  /**
   * Validate one worker message, replay the pass's diagnostics into the sweep's
   * log sink, and report the pass outcome as `null` (materialized) or the error
   * to reject with.
   */
  private errorFromWorkerMessage(message: unknown): Error | null {
    const parsed = opencodeMaterializeWorkerResponseSchema.safeParse(message);
    if (!parsed.success) {
      this.log(
        `${WORKER_INVALID_RESPONSE_MESSAGE}: ${summarizeMaterializeResponseIssues(parsed.error)}`
      );
      return new Error(WORKER_INVALID_RESPONSE_MESSAGE);
    }
    const response: OpencodeMaterializeWorkerResponse = parsed.data;
    for (const line of response.logs) {
      this.log(line);
    }
    if (response.type === OpencodeMaterializeWorkerResponseType.Materialized) {
      return null;
    }
    return new Error(response.message);
  }

  private forkChild(): OpencodeMaterializeWorkerProcess {
    const workerPath = fileURLToPath(
      new URL("./opencode-materialize-worker.js", import.meta.url)
    );
    return this.forkWorker(workerPath, [], {
      serviceName: WORKER_SERVICE_NAME,
    });
  }
}

function forkOpencodeMaterializeWorker(
  modulePath: string,
  args: string[],
  options: { serviceName: string }
): OpencodeMaterializeWorkerProcess {
  return utilityProcess.fork(modulePath, args, options);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
