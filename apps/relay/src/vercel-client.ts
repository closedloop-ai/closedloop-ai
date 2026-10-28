import {
  DESKTOP_POP_HEADER_NAMES,
  type DesktopPopHeaderName,
} from "@repo/api/src/types/api-key";
import {
  DESKTOP_HELLO_ACK_SOCKET_EVENT,
  type DesktopHelloAckMintingOrigin,
  toMintingApiOrigin,
} from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { redactSensitiveText } from "@repo/observability/redact";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import { INTERNAL_API_SECRET, VERCEL_API_URL } from "./relay-env.js";

export type DesktopPopHeaders = Partial<Record<DesktopPopHeaderName, string>>;

function toDesktopPopHeaders(value: unknown): DesktopPopHeaders | undefined {
  if (!(typeof value === "object" && value !== null)) {
    return undefined;
  }

  const result: DesktopPopHeaders = {};
  for (const headerName of DESKTOP_POP_HEADER_NAMES) {
    const headerValue = (value as Record<string, unknown>)[headerName];
    if (typeof headerValue === "string" && headerValue.trim().length > 0) {
      result[headerName] = headerValue;
    }
  }

  return result;
}

const VERCEL_CALL_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Vercel API client
// ---------------------------------------------------------------------------

async function callVercel<T = Record<string, unknown>>(
  path: string,
  body: unknown,
  extraHeaders?: DesktopPopHeaders
): Promise<{
  ok: boolean;
  status: number;
  data: T | null;
  responseUrl: string;
  contentType: string | null;
  rawBody: string;
}> {
  const response = await fetchVercel(`${VERCEL_API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": INTERNAL_API_SECRET as string,
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(VERCEL_CALL_TIMEOUT_MS),
  });
  const rawBody = await response.text();
  let data: T | null = null;

  try {
    data = JSON.parse(rawBody) as T;
  } catch {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    responseUrl: response.url,
    contentType: response.headers.get("content-type"),
    rawBody,
  };
}

async function validateApiKeyViaApi(
  apiKey: string,
  desktopPopHeaders?: DesktopPopHeaders
): Promise<{
  ok: boolean;
  context?: { organizationId: string; userId: string; clerkUserId?: string };
}> {
  log.info("validateApiKeyViaApi: calling API", {
    hasApiKey: Boolean(apiKey),
    url: `${VERCEL_API_URL}/internal/api-keys/verify`,
    hasDesktopPopHeaders:
      Object.keys(desktopPopHeaders ?? {}).length ===
      DESKTOP_POP_HEADER_NAMES.length,
  });

  const { ok, data, status, responseUrl, contentType, rawBody } =
    await callVercel(
      "/internal/api-keys/verify",
      {
        key: apiKey,
        desktopPopRequired: true,
      },
      desktopPopHeaders
    );

  log.info("validateApiKeyViaApi: API response", {
    ok,
    status,
    contentType,
    responseUrl,
    hasData: data !== null,
  });

  if (!(ok && data)) {
    log.error("validateApiKeyViaApi: verification failed - bad response", {
      status,
      responseUrl,
      contentType,
      responseLength: rawBody.length,
      errorClass: ErrorClass.Connection,
    });
    return { ok: false };
  }

  const payload = data.data;
  if (
    data.success !== true ||
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).organizationId !== "string" ||
    typeof (payload as Record<string, unknown>).userId !== "string"
  ) {
    log.warn("validateApiKeyViaApi: payload shape mismatch", {
      success: data.success,
      payloadType: typeof payload,
      payloadKeys:
        typeof payload === "object" && payload !== null
          ? Object.keys(payload)
          : [],
      hasOrgId:
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as Record<string, unknown>).organizationId === "string",
      hasUserId:
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as Record<string, unknown>).userId === "string",
      errorClass: ErrorClass.Connection,
    });
    return { ok: false };
  }

  const scopes = (payload as Record<string, unknown>).scopes;
  if (!(Array.isArray(scopes) && scopes.includes("write"))) {
    log.warn("validateApiKeyViaApi: missing write scope", {
      scopes,
      errorClass: ErrorClass.Connection,
    });
    return { ok: false };
  }

  log.info("validateApiKeyViaApi: success", {
    organizationId: (payload as Record<string, unknown>)
      .organizationId as string,
  });

  const clerkUserId =
    typeof (payload as Record<string, unknown>).clerkUserId === "string"
      ? ((payload as Record<string, unknown>).clerkUserId as string)
      : undefined;

  return {
    ok: true,
    context: {
      organizationId: (payload as Record<string, unknown>)
        .organizationId as string,
      userId: (payload as Record<string, unknown>).userId as string,
      ...(clerkUserId ? { clerkUserId } : {}),
    },
  };
}

export async function forwardSocketEvent(
  event: string,
  payload: unknown,
  auth?: { organizationId: string; userId: string; clerkUserId?: string },
  targetId?: string,
  gatewaySessionId?: string
): Promise<ForwardSocketEventResult> {
  if (event === "_relay.validate") {
    const apiKey =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).apiKey === "string"
        ? ((payload as Record<string, unknown>).apiKey as string)
        : null;
    const desktopPopHeaders =
      typeof payload === "object" && payload !== null
        ? toDesktopPopHeaders(
            (payload as Record<string, unknown>).desktopPopHeaders
          )
        : undefined;

    if (!apiKey) {
      return { emit: [], disconnect: true };
    }

    const result = await validateApiKeyViaApi(apiKey, desktopPopHeaders);
    if (!(result.ok && result.context)) {
      return { emit: [], disconnect: true };
    }

    return {
      emit: [
        {
          event: "_relay.auth",
          payload: result.context,
        },
      ],
    };
  }

  const { ok, data, status, responseUrl, contentType, rawBody } =
    await callVercel("/internal/relay/socket-event", {
      event,
      payload,
      auth,
      targetId,
      gatewaySessionId,
    });
  if (!(ok && data)) {
    log.error("Vercel socket-event call failed", {
      event,
      targetId,
      gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
      status,
      responseUrl,
      contentType,
      responseLength: rawBody.length,
      errorClass: ErrorClass.Protocol,
    });
    return { emit: [], forwardFailed: true };
  }
  const result = data as Record<string, unknown>;
  if (!Array.isArray(result.emit)) {
    log.error("forwardSocketEvent: expected data.emit to be an array", {
      event,
      targetId,
      gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
      emit: result.emit,
      errorClass: ErrorClass.Protocol,
    });
    return { emit: [], forwardFailed: true };
  }
  // `forwardFailed` is relay-local, and this body is peer-owned. A key of that
  // name arriving from the API -- a version-skewed build that gives it another
  // meaning, or a malformed truthy `"false"` -- would reach the `desktop.hello`
  // handler, which reads it as "the call produced no usable answer" and nacks
  // then disconnects a perfectly healthy connection. Drop it here so the
  // discriminator can only ever be set by the two failure returns above; every
  // other field passes through untouched, so a genuinely new API field stays
  // additive.
  const { forwardFailed, ...forwarded } = result;
  return statingMintingOrigin(
    forwarded as ForwardSocketEventResult,
    responseUrl
  );
}

/**
 * ISS-9081: state, on every `desktop.hello.ack` we forward, the API this relay
 * actually resolved the target against.
 *
 * On this transport the relay is the only participant that knows it. The desktop
 * dials `relayOrigin` and posts data to `apiOrigin` — two independent settings —
 * while the target row is minted in whatever environment `CLOSEDLOOP_API_URL`
 * names here, so the desktop could previously only assume the two agreed.
 *
 * Stamped here rather than at either construction site because both relayed ack
 * producers answer through this one call — the hello handshake
 * (`socket-event/service/hello-handler.ts`) and the sequence-gap re-ack
 * (`socket-event/service.ts`) — so a third cannot be added to the relayed path
 * without inheriting it.
 *
 * That is NOT every ack in the repo. `apps/api/lib/desktop-gateway-socket-server.ts`
 * emits its own `desktop.hello.ack` straight onto a direct-connect socket and
 * never reaches this module, so it states its own origin instead (ISS-9152) —
 * its configured `NEXT_PUBLIC_API_URL`, reduced by the same
 * `toMintingApiOrigin`
 * this module uses. The note on `DESKTOP_HELLO_ACK_SOCKET_EVENT` in
 * `@repo/api/src/types/compute-target` carries the detail.
 *
 * Omitted, never `null`, when unset: an absent field is what an older relay
 * sends and what the receiver treats as "no statement", and a `null` would be a
 * statement.
 */
function statingMintingOrigin(
  result: ForwardSocketEventResult,
  responseUrl: string
): ForwardSocketEventResult {
  // The origin that MINTED the target is the one the call actually landed on,
  // not the one it was aimed at (davetho, #6587). `fetch` follows a 307/308
  // cross-origin redirect transparently, so a relay configured for A but
  // redirected to B has its row minted by B; stating A there would hand the
  // desktop the exact crossed pairing this field exists to refuse. Falls back
  // to the configured URL only when the response names no usable one.
  //
  // Reduced to a bare origin because that is what the field is named and what
  // the receiver compares — `normalizeEnvironmentKey` takes `new URL(x).origin`
  // of whatever arrives, so the path `responseUrl` carries would be dropped
  // there anyway, and sending it would only make the wire value misleading.
  //
  // `index.ts` refuses to boot without `CLOSEDLOOP_API_URL`, so the second arm
  // is a type narrowing rather than a reachable state. Both are spelled as an
  // early return rather than a non-null assertion so the field is OMITTED if
  // that ever stops being true — a `mintingApiOrigin: undefined` would be a key
  // on the wire, and the receiver reads the key's presence, not its value.
  const mintingApiOrigin =
    toMintingApiOrigin(responseUrl) ?? toMintingApiOrigin(VERCEL_API_URL);
  if (!mintingApiOrigin) {
    return result;
  }
  const stated: DesktopHelloAckMintingOrigin = { mintingApiOrigin };
  return {
    ...result,
    emit: result.emit.map((instruction) =>
      instruction.event === DESKTOP_HELLO_ACK_SOCKET_EVENT &&
      typeof instruction.payload === "object" &&
      instruction.payload !== null
        ? { ...instruction, payload: { ...instruction.payload, ...stated } }
        : instruction
    ),
  };
}

/**
 * What a `forwardSocketEvent` call resolved to.
 *
 * `forwardFailed` is the discriminator the bare `{ emit: [] }` shape could not
 * carry. It separates "the API answered, and its answer had no work for this
 * socket" from "the call never produced a usable answer at all" -- a 5xx, a
 * non-JSON body, or a body whose `emit` was not an array. Only the first is a
 * legitimate quiet outcome; `desktop.hello` reads this to avoid leaving a
 * socket connected, unregistered and silent after the second (ISS-7976).
 *
 * Relay-owned, and set ONLY by this module's two failure returns -- a key of
 * the same name in the peer's JSON body is stripped, because a version-skewed
 * API introducing it would otherwise disconnect a healthy socket.
 *
 * Present only on those failure returns, so every handler that ignores it
 * keeps its existing behaviour.
 */
export type ForwardSocketEventResult = {
  targetId?: string;
  gatewaySessionId?: string;
  emit: Array<{ event: string; payload: unknown }>;
  disconnect?: boolean;
  forwardFailed?: true;
};

/**
 * `fetch` to the Vercel API with any credential scrubbed out of a transport
 * rejection before it escapes this module.
 *
 * This client is the one place that holds a raw `sk_live_` API key —
 * `_relay.validate` posts one on every socket handshake — and a transport
 * failure can quote the request that carried it. The relay's auth catch logs
 * that rejection under `error` (`index.ts`), so the credential is scrubbed at
 * the boundary that holds it rather than left to the log drain's own redaction,
 * which by its own contract (`@repo/observability/redact`) never reaches the
 * human-readable local console line. Scrubbing in place keeps the rejection's
 * type, `cause`, and identity intact for every caller that inspects it.
 *
 * `await` rather than `.catch()`: the relay's socket harnesses stub `fetch` with
 * a plain response-shaped object, which `await` resolves and `.catch` does not
 * exist on.
 */
async function fetchVercel(
  url: string,
  init: Parameters<typeof fetch>[1]
): ReturnType<typeof fetch> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof Error) {
      error.message = redactSensitiveText(error.message);
      if (typeof error.stack === "string") {
        error.stack = redactSensitiveText(error.stack);
      }
    }
    throw error;
  }
}
