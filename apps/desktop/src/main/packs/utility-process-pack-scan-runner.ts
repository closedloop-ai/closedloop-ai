/**
 * @file utility-process-pack-scan-runner.ts — main-process driver for the
 * pure-compute pack-scan utilityProcess (FEA-3628).
 *
 * Runs in the MAIN process (the only place `utilityProcess.fork` is allowed);
 * the db-host owns the DB read (recent project roots) and the DB write (plan
 * replay), while this runner owns only the request/response cycle with the
 * worker that does the CPU-heavy scan. The pack-scan coordinator drives one
 * request at a time, so a single long-lived child is reused across scans and
 * torn down on failure/timeout.
 *
 * Mirrors `collectors/engine/utility-process-historical-parse-runner.ts`.
 */

import { fileURLToPath } from "node:url";
import electron from "electron";
import type { DefinitionScanRoots } from "./definition-discovery.js";
import {
  type DefinitionWire,
  errorFromPackScanWorkerFailure,
  type PackScanWorkerRequest,
  PackScanWorkerRequestType,
  type PackScanWorkerResponse,
  PackScanWorkerResponseType,
  packScanWorkerRequestSchema,
  packScanWorkerResponseSchema,
  requestIdFromWorkerMessage,
  summarizePackScanWorkerResponseIssues,
  summarizePackScanWorkerStderr,
  WORKER_INVALID_RESPONSE_MESSAGE_PREFIX,
} from "./pack-scan-worker-protocol.js";
import type { PackScanComputeResult } from "./pack-scanner.js";

const { utilityProcess } = electron;
const DEFAULT_SCAN_TIMEOUT_MS = 5 * 60_000;
const WORKER_STDIO: WorkerStdio = ["ignore", "ignore", "pipe"];

type WorkerStdio = ["ignore", "ignore", "pipe"];
type WorkerFatalErrorType = "FatalError";

type PendingBase = {
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  child: PackScanWorkerProcess;
};

/**
 * An in-flight request, tagged with the request TYPE it was sent as. The tag is
 * what lets a response be matched to the shape its caller is waiting on: a
 * `computed` reply arriving for a pending `definitions` request is a protocol
 * violation, not a result, and must reject rather than resolve the wrong type.
 */
type PendingScan = PendingBase &
  (
    | {
        kind: typeof PackScanWorkerRequestType.Run;
        resolve: (result: PackScanComputeResult) => void;
      }
    | {
        kind: typeof PackScanWorkerRequestType.Definitions;
        resolve: (result: DefinitionsComputeOutcome) => void;
      }
  );

/**
 * The worker's answer to a definitions request (ISS-5274).
 *
 * `omitted` is the complete-or-fall-back signal: the walk succeeded but the
 * payload exceeded the wire budget, so the caller must run the full on-host
 * walk instead. It is NOT an error — the child stays alive and healthy.
 */
export type DefinitionsComputeOutcome =
  | { omitted: false; definitions: DefinitionWire[] }
  | { omitted: true; reason: string };

type PackScanWorkerProcess = {
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
  postMessage(message: PackScanWorkerRequest): void;
  kill(): void;
};

type PackScanWorkerFork = (
  modulePath: string,
  args: string[],
  options: { serviceName: string; stdio: typeof WORKER_STDIO }
) => PackScanWorkerProcess;

export type PackScanRunner = {
  /** Run one pure-compute scan in the worker and return its serializable plan. */
  computeScan(recentProjectRoots: string[]): Promise<PackScanComputeResult>;
  /**
   * Walk the db-host-resolved scan roots in the worker and return the folded
   * definitions (ISS-5274). REQUIRED, not optional: an optional member would
   * let a call site silently skip the offload and leave the walk on the
   * db-host with every test still green.
   */
  computeDefinitions(
    scanRoots: DefinitionScanRoots
  ): Promise<DefinitionsComputeOutcome>;
  /** Reject any in-flight scan and tear down the worker. */
  stop(): void;
};

export function createUtilityProcessPackScanRunner(options?: {
  log?: (message: string) => void;
  forkWorker?: PackScanWorkerFork;
  scanTimeoutMs?: number;
}): PackScanRunner {
  return new UtilityProcessPackScanRunner(
    options?.log ?? (() => {}),
    options?.forkWorker ?? forkPackScanWorker,
    options?.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
  );
}

class UtilityProcessPackScanRunner implements PackScanRunner {
  private readonly log: (message: string) => void;
  private readonly forkWorker: PackScanWorkerFork;
  private readonly scanTimeoutMs: number;
  private readonly pending = new Map<string, PendingScan>();
  private readonly exitingChildren = new Set<PackScanWorkerProcess>();
  private child: PackScanWorkerProcess | null = null;
  private nextRequestId = 0;

  constructor(
    log: (message: string) => void,
    forkWorker: PackScanWorkerFork,
    scanTimeoutMs: number
  ) {
    this.log = log;
    this.forkWorker = forkWorker;
    this.scanTimeoutMs = scanTimeoutMs;
  }

  computeScan(recentProjectRoots: string[]): Promise<PackScanComputeResult> {
    return this.dispatch<PackScanComputeResult>(
      (requestId) => ({
        type: PackScanWorkerRequestType.Run,
        requestId,
        recentProjectRoots,
      }),
      (resolve, base) => ({
        kind: PackScanWorkerRequestType.Run,
        resolve,
        ...base,
      })
    );
  }

