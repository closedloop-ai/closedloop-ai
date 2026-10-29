import { internalBodyLimit } from "@repo/http-service/body-limit";
import { describeCause } from "@repo/http-service/describe-cause";
import { emptyResponse, serviceErrorHandler } from "@repo/http-service/errors";
import {
  type InternalAuthVariables,
  requireInternalOidc,
} from "@repo/http-service/internal-auth";
import {
  createInternalOidcVerifier as createOidcVerifier,
  type InternalOidcConfig,
  type InternalOidcVerifier,
  type InternalOidcVerifierOptions,
} from "@repo/http-service/internal-oidc";
import { jsonBody } from "@repo/http-service/json-body";
import type { NodeBindings } from "@repo/http-service/node-listener";
import { tokenBucketRateLimit } from "@repo/http-service/rate-limit";
import { log } from "@repo/observability/log";
import { parseChannelAddress } from "@repo/realtime-contract/channels";
import {
  type BusMessage,
  BusOp,
  internalPublishBodySchema,
  internalRevokeBodySchema,
  RealtimeInternalPath,
} from "@repo/realtime-contract/internal";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { revokeTargetField } from "../bus/apply";
import type { RealtimeBus } from "../bus/bus";
import {
  type InternalRequestRecord,
  recordInternalRequest,
} from "../telemetry/spans";

export type InternalHandlerOptions = {
  verifyOidc: InternalOidcVerifier;
  bus: Pick<RealtimeBus, "publish">;
  now?: () => number;
};

/** What {@link internalRoutes} learns about a request, for its record. */
type InternalRecordVariables = {
  internalAuth?: InternalAuth;
  described?: Pick<InternalRequestRecord, "kind" | "type" | "revokeTarget">;
};

/**
 * PLN-2105 step 6: `POST /internal/publish` and `POST /internal/revoke`. A
 * request is refused in this order: a method other than POST (405), then
 * anything but `apps/api`'s Vercel OIDC bearer token (401, or 503 while the
 * JWKS is unreachable; ISS-11966), then an instance-wide rate limit that
 * client traffic never draws on (429), then a body past the cap (400), then a
 * body the path's Zod schema refuses, whatever its content-type (400). An
 * accepted request is published to the bus and answered 202, and every
 * instance applies it from its own subscription; a bus that refuses it is a
 * 503. Every answer is recorded. The IP allowlist and WAF in front of these
 * endpoints are ISS-11210's.
 */
export function internalRoutes(
  options: InternalHandlerOptions
): Hono<InternalEnv> {
  const app = new Hono<InternalEnv>();
  const authenticate = requireInternalOidc(options.verifyOidc);
  const rateLimit = tokenBucketRateLimit(
    {
      burst: INTERNAL_REQUEST_BURST,
      refillPerSecond: INTERNAL_REQUEST_REFILL_PER_SECOND,
    },
    options.now ?? Date.now,
    { code: null }
  );
  const capBody = internalBodyLimit({
    maxBytes: MAX_INTERNAL_BODY_BYTES,
    status: HTTP_BAD_REQUEST,
    code: null,
  });
  const { Publish, Revoke } = RealtimeInternalPath;
  app.all(Publish, recordInternalRequests(Publish), postOnly);
  app.post(
    Publish,
    authenticate,
    markOidc,
    rateLimit,
    capBody,
    jsonBody(internalPublishBodySchema, ANY_CONTENT_TYPE),
    (c) =>
      publishToBus(
        c,
        Publish,
        { op: BusOp.Publish, ...c.req.valid("json") },
        options.bus
      )
  );
  app.all(Revoke, recordInternalRequests(Revoke), postOnly);
  app.post(
    Revoke,
    authenticate,
    markOidc,
    rateLimit,
    capBody,
    jsonBody(internalRevokeBodySchema, ANY_CONTENT_TYPE),
    (c) =>
      publishToBus(
        c,
        Revoke,
        { op: BusOp.Revoke, target: c.req.valid("json").target },
        options.bus
      )
  );
  // Only these routes log the internal fault event: monitors read it as the
  // API-to-realtime publish path failing (PR #9087 review).
  app.onError(
    serviceErrorHandler(INTERNAL_REQUEST_FAULT_EVENT, {
      message: INTERNAL_REQUEST_FAULT_MESSAGE,
      code: null,
    })
  );
  return app;
}

