import {
  isItemScopedSessionMeshForbiddenCode,
  sessionMeshForbiddenBodyValidator,
} from "@repo/api/src/types/session-mesh";
import { z } from "zod";

/**
 * A non-2xx answer from the Session Mesh cloud, carrying its status and — for a
 * `403` whose body this build could parse — the API error code that came with
 * it. `code` is `null` when there was no parseable code: an HTML `403` from a
 * proxy in front of the API is exactly that case, and it is not an answer about
 * any one operation.
 */
export class SessionMeshCloudError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null = null) {
    super(`Session Mesh cloud returned ${status}`);
    // `name` is deliberately NOT overridden: `String(error)` is logged when an
    // operation is abandoned and read by operators, and this subclass adds a
    // status to carry, not a new message. The code is deliberately kept OUT of
    // the message for the same reason — every retained reason string would
    // change.
    this.status = status;
    this.code = code;
  }
}

/**
 * Whether the cloud refused THIS operation rather than being unreachable.
 *
 * A 400 is an answer about one body — this build sent bytes the server's own
 * validator rejects — so later operations can still be accepted and the drain
 * moves on to them.
 *
 * A 403 is only item-scoped when its VALIDATED API code says so, e.g. the
 * `session_mesh_publish_forbidden` a publish gets once its author presence has
 * expired (`apps/api/app/session-mesh/service.ts`). The status alone is not
 * enough: an HTML 403 from a proxy in front of the API, or a
 * `session_mesh_disabled` rollout denial, refuses every queued operation
 * equally, and treating one as item-scoped would send and abandon up to twenty
 * of them instead of stopping after the first. An unparseable or unrecognised
 * code therefore stops the drain.
 *
 * Anything else (timeout, 401, 429, 5xx) says the same about every queued
 * operation, so the drain stops there too.
 */
export function isItemScopedSessionMeshRejection(error: unknown): boolean {
  if (!(error instanceof SessionMeshCloudError)) {
    return false;
  }
  if (error.status === 400) {
    return true;
  }
  return (
    error.status === 403 && isItemScopedSessionMeshForbiddenCode(error.code)
  );
}

const removedResponse = z.object({ removed: z.number().int().nonnegative() });
const publishResponse = z.object({
  message: z.object({ id: z.string().uuid() }),
});
const presenceResponse = z.object({
  presence: z.object({ agentId: z.string() }),
});
const feedbackResponse = z.object({
  event: z.object({ id: z.string().min(1) }),
});
const updatedResponse = z.object({ updated: z.number().int().nonnegative() });

/**
 * Reject a drained operation whose response does not match the shape its path
 * promises, so a silently-changed contract is logged as an abandoned operation
 * rather than counted as one the cloud accepted. Throws; never returns a verdict.
 */
export function assertSessionMeshResponse(
  path: string,
  method: string,
  response: unknown
): void {
  if (method === "DELETE") {
    removedResponse.parse(response);
    return;
  }
  if (path === "/session-mesh/messages") {
    publishResponse.parse(response);
    return;
  }
  if (path === "/session-mesh/presence") {
    presenceResponse.parse(response);
    return;
  }
  if (path === "/session-mesh/feedback") {
    feedbackResponse.parse(response);
    return;
  }
  updatedResponse.parse(response);
}

/**
 * The API error code in a `403` body, or `null` when there is none this build
 * can read. Narrow in the same direction as `isSessionMeshDenialBody`: a body
 * that is not JSON, or not the shape every Session Mesh route answers with, is
 * not the API talking and must not be read as a verdict about one operation.
 */
export function parseSessionMeshForbiddenCode(text: string): string | null {
  try {
    const parsed = sessionMeshForbiddenBodyValidator.safeParse(
      JSON.parse(text)
    );
    return parsed.success ? parsed.data.code : null;
  } catch {
    return null;
  }
}
