/**
 * @file opencode-materialize-pass.ts
 * @description ISS-5337: the body of the OpenCode materialize utilityProcess,
 * split from its entry point (`opencode-materialize-worker.ts`) so it is
 * reachable from a test without `process.parentPort`.
 *
 * This is the "extract the registration into a testable function" shape
 * `apps/desktop/AGENTS.md` prescribes: the entry does nothing but register the
 * `message` listener and post what this returns, and every decision the worker
 * makes — request validation, log bounding, throw-to-`Failed` mapping — is here.
 */
import {
  createBoundedWorkerLogBuffer,
  createMaterializedResponse,
  createMaterializeFailedResponse,
  type OpencodeMaterializeWorkerResponse,
  opencodeMaterializeWorkerRequestSchema,
  WORKER_INVALID_REQUEST_MESSAGE,
} from "./opencode-materialize-worker-protocol.js";
import {
  materializeOpencodeTranscripts,
  type OpencodeMaterializerDeps,
} from "./opencode-materializer.js";

/** The materialize entry point, injectable so the pass is testable without a DB. */
export type MaterializeFn = (
  stateDir: string,
  deps: OpencodeMaterializerDeps
) => void;

/**
 * Run one materialize pass for a worker request and return the response to post.
 * Never throws: a malformed request and a throwing pass both map to `Failed`, so
 * the runner always settles on a message rather than on the child's exit.
 */
export function runOpencodeMaterializePass(
  message: unknown,
  materialize: MaterializeFn = materializeOpencodeTranscripts
): OpencodeMaterializeWorkerResponse {
  const parsedRequest =
    opencodeMaterializeWorkerRequestSchema.safeParse(message);
  if (!parsedRequest.success) {
    return createMaterializeFailedResponse(WORKER_INVALID_REQUEST_MESSAGE, []);
  }
  // The pass's own diagnostics are collected rather than logged here: this
  // process has no gateway log sink, so they ride back to the runner, which
  // replays them into the same `transcript-sync` channel the in-process pass
  // used to write to directly.
  const logs = createBoundedWorkerLogBuffer();
  try {
    materialize(parsedRequest.data.stateDir, {
      log: (line) => logs.push(line),
    });
  } catch (error) {
    // Partial diagnostics still ride back — they are usually what explains the
    // throw. The runner rejects, and the sweep keeps the existing projections.
    return createMaterializeFailedResponse(
      error instanceof Error ? error.message : String(error),
      logs.drain()
    );
  }
  return createMaterializedResponse(logs.drain());
}
