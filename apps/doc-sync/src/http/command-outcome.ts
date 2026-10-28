import { log } from "@repo/observability/log";
import type { MiddlewareHandler } from "hono";
import { DocSyncCount, emitDocSyncMetric } from "../telemetry/metrics";

/** The `command` tag on `doc_sync_internal_command_failures`: one per `/internal` route. */
export const InternalCommandLabel = {
  ListDocuments: "list_documents",
  Clear: "clear",
  CommentAnchor: "comment_anchor",
  ReadText: "read_text",
  Delete: "delete",
  SeedVersion: "seed_version",
  FirstOpenSeed: "first_open_seed",
  SeedIfNeverStored: "seed_if_never_stored",
  Revoke: "revoke",
  Disconnect: "disconnect",
  /** A request answered before any route ran: the OIDC check, the rate limit, a 404. */
  Unrouted: "unrouted",
} as const;
export type InternalCommandLabel =
  (typeof InternalCommandLabel)[keyof typeof InternalCommandLabel];

export const DOC_SYNC_INTERNAL_COMMAND_FAILED_EVENT =
  "doc_sync.internal_command_failed";

export type InternalCommandEnv = {
  Variables: { internalCommand: InternalCommandLabel | undefined };
};

/** A route's first handler: names the command its outcome is counted under. */
export function commandLabel(
  label: InternalCommandLabel
): MiddlewareHandler<InternalCommandEnv> {
  return async (c, next) => {
    c.set("internalCommand", label);
    await next();
  };
}

/**
 * The first `/internal` middleware: once the response is settled, a status of
 * 500 or more counts one `doc_sync_internal_command_failures` and logs
 * {@link DOC_SYNC_INTERNAL_COMMAND_FAILED_EVENT}, under the route's
 * {@link commandLabel}, or `unrouted` when no route ran.
 */
export function recordInternalCommandOutcome(): MiddlewareHandler<InternalCommandEnv> {
  return async (c, next) => {
    await next();
    const { status } = c.res;
    if (status < HTTP_SERVER_ERROR_FLOOR) {
      return;
    }
    const command = c.get("internalCommand") ?? InternalCommandLabel.Unrouted;
    emitDocSyncMetric({
      metric: DocSyncCount.InternalCommandFailures,
      count: 1,
      command,
      httpStatus: status,
    });
    log.error("Doc sync internal command failed", {
      event: DOC_SYNC_INTERNAL_COMMAND_FAILED_EVENT,
      command,
      status,
    });
  };
}

const HTTP_SERVER_ERROR_FLOOR = 500;