/**
 * Records every answer on `path` once the rest of the chain has run, a fault's
 * 500 included: a throw sets `c.error` and leaves `onError`'s answer in
 * `c.res`, and is recorded with its path and status alone.
 */
function recordInternalRequests(
  path: RealtimeInternalPath
): MiddlewareHandler<InternalEnv> {
  return async (c, next) => {
    await next();
    const { status } = c.res;
    if (c.error) {
      recordInternalRequest({ path, status });
      return;
    }
    const auth = c.get("internalAuth");
    const oidcRejection = c.get("internalOidcRejection");
    recordInternalRequest({
      path,
      status,
      ...(auth === undefined ? {} : { auth }),
      ...(oidcRejection === undefined ? {} : { oidcRejection }),
      ...c.get("described"),
    });
  };
}

const postOnly: MiddlewareHandler<InternalEnv> = async (c, next) => {
  if (c.req.method !== "POST") {
    return emptyResponse(c, HTTP_METHOD_NOT_ALLOWED);
  }
  await next();
};

const markOidc: MiddlewareHandler<InternalEnv> = async (c, next) => {
  c.set("internalAuth", InternalAuth.Oidc);
  await next();
};

async function publishToBus(
  c: Context<InternalEnv>,
  path: RealtimeInternalPath,
  message: BusMessage,
  bus: Pick<RealtimeBus, "publish">
): Promise<Response> {
  c.set("described", describeMessage(message));
  try {
    await bus.publish(message);
  } catch (error) {
    log.warn("Realtime bus publish failed", {
      event: BUS_PUBLISH_FAILED_EVENT,
      path,
      cause: describeCause(error),
    });
    return emptyResponse(c, HTTP_SERVICE_UNAVAILABLE);
  }
  return emptyResponse(c, HTTP_ACCEPTED);
}

function describeMessage(
  message: BusMessage
): Pick<InternalRequestRecord, "kind" | "type" | "revokeTarget"> {
  if (message.op === BusOp.Publish) {
    return {
      kind: parseChannelAddress(message.channel)?.kind,
      type: message.type,
    };
  }
  return { revokeTarget: revokeTargetField(message.target) };
}

const ANY_CONTENT_TYPE = { anyContentType: true, code: null };
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * Instance-wide, apart from every client connection's bucket. `apps/api`
 * publishes once per request that changes something a client watches; the
 * burst absorbs a batch of those, and the refill is the sustained rate one
 * instance accepts. ISS-11210's load test tunes both.
 */
export const INTERNAL_REQUEST_BURST = 500;
export const INTERNAL_REQUEST_REFILL_PER_SECOND = 200;
/** Well past any body the signal byte cap allows, whitespace included. */
export const MAX_INTERNAL_BODY_BYTES = 16 * 1024;

export const BUS_PUBLISH_FAILED_EVENT = "realtime.bus_publish_failed";
export const INTERNAL_REQUEST_FAULT_EVENT = "realtime.internal_request_fault";
/** Monitors may match on this message (GAP-002). */
export const INTERNAL_REQUEST_FAULT_MESSAGE =
  "Realtime internal request failed";

export const InternalAuth = {
  Oidc: "oidc",
} as const;
export type InternalAuth = (typeof InternalAuth)[keyof typeof InternalAuth];

/** The `@repo/http-service` verifier, logging a JWKS outage as realtime's own event. */
export function createInternalOidcVerifier(
  config: InternalOidcConfig,
  options: Omit<InternalOidcVerifierOptions, "unavailableEvent"> = {}
): InternalOidcVerifier {
  return createOidcVerifier(config, {
    ...options,
    unavailableEvent: INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT,
  });
}

export const INTERNAL_OIDC_JWKS_UNAVAILABLE_EVENT =
  "realtime.internal_oidc_jwks_unavailable";

type InternalEnv = {
  Bindings: NodeBindings;
  Variables: InternalAuthVariables & InternalRecordVariables;
};
