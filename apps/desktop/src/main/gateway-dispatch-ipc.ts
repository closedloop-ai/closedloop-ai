/**
 * Main-process handler for the `desktop:gateway-dispatch` IPC channel
 * (FEA-1513 Phase 4 / M-001). ⚠️ SECURITY-CRITICAL — this is the desktop
 * counterpart of the web `apps/app/proxy.ts` localhost guard.
 *
 * The renderer's `SurfaceRoutingAdapter` sends a surface-neutral
 * `RelayHttpRequestPayload`; this handler validates it fail-closed at every
 * step, then performs a loopback `fetch` to the in-process gateway server. That
 * reuses the entire existing router / operation / sandbox / approval guard stack
 * (per CLAUDE.md "do NOT reimplement gateway operations") — the loopback pattern
 * mirrors `cloud-command-executor.ts`'s `executeViaGateway`.
 *
 * Fail-closed order (each step short-circuits with a typed envelope):
 *   1. CRITICAL-1  sender trust — reject any non-trusted webContents.
 *   2. MEDIUM-1    schema + body-size validation (before any decode/network).
 *   3. CRITICAL-2  path validation via URL normalization + EXACT-PATH allowlist.
 *   4. (method)    v1 routes are GET-only.
 *   5. HIGH-1      port is always the live server port, never from the payload.
 *   6. CRITICAL-2 / HIGH-3  outbound headers built in main from a safe-list +
 *                 main-held auth token; renderer headers never forwarded verbatim.
 *   7. (dispatch)  loopback to 127.0.0.1 — full server stack, no reimplementation.
 *   8. MEDIUM-2    response headers stripped to a content-type safe-list.
 *   9. HIGH-1/LOW-1 log pathname + status only — never query string or body.
 *
 * It is exported as a pure factory (no Electron imports) so it can be unit-tested
 * with a fake event + injected fetch (Task 7). `app.ts` wires it to `ipcMain`.
 */

import type { RelayResponseEnvelope } from "@repo/shared-platform/relay-request-model";
import { z } from "zod";
import { branchIdMatchesRepo } from "../shared/branch-pr-scope.js";
import { GATEWAY_DISPATCH_RENDERER_SOURCE } from "../shared/gateway-dispatch-channel.js";

/**
 * EXACT-PATH allowlist (CRITICAL-2). v1 only the two slug-based, read-only PR
 * overlay routes. New gateway features add a line here — never a new channel,
 * never a prefix/`startsWith` check (bypassable via `..`, encoded slashes,
 * `//authority`).
 */
export const GATEWAY_DISPATCH_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  "/api/gateway/git/pr/file-diff",
  "/api/gateway/git/pr/files",
  "/api/gateway/git/pr/reviews",
]);

/** Cap the encoded request body before any decode/network (MEDIUM-1, ~2 MiB). */
export const GATEWAY_DISPATCH_MAX_BODY_BYTES = 2 * 1024 * 1024;

const LOOPBACK_BASE = "http://127.0.0.1";
const BRANCH_DETAIL_HASH_PATH_REGEX = /^\/branches\/([^/]+)$/;

type GatewayDispatchLogger = {
  info: (tag: string, message: string) => void;
  warn: (tag: string, message: string) => void;
};

export type GatewayDispatchDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  /** The live, bound gateway server port. Never sourced from the payload. */
  getActivePort: () => number;
  /** The main-held gateway auth token (authorizes the loopback call). */
  getGatewayAuthToken: () => string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Optional structured logger (the desktop `gatewayLog`). */
  log?: GatewayDispatchLogger;
};

/** Minimal shape of an Electron `IpcMainInvokeEvent` this handler reads. */
type GatewayDispatchEvent = { sender: unknown };
type GatewayDispatchSenderWithUrl = { getURL?: () => string };

/**
 * Zod schema for the IPC payload (AGENTS.md convention: validate unknown objects
 * with Zod, not manual `typeof` guards). Mirrors `RelayEncodedBody` /
 * `RelayHttpRequestPayload` from the shared relay-request-model.
 */
const encodedBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("json"), value: z.unknown() }),
  z.object({
    kind: z.literal("text"),
    value: z.string(),
    contentType: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("base64"),
    value: z.string(),
    contentType: z.string().nullable(),
  }),
]);

const gatewayDispatchPayloadSchema = z.object({
  method: z.string(),
  path: z.string(),
  headers: z.record(z.string(), z.string()),
  body: encodedBodySchema,
});

type GatewayDispatchPayload = z.infer<typeof gatewayDispatchPayloadSchema>;

/**
 * Byte length of the encoded IPC payload body (MEDIUM-1) — the size actually
 * transferred and held in main, measured BEFORE any decode. base64/text/json are
 * all measured on the encoded form (base64 is ASCII, so its string length IS the
 * encoded byte length), consistent across kinds.
 */
function encodedBodyByteLength(body: GatewayDispatchPayload["body"]): number {
  switch (body.kind) {
    case "none":
      return 0;
    case "json":
      return Buffer.byteLength(JSON.stringify(body.value) ?? "");
    case "text":
      return Buffer.byteLength(body.value);
    case "base64":
      return body.value.length;
    default:
      return 0;
  }
}