  computeDefinitions(
    scanRoots: DefinitionScanRoots
  ): Promise<DefinitionsComputeOutcome> {
    return this.dispatch<DefinitionsComputeOutcome>(
      (requestId) => ({
        type: PackScanWorkerRequestType.Definitions,
        requestId,
        scanRoots,
      }),
      (resolve, base) => ({
        kind: PackScanWorkerRequestType.Definitions,
        resolve,
        ...base,
      })
    );
  }

  /**
   * Validate, send, and await one worker request. Shared by both request types
   * so the timeout/teardown/postMessage-failure handling cannot drift between
   * them; the caller supplies only how to build its request and how to tag the
   * pending entry with the payload type it expects back.
   */
  private dispatch<T>(
    buildRequest: (requestId: string) => unknown,
    toPending: (
      resolve: (value: T) => void,
      base: PendingBase
    ) => PendingScan & { resolve: (value: T) => void }
  ): Promise<T> {
    const requestId = `pack-scan-${++this.nextRequestId}`;
    const parsedRequest = packScanWorkerRequestSchema.safeParse(
      buildRequest(requestId)
    );
    if (!parsedRequest.success) {
      return Promise.reject(new Error("invalid pack scan request"));
    }
    const request = parsedRequest.data;
    let child: PackScanWorkerProcess;
    try {
      child = this.ensureChild();
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error))
      );
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error("pack scan worker timed out");
        this.rejectPendingForChild(child, error);
        this.killChild(child);
      }, this.scanTimeoutMs);
      timeout.unref();
      this.pending.set(
        requestId,
        toPending(resolve, { reject, timeout, child })
      );
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
    this.rejectPending(new Error("pack scan worker stopped"));
    this.exitingChildren.clear();
    this.killChild();
  }

  private ensureChild(): PackScanWorkerProcess {
    if (this.child) {
      return this.child;
    }
    const workerPath = fileURLToPath(
      new URL("./pack-scan-worker.js", import.meta.url)
    );
    const child = this.forkWorker(workerPath, [], {
      serviceName: "closedloop-pack-scanner",
      stdio: WORKER_STDIO,
    });
    child.on("message", (message) => this.handleMessage(child, message));
    child.on("exit", (code) => this.handleChildExit(child, code));
    child.on("error", (type, location) =>
      this.handleChildError(child, type, location)
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      const summary = summarizePackScanWorkerStderr(chunk);
      if (summary) {
        this.log(summary);
      }
    });
    this.child = child;
    return child;
  }

  private handleMessage(child: PackScanWorkerProcess, message: unknown): void {
    if (!(this.child === child || this.exitingChildren.has(child))) {
      return;
    }
    const parsedResponse = packScanWorkerResponseSchema.safeParse(message);
    if (!parsedResponse.success) {
      const requestId = requestIdFromWorkerMessage(message);
      const error = new Error(
        requestId
          ? `${WORKER_INVALID_RESPONSE_MESSAGE_PREFIX} for ${requestId}`
          : WORKER_INVALID_RESPONSE_MESSAGE_PREFIX
      );
      this.rejectPendingForChild(child, error);
      this.killChild(child);
      this.log(
        `${error.message}: ${summarizePackScanWorkerResponseIssues(parsedResponse.error)}`
      );
      return;
    }
    this.resolveResponse(child, parsedResponse.data);
  }

  private handleChildExit(
    child: PackScanWorkerProcess,
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
        new Error(`pack scan worker exited with code ${String(code)}`)
      );
    });
  }

  private handleChildError(
    child: PackScanWorkerProcess,
    type: WorkerFatalErrorType,
    location: string
  ): void {
    if (this.child !== child) {
      return;
    }
    const message = `pack scan worker error: ${type} at ${location}`;
    this.log(message);
    this.rejectPendingForChild(child, new Error(message));
    this.killChild(child);
  }

  private resolveResponse(
    child: PackScanWorkerProcess,
    response: PackScanWorkerResponse
  ): void {
    if (response.type === PackScanWorkerResponseType.Failed && response.fatal) {
      const error = errorFromPackScanWorkerFailure(response);
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
    if (response.type === PackScanWorkerResponseType.Computed) {
      if (pending.kind !== PackScanWorkerRequestType.Run) {
        pending.reject(mismatchedResponseError(response.type, pending.kind));
        return;
      }
      pending.resolve(response.result);
      return;
    }
    if (response.type === PackScanWorkerResponseType.Definitions) {
      if (pending.kind !== PackScanWorkerRequestType.Definitions) {
        pending.reject(mismatchedResponseError(response.type, pending.kind));
        return;
      }
      pending.resolve({ omitted: false, definitions: response.definitions });
      return;
    }
    if (response.type === PackScanWorkerResponseType.DefinitionsOmitted) {
      if (pending.kind !== PackScanWorkerRequestType.Definitions) {
        pending.reject(mismatchedResponseError(response.type, pending.kind));
        return;
      }
      // Not a failure: the walk ran, the payload was too large to ship. The
      // child stays alive and the caller falls back to the on-host walk.
      pending.resolve({ omitted: true, reason: response.reason });
      return;
    }
    const error = errorFromPackScanWorkerFailure(response);
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
    child: PackScanWorkerProcess,
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

function mismatchedResponseError(
  responseType: string,
  pendingKind: string
): Error {
  return new Error(
    `pack scan worker replied "${responseType}" to a "${pendingKind}" request`
  );
}

function forkPackScanWorker(
  modulePath: string,
  args: string[],
  options: { serviceName: string; stdio: typeof WORKER_STDIO }
): PackScanWorkerProcess {
  return utilityProcess.fork(modulePath, args, options);
}
