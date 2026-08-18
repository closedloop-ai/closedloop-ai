/**
 * @file opencode-materialize-worker-protocol.ts
 * @description ISS-5337: the typed IPC contract between the main process and
 * the OpenCode materialize utilityProcess.
 *
 * One request per forked child (the runner forks a worker per pass and kills it
 * once the pass settles), so there is deliberately no `requestId` correlation
 * field here — the single in-flight pass IS the correlation. Everything is
 * Zod-validated at the boundary so a malformed worker payload can never reach
 * the sweep's log sink or be mistaken for a successful pass.
 *
 * Mirrors the shape of `packs/pack-scan-worker-protocol.ts`.
 */
import { z } from "zod";

export const OpencodeMaterializeWorkerRequestType = {
  Run: "run",
} as const;

export const OpencodeMaterializeWorkerResponseType = {
  Materialized: "materialized",
  Failed: "failed",
} as const;

/**
 * Diagnostics the pass emits ride back in the response rather than streaming,
 * so they are bounded on BOTH axes before crossing the boundary: a corpus where
 * every session fails to serialize would otherwise post one line per session.
 * The bound is reported, never silent — see {@link createBoundedWorkerLogBuffer}.
 */
export const MAX_WORKER_LOG_LINES = 200;
export const MAX_WORKER_LOG_LINE_CHARS = 500;

export const WORKER_INVALID_REQUEST_MESSAGE =
  "invalid opencode materialize request";
export const WORKER_INVALID_RESPONSE_MESSAGE =
  "opencode materialize worker sent an invalid response";

export const opencodeMaterializeWorkerRequestSchema = z.object({
  type: z.literal(OpencodeMaterializeWorkerRequestType.Run),
  stateDir: z.string().min(1),
});

export type OpencodeMaterializeWorkerRequest = z.infer<
  typeof opencodeMaterializeWorkerRequestSchema
>;

// Both axes are enforced here, not just the line count: without the per-line
// cap the boundary would happily admit 200 unbounded strings straight into the
// gateway log, and the clip in `createBoundedWorkerLogBuffer` would be a
// producer-side courtesy rather than a contract.
const workerLogsSchema = z
  .array(z.string().max(MAX_WORKER_LOG_LINE_CHARS))
  .max(MAX_WORKER_LOG_LINES);

export const opencodeMaterializeWorkerResponseSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal(OpencodeMaterializeWorkerResponseType.Materialized),
      logs: workerLogsSchema,
    }),
    z.object({
      type: z.literal(OpencodeMaterializeWorkerResponseType.Failed),
      message: z.string(),
      logs: workerLogsSchema,
    }),
  ]
);

export type OpencodeMaterializeWorkerResponse = z.infer<
  typeof opencodeMaterializeWorkerResponseSchema
>;

export function createMaterializedResponse(
  logs: string[]
): OpencodeMaterializeWorkerResponse {
  return {
    type: OpencodeMaterializeWorkerResponseType.Materialized,
    logs,
  };
}

export function createMaterializeFailedResponse(
  message: string,
  logs: string[]
): OpencodeMaterializeWorkerResponse {
  return {
    type: OpencodeMaterializeWorkerResponseType.Failed,
    message,
    logs,
  };
}

/**
 * A fixed-capacity sink for the pass's diagnostics. Lines past the cap are
 * COUNTED rather than kept, and `drain()` appends a suppression notice in their
 * place, so a bounded response never reads as "that was every diagnostic".
 */
export function createBoundedWorkerLogBuffer(): {
  push: (message: string) => void;
  drain: () => string[];
} {
  const kept: string[] = [];
  let suppressed = 0;
  return {
    push: (message: string) => {
      // Reserve the last slot for the suppression notice so `drain()` can never
      // exceed MAX_WORKER_LOG_LINES (the response schema's own bound).
      if (kept.length < MAX_WORKER_LOG_LINES - 1) {
        kept.push(clipWorkerLogLine(message));
        return;
      }
      suppressed += 1;
    },
    drain: () =>
      suppressed === 0
        ? [...kept]
        : [
            ...kept,
            `opencode materialize suppressed ${suppressed} further log line(s)`,
          ],
  };
}

/** Up to 5 Zod issues, each truncated, for a single-line diagnostic string. */
export function summarizeMaterializeResponseIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join(".");
      const where = path ? `${path}: ` : "";
      return `${where}${issue.message.slice(0, 160)}`;
    })
    .join("; ");
}

/** Clip to at most {@link MAX_WORKER_LOG_LINE_CHARS} INCLUDING the ellipsis, so
 * a clipped line still satisfies the response schema's per-line bound. */
function clipWorkerLogLine(message: string): string {
  return message.length > MAX_WORKER_LOG_LINE_CHARS
    ? `${message.slice(0, MAX_WORKER_LOG_LINE_CHARS - 1)}…`
    : message;
}