function errorEnvelope(status: number, message: string): RelayResponseEnvelope {
  return {
    status,
    body: JSON.stringify({ error: message }),
    headers: { "content-type": "application/json" },
  };
}

/**
 * Build the `desktop:gateway-dispatch` handler. The returned function is the
 * `ipcMain.handle` listener: `(event, payload) => Promise<RelayResponseEnvelope>`.
 */
export function createGatewayDispatchHandler(deps: GatewayDispatchDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return async (
    event: GatewayDispatchEvent,
    payload: unknown
  ): Promise<RelayResponseEnvelope> => {
    // 1. CRITICAL-1 — sender trust. FIRST LINE; gates the entire handler.
    if (!deps.isTrustedSender(event.sender)) {
      return errorEnvelope(403, "untrusted sender");
    }

    // 2. MEDIUM-1 — schema validation, then body-size cap before any network.
    const parsed = gatewayDispatchPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return errorEnvelope(400, "invalid gateway request");
    }
    const request = parsed.data;
    if (encodedBodyByteLength(request.body) > GATEWAY_DISPATCH_MAX_BODY_BYTES) {
      return errorEnvelope(413, "request body too large");
    }

    // 3. CRITICAL-2 — normalize the renderer path, then exact-path allowlist.
    let pathname: string;
    let search: string;
    try {
      const parsed = new URL(request.path, LOOPBACK_BASE);
      pathname = parsed.pathname;
      search = parsed.search;
    } catch {
      return errorEnvelope(400, "invalid request path");
    }
    if (!GATEWAY_DISPATCH_ALLOWED_PATHS.has(pathname)) {
      return errorEnvelope(403, "path not allowed");
    }

    // 4. v1 allowlisted routes are GET-only.
    const method = request.method.toUpperCase();
    if (method !== "GET") {
      return errorEnvelope(405, "method not allowed");
    }

    if (
      pathname === "/api/gateway/git/pr/file-diff" &&
      !isFileDiffRequestScopedToCurrentBranch(search, event.sender)
    ) {
      return errorEnvelope(403, "file diff scope not allowed");
    }

    // 5. HIGH-1 — target port is always the live server port, never the payload.
    const port = deps.getActivePort();

    // 6. CRITICAL-2 / HIGH-3 — outbound headers built in main from a safe-list
    //    plus the main-held auth token. Renderer headers are NOT forwarded
    //    verbatim. The `Headers` constructor throws on CRLF in names/values.
    const outboundHeaders = new Headers();
    outboundHeaders.set("x-desktop-gateway-token", deps.getGatewayAuthToken());
    outboundHeaders.set("x-desktop-source", GATEWAY_DISPATCH_RENDERER_SOURCE);

    // 7. Dispatch loopback — reuses the full router/operation/guard stack.
    const targetUrl = `${LOOPBACK_BASE}:${port}${pathname}${search}`;
    try {
      const response = await fetchImpl(targetUrl, {
        method: "GET",
        headers: outboundHeaders,
      });
      const body = await response.text();

      // 8. MEDIUM-2 — strip response headers to a content-type safe-list.
      const headers: Record<string, string> = {};
      const contentType = response.headers.get("content-type");
      if (contentType) {
        headers["content-type"] = contentType;
      }

      // 9. HIGH-1 / LOW-1 — log pathname + status only; never query or body.
      deps.log?.info(
        "gateway-dispatch",
        `${method} ${pathname} -> ${response.status}`
      );

      return { status: response.status, body, headers };
    } catch {
      // Never throw: overlays handle non-2xx gracefully; an unhandled rejection
      // would not degrade cleanly. Log pathname only (no query string).
      deps.log?.warn("gateway-dispatch", `${method} ${pathname} failed`);
      return errorEnvelope(502, "gateway dispatch failed");
    }
  };
}

function isFileDiffRequestScopedToCurrentBranch(
  search: string,
  sender: unknown
): boolean {
  const params = new URLSearchParams(search);
  const branchId = params.get("branchId");
  const owner = params.get("owner");
  const repo = params.get("repo");
  if (!(branchId && owner && repo)) {
    return false;
  }

  const currentBranchId = readCurrentBranchId(sender);
  if (currentBranchId !== branchId) {
    return false;
  }

  return branchIdMatchesRepo(branchId, owner, repo);
}

function readCurrentBranchId(sender: unknown): string | null {
  const maybeSender = sender as GatewayDispatchSenderWithUrl;
  if (typeof maybeSender.getURL !== "function") {
    return null;
  }

  let currentUrl: URL;
  try {
    currentUrl = new URL(maybeSender.getURL());
  } catch {
    return null;
  }
  const hash = currentUrl.hash.startsWith("#")
    ? currentUrl.hash.slice(1)
    : currentUrl.hash;
  const path = hash.split("?")[0] ?? "";
  const match = BRANCH_DETAIL_HASH_PATH_REGEX.exec(path);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
