/**
 * Desktop `SurfaceRoutingAdapter` (FEA-1513 Phase 4 / M-001).
 *
 * The desktop counterpart of `apps/app/lib/engineer/web-surface-routing-adapter.ts`.
 * It owns the desktop transport for `/api/gateway/*` requests: build a
 * surface-neutral `RelayHttpRequestPayload` from `(path, init)` and dispatch it
 * over the `desktop:gateway-dispatch` IPC channel exposed on
 * `window.desktopApi.dispatchGateway`. The trusted **main process** performs the
 * actual localhost call to the in-process gateway server (path allowlist + auth
 * live there — see `apps/desktop/src/main/gateway-dispatch-ipc.ts`). The renderer
 * never fetches `http://localhost:<port>` directly (contract Decision Q-002).
 *
 * SECURITY: this introduces no renderer-reachable local-execution path. The
 * adapter strips auth/identity headers before sending (defense-in-depth — main
 * re-strips and rebuilds from a safe-list), and ignores any `set-cookie` /
 * `x-desktop-*` headers the gateway might return.
 */

import { selectRoutingAdapter } from "@repo/shared-platform/gateway-dispatch";
import { methodAllowsBody } from "@repo/shared-platform/gateway-fetch-shim";
import {
  parseRelayResponseEnvelope,
  type RelayEncodedBody,
  type RelayHttpRequestPayload,
} from "@repo/shared-platform/relay-request-model";
import {
  getRoutingSelection,
  setRoutingAutoSelection,
} from "@repo/shared-platform/routing-store";
import {
  EngineerRoutingMode,
  type SurfaceRoutingAdapter,
} from "@repo/shared-platform/types";

/**
 * Headers the renderer must never forward to the gateway. Auth/identity headers
 * are minted in main; `x-desktop-force-approval` bypasses approval tiers. Main
 * re-strips these and rebuilds outbound headers from a safe-list (Task 6), so
 * this is defense-in-depth.
 */
const STRIPPED_REQUEST_HEADERS = [
  "authorization",
  "cookie",
  "x-desktop-gateway-token",
  "x-desktop-session-token",
  "x-desktop-source",
  "x-desktop-force-approval",
] as const;

function stripDangerousHeaders(
  source: HeadersInit | undefined
): Record<string, string> {
  const headers = new Headers(source);
  for (const name of STRIPPED_REQUEST_HEADERS) {
    headers.delete(name);
  }
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function encodeRequestBody(
  method: string,
  init: RequestInit | undefined,
  contentType: string | null
): RelayEncodedBody {
  if (!methodAllowsBody(method) || init?.body == null) {
    return { kind: "none" };
  }
  const body = init.body;
  if (typeof body === "string") {
    return { kind: "text", value: body, contentType };
  }
  if (body instanceof ArrayBuffer) {
    return { kind: "base64", value: arrayBufferToBase64(body), contentType };
  }
  // The shared fetch shim materializes bodies to an ArrayBuffer before dispatch,
  // so other shapes never reach here. v1 desktop gateway routes are GET-only.
  throw new Error("desktop gateway adapter: unsupported request body");
}

/** Statuses that forbid a response body per the Fetch spec. */
function isNullBodyStatus(status: number): boolean {
  return (
    status === 204 ||
    status === 205 ||
    status === 304 ||
    (status >= 100 && status < 200)
  );
}

function toResponse(raw: unknown): Response {
  const envelope = parseRelayResponseEnvelope(raw);
  if (!envelope) {
    return new Response(JSON.stringify({ error: "invalid gateway response" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  // MEDIUM-2: only a content-type passthrough; never surface set-cookie or any
  // x-desktop-* header from the gateway even if main failed to strip it.
  const responseHeaders = new Headers();
  responseHeaders.set(
    "content-type",
    envelope.headers?.["content-type"] ?? "application/json"
  );

  const bodyText =
    typeof envelope.body === "string"
      ? envelope.body
      : JSON.stringify(envelope.body);

  return new Response(isNullBodyStatus(envelope.status) ? null : bodyText, {
    status: envelope.status,
    headers: responseHeaders,
  });
}

async function dispatchDesktopGatewayRequest(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = new URL(path, globalThis.location.origin);
  const method = init?.method ? init.method.toUpperCase() : "GET";
  const headers = stripDangerousHeaders(init?.headers);
  const body = encodeRequestBody(method, init, headers["content-type"] ?? null);

  const payload: RelayHttpRequestPayload = {
    method,
    path: `${url.pathname}${url.search}`,
    headers,
    body,
  };

  const raw = await window.desktopApi.dispatchGateway(payload);
  return toResponse(raw);
}

/**
 * Create the desktop `SurfaceRoutingAdapter`. `supportsMode` is LocalElectron
 * only: CloudRelay is wired-but-inactive on desktop for v1 (CRITICAL-3 — do not
 * advertise a mode that would resolve to a stub/failure). Re-enable once a real
 * desktop CloudRelay branch exists in main.
 */
export function createDesktopRoutingAdapter(): SurfaceRoutingAdapter {
  return {
    surfaceName: "desktop",
    dispatchGatewayRequest: dispatchDesktopGatewayRequest,
    supportsMode: (mode) => mode === EngineerRoutingMode.LocalElectron,
  };
}

/**
 * Repair the persisted routing selection so the desktop adapter is always
 * selectable. The shared default is `CloudRelay` (routing-store) and a user may
 * have persisted/manually chosen `CloudRelay` — neither is supported by the
 * desktop adapter in v1, so `dispatchGatewayRequest` would throw
 * `NoRoutingAdapterError`. If no registered adapter supports the current mode,
 * coerce the selection to `LocalElectron` (forced, so a manual choice is also
 * repaired) and persist it. Idempotent: a no-op once the mode is supported.
 *
 * MUST be called AFTER `registerSurfaceRoutingAdapter(createDesktopRoutingAdapter())`
 * so `selectRoutingAdapter` can see the desktop adapter.
 */
export function ensureDesktopRoutingSelection(): void {
  const current = getRoutingSelection();
  if (selectRoutingAdapter(current.mode) !== null) {
    return;
  }
  setRoutingAutoSelection(
    EngineerRoutingMode.LocalElectron,
    current.computeTargetId,
    { force: true }
  );
}
