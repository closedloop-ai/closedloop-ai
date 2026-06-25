import { fileURLToPath } from "node:url";
import electron from "electron";
import type { HistoricalParseRunner } from "./historical-parse-runner.js";
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
  summarizeHistoricalWorkerStderr,
} from "./historical-parse-worker-protocol.js";
import type { Harness, NormalizedSession } from "./types.js";

const { utilityProcess } = electron;
const DEFAULT_PARSE_TIMEOUT_MS = 5 * 60_000;
const WORKER_STDIO: WorkerStdio = ["ignore", "ignore", "pipe"];

type WorkerStdio = ["ignore", "ignore", "pipe"];
type WorkerFatalErrorType = "FatalError";

type PendingParse = {
  resolve: (sessions: NormalizedSession[]) => void;
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

type HistoricalParseWorkerFork = (
  modulePath: string,
  args: string[],
  options: {
    serviceName: string;
    stdio: typeof WORKER_STDIO;
  }
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
}): HistoricalParseRunner {
  return new UtilityProcessHistoricalParseRunner(
    options?.log ?? (() => {}),
    options?.forkWorker ?? forkHistoricalParseWorker,
    options?.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS
  );
}

class UtilityProcessHistoricalParseRunner implements HistoricalParseRunner {
  private readonly log: (message: string) => void;
  private readonly forkWorker: HistoricalParseWorkerFork;
  private readonly parseTimeoutMs: number;
  private readonly pending = new Map<string, PendingParse>();
  private readonly exitingChildren = new Set<HistoricalParseWorkerProcess>();
  private child: HistoricalParseWorkerProcess | null = null;
  private nextRequestId = 0;

  constructor(
    log: (message: string) => void,
    forkWorker: HistoricalParseWorkerFork,
    parseTimeoutMs: number
  ) {
    this.log = log;
    this.forkWorker = forkWorker;
    this.parseTimeoutMs = parseTimeoutMs;
  }

  parseSource(
    collectorKey: Harness,
    source: string
  ): Promise<NormalizedSession[]> {
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
    this.rejectPending(new Error("historical parse worker stopped"));
    this.exitingChildren.clear();
    this.killChild();
  }

  private ensureChild(): HistoricalParseWorkerProcess {
    if (this.child) {
      return this.child;
    }
    const workerPath = fileURLToPath(
      new URL("./historical-parse-worker.js", import.meta.url)
    );
    const child = this.forkWorker(workerPath, [], {
      serviceName: "closedloop-historical-parser",
      stdio: WORKER_STDIO,
    });
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
      pending.resolve(response.sessions);
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
}

function forkHistoricalParseWorker(
  modulePath: string,
  args: string[],
  options: {
    serviceName: string;
    stdio: typeof WORKER_STDIO;
  }
): HistoricalParseWorkerProcess {
  return utilityProcess.fork(modulePath, args, options);
}
