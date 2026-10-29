import { emptyNotFound, serviceErrorHandler } from "@repo/http-service/errors";
import { requireInternalOidc } from "@repo/http-service/internal-auth";
import {
  type NodeBindings,
  rawRequestPath,
} from "@repo/http-service/node-listener";
import { tokenBucketRateLimit } from "@repo/http-service/rate-limit";
import {
  DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
  DocSyncDocumentCommand,
} from "@repo/realtime-contract/doc-sync-internal";
import { Hono, type MiddlewareHandler } from "hono";
import { recordInternalCommandOutcome } from "./command-outcome";
import type { DocSyncHttpDeps } from "./deps";
import { healthRoutes } from "./health";
import { createInternalRoutes } from "./internal-routes";

/**
 * Every HTTP route the service serves, on the raw request path. `/internal/*`
 * admits only the API's Vercel OIDC token (ISS-12506), then draws on an
 * instance-wide rate limit that `GET /health` never touches. The first-open
 * seed has a bucket of its own, because every token mint calls it and a
 * reconnect storm must not spend the bucket revoke and publish draw on
 * (ISS-12508). Every response
 * it answers 500 or more, a refusal at the mount included, is counted by
 * command (PLN-2201 T-3.6). The mount carries no body cap: each command route
 * applies its own, because mount middleware runs first and would override a
 * larger per-route cap.
 */
export function createDocSyncHttpApp(
  deps: DocSyncHttpDeps
): Hono<{ Bindings: NodeBindings }> {
  const app = new Hono<{ Bindings: NodeBindings }>({
    getPath: rawRequestPath,
  });
  app.route("/", healthRoutes(deps.health));
  app.use(
    `${INTERNAL_PATH}/*`,
    recordInternalCommandOutcome(),
    requireInternalOidc(deps.verifyOidc),
    internalRateLimit()
  );
  app.route(INTERNAL_PATH, createInternalRoutes(deps));
  app.notFound(emptyNotFound);
  app.onError(serviceErrorHandler(DOC_SYNC_INTERNAL_REQUEST_FAULT_EVENT));
  return app;
}

const INTERNAL_PATH = "/internal";

/** Realtime's values (GAP-006); ISS-12509's load test tunes them. */
export const INTERNAL_REQUEST_BURST = 500;
export const INTERNAL_REQUEST_REFILL_PER_SECOND = 200;
export const FIRST_OPEN_SEED_REQUEST_BURST = INTERNAL_REQUEST_BURST;
export const FIRST_OPEN_SEED_REQUEST_REFILL_PER_SECOND =
  INTERNAL_REQUEST_REFILL_PER_SECOND;

const FIRST_OPEN_SEED_PATH = new RegExp(
  `^${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/[^/]+/(?:${DocSyncDocumentCommand.FirstOpenSeed}|${DocSyncDocumentCommand.SeedIfNeverStored})$`
);

function internalRateLimit(): MiddlewareHandler {
  const commands = tokenBucketRateLimit({
    burst: INTERNAL_REQUEST_BURST,
    refillPerSecond: INTERNAL_REQUEST_REFILL_PER_SECOND,
  });
  const firstOpenSeed = tokenBucketRateLimit({
    burst: FIRST_OPEN_SEED_REQUEST_BURST,
    refillPerSecond: FIRST_OPEN_SEED_REQUEST_REFILL_PER_SECOND,
  });
  return (c, next) =>
    FIRST_OPEN_SEED_PATH.test(c.req.path)
      ? firstOpenSeed(c, next)
      : commands(c, next);
}

export const DOC_SYNC_INTERNAL_REQUEST_FAULT_EVENT =
  "doc_sync.internal_request_fault";
