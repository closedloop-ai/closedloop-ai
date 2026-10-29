import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalSessionStore } from "../main/auth/local-session-store.js";
import { gatewayLog } from "../main/logging/gateway-logger.js";
import type {
  ComputeTargetCapabilities,
  HealthResponse,
} from "../shared/contracts.js";
import { AuthReason } from "./gateway-auth-reasons.js";
import { isOriginAllowed } from "./gateway-cors-policy.js";
import { proxyToFallbackGateway } from "./gateway-fallback-proxy.js";
import { OperationDispatcher } from "./operation-dispatcher.js";
import { configureBinaryPathsResolver } from "./operations/binary-path-overrides.js";
import {
  type BinaryPathKey,
  type BinaryPaths,
  registerBinaryPathsRoutes,
} from "./operations/binary-paths.js";
import { registerFilesystemDirectoriesRoutes } from "./operations/filesystem-directories.js";
import { registerFilesystemSearchRoutes } from "./operations/filesystem-search.js";
import { registerGitActionRoutes } from "./operations/git-action.js";
import { registerGitBranchWorktreeRoutes } from "./operations/git-branch-worktree.js";
import { registerGitBranchesRoutes } from "./operations/git-branches.js";
import { registerGitDiffRoutes } from "./operations/git-diff.js";
import { registerGitLocalChangesRoutes } from "./operations/git-local-changes.js";
import { registerGitPrRoutes } from "./operations/git-pr.js";
import { registerGitRepoPathRoutes } from "./operations/git-repo-path.js";
import { registerGitWorktreeRoutes } from "./operations/git-worktree.js";
import {
  type MemberPackInstaller,
  registerMemberPackInstallRoutes,
} from "./operations/member-pack-install.js";
import { registerReposConfigRoutes } from "./operations/repos-config.js";
import { registerSecurityUpgradeRoutes } from "./operations/security-upgrade.js";
import { SymphonyDirNotConfiguredError } from "./operations/symphony-utils.js";
import { ProcessManager } from "./process-manager.js";
import { byteLengthOfResponseChunk } from "./response-size.js";
import {
  bigintToSafeNumber,
  GATEWAY_REQUEST_BODY_LIMIT,
  logOversizedRequest,
  parseStrictContentLength,
  REQUEST_BODY_TOO_LARGE_CODE,
  type RequestBodyLimit,
  RequestBodyTooLargeError,
  writeRequestTooLargeResponse,
} from "./router-body-limits.js";

export type GatewayRouterOptions = {
  webAppOrigin: string;
  getWebAppOrigin?: () => string;
  machineName: string;
  version: string;
  capabilities: ComputeTargetCapabilities;
  getOnboardingCompleted?: () => boolean;
  getActivePort: () => number;
  getAllowedDirectories: () => string[];
  getSymphonyDir?: () => string;
  fallbackGatewayOrigin?: string;
  onActivityEvent?: (event: GatewayActivityEvent) => void;
  getGatewayAuthToken?: () => string | undefined;
  evaluateApproval?: (
    request: GatewayApprovalRequest
  ) => GatewayApprovalResult | Promise<GatewayApprovalResult>;
  sessionStore?: LocalSessionStore;
  gitPullRequestApiOptions?: Parameters<typeof registerGitPrRoutes>[2];
  prodOriginsOnly?: boolean;
  getGatewayId: () => string;
  getComputeTargetId?: () => string | null;
  handleSecurityUpgrade?: (
    payload: DesktopSecurityUpgradePayload
  ) => Promise<DesktopSecurityUpgradeResult> | DesktopSecurityUpgradeResult;
  getBinaryPaths?: () => BinaryPaths;
  applyBinaryPathPatch?: (
    patch: Partial<Record<BinaryPathKey, string | null>>
  ) => BinaryPaths;
  /**
   * Starts a vetted catalog-pack install (FEA-4082). When absent — an older
   * build wired before member self-service installs existed — the pack-install
   * gateway route is not registered and the router answers 501 for it, which
   * the cloud maps to a graceful `failed` dispatch state.
   */
  installPack?: MemberPackInstaller;
};

export type GatewayActivityEvent = {
  type: "request" | "security";
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  detail?: string;
  requestSizeBytes?: number;
  responseSizeBytes?: number;
};

export type GatewayApprovalRequest = {
  method: string;
  path: string;
  body: string;
  origin: string | null;
  referer: string | null;
  userAgent: string | null;
  remoteAddress: string | null;
  source: string | null;
  forceApproval: boolean;
  approvalReason: string | null;
};

export type GatewayApprovalResult =
  | { allow: true }
  | { allow: false; statusCode: number; payload: Record<string, unknown> };

export type DesktopSecurityUpgradePayload = {
  onboardingAttemptId: string;
  webAppOrigin: string;
  computeTargetId: string;
  gatewayId: string;
  expiresAt: string;
};

export type DesktopSecurityUpgradeResult =
  | { ok: true }
  | { ok: false; code: string; retryable: boolean; statusCode?: number };

const MALFORMED_REQUEST_TARGET_CODE = "malformed_request_target";
// Exported so the tests that pin which branch of `writeUnhandledRequestFailure`
// ran read the same tokens the log sink does, rather than restating them.
export const UNHANDLED_REQUEST_ERROR_CODE = "unhandled_request_error";
export const CLIENT_ABORTED_CODE = "client_aborted_request";
// Attacker-controlled and unbounded; the log sink is a buffer plus a durable file.
const MAX_LOGGED_REQUEST_TARGET_CHARS = 120;

export class GatewayRouter {
  private readonly options: GatewayRouterOptions;
  private readonly operationDispatcher: OperationDispatcher;
  private readonly processManager: ProcessManager;

  constructor(
    options: GatewayRouterOptions,
    operationDispatcher = new OperationDispatcher()
  ) {
    this.options = options;
    this.operationDispatcher = operationDispatcher;
    this.processManager = new ProcessManager({
      getAllowedDirectories: this.options.getAllowedDirectories,
    });
    configureBinaryPathsResolver(this.options.getBinaryPaths ?? null);
    const getSymphonyDir =
      this.options.getSymphonyDir ??
      (() => {
        throw new SymphonyDirNotConfiguredError();
      });
    registerFilesystemDirectoriesRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories
    );
    registerFilesystemSearchRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories
    );
    registerGitActionRoutes(
      this.operationDispatcher,
      this.processManager,
      this.options.getAllowedDirectories
    );
    registerGitBranchesRoutes(
      this.operationDispatcher,
      this.processManager,
      this.options.getAllowedDirectories
    );
    registerGitBranchWorktreeRoutes(this.operationDispatcher, getSymphonyDir);
    registerGitLocalChangesRoutes(
      this.operationDispatcher,
      this.processManager,
      this.options.getAllowedDirectories
    );
    registerGitDiffRoutes(
      this.operationDispatcher,
      this.processManager,
      this.options.getAllowedDirectories
    );
    registerGitPrRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories,
      this.options.gitPullRequestApiOptions
    );
    registerGitRepoPathRoutes(this.operationDispatcher, getSymphonyDir);
    registerGitWorktreeRoutes(
      this.operationDispatcher,
      this.processManager,
      this.options.getAllowedDirectories,
      getSymphonyDir
    );
    if (this.options.getBinaryPaths && this.options.applyBinaryPathPatch) {
      registerBinaryPathsRoutes(
        this.operationDispatcher,
        this.options.getBinaryPaths,
        this.options.applyBinaryPathPatch
      );
    }
    registerReposConfigRoutes(this.operationDispatcher, getSymphonyDir);
    registerSecurityUpgradeRoutes(this.operationDispatcher, {
      getGatewayId: this.options.getGatewayId,
      getComputeTargetId: this.options.getComputeTargetId,
      handleSecurityUpgrade: this.options.handleSecurityUpgrade,
    });
    if (this.options.installPack) {
      registerMemberPackInstallRoutes(
        this.operationDispatcher,
        this.options.installPack
      );
    }
  }

  /**
   * ISS-8566: the ONE place a gateway request may fail without taking the whole
   * app down with it.
   *
   * `server.ts` dispatches this as a bare `void this.router.handle(...)`, so a
   * rejection escaping here is an UNHANDLED rejection, and
   * `handleUnhandledRejection` (`main/lifecycle/error-handlers.ts`) suppresses
   * only a spawn ENOENT and calls `exit(1)` for every other `Error` — the tray,
   * every collector and every sync lane die with it. A client that aborts an
   * upload mid-body raises `ECONNRESET` out of `readBody`, which is exactly such
   * an `Error`, and it needs no credential to reach: `isAuthorizedGatewayRequest`
   * authorizes every request when no gateway auth token is configured, which is
   * the default state. No attacker is required either — a dropped Wi-Fi
   * handover or a tab closed mid-POST is the same input.
   *
   * This is the THIRD door into that crash class on this file (ISS-7585 URIError
   * in route params, ISS-7958 malformed request target), so it is deliberately a
   * catch around the whole route body rather than a fourth per-site guard: it
   * closes the class. It lives here rather than at the `server.ts` dispatch
   * because the router is what still holds the response and can answer.
   */
  async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      await this.routeRequest(request, response);
    } catch (error) {
      this.writeUnhandledRequestFailure(request, response, error);
    }
  }

  private async routeRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    this.applyCorsHeaders(request, response);

    const method = request.method?.toUpperCase() ?? "GET";
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      gatewayLog.warn(
        "gateway-router",
        `${MALFORMED_REQUEST_TARGET_CODE} method=${method} status=400 target=${(request.url ?? "").slice(0, MAX_LOGGED_REQUEST_TARGET_CHARS)}`
      );
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "malformed request target" }));
      return;
    }
    const isGatewayRoute = url.pathname.startsWith("/api/gateway/");
    const startedAt = Date.now();
    let activityType: GatewayActivityEvent["type"] = "request";
    let activityDetail: string | undefined;
    let requestSizeBytes: number | undefined;
    let responseSizeBytes = 0;

    if (isGatewayRoute && method !== "OPTIONS") {
      const origWrite = response.write.bind(response) as typeof response.write;
      const origEnd = response.end.bind(response) as typeof response.end;

      response.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
        responseSizeBytes += byteLengthOfResponseChunk(chunk, rest[0]);
        return origWrite(chunk as string, ...(rest as [BufferEncoding]));
      }) as typeof response.write;

      response.end = ((chunk: unknown, ...rest: unknown[]): ServerResponse => {
        if (chunk != null && typeof chunk !== "function") {
          responseSizeBytes += byteLengthOfResponseChunk(chunk, rest[0]);
        }
        return origEnd(chunk as string, ...(rest as [BufferEncoding]));
      }) as typeof response.end;

      response.once("finish", () => {
        this.options.onActivityEvent?.({
          type: activityType,
          timestamp: new Date(startedAt).toISOString(),
          method,
          path: url.pathname + url.search,
          statusCode: response.statusCode,
          durationMs: Math.max(0, Date.now() - startedAt),
          detail: activityDetail,
          requestSizeBytes,
          responseSizeBytes,
        });
      });
    }

    if (method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const authResult = this.isAuthorizedGatewayRequest(request);
    if (isGatewayRoute && !authResult.authorized) {
      activityType = "security";
      activityDetail = authResult.reason;
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ error: "unauthorized", reason: authResult.reason })
      );
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      const health: HealthResponse = {
        status: "ok",
        machineName: this.options.machineName,
        capabilities: this.options.capabilities,
        gatewayId: this.options.getGatewayId() || undefined,
        onboardingCompleted: this.options.getOnboardingCompleted?.() ?? false,
        version: this.options.version,
        port: this.options.getActivePort(),
      };
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(health));
      return;
    }

    if (isGatewayRoute) {
      let rawBody: Buffer;
      try {
        rawBody = await this.readBody(request, GATEWAY_REQUEST_BODY_LIMIT);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          activityType = "security";
          activityDetail = REQUEST_BODY_TOO_LARGE_CODE;
          requestSizeBytes = error.observedSizeBytes ?? error.declaredSizeBytes;
          logOversizedRequest(method, url.pathname, error);
          writeRequestTooLargeResponse(response, error);
          return;
        }
        throw error;
      }
      requestSizeBytes = rawBody.byteLength;
      const body = rawBody.toString("utf-8");

      const approval = this.options.evaluateApproval?.({
        method,
        path: url.pathname,
        body,
        origin: request.headers.origin ?? null,
        referer: request.headers.referer ?? null,
        userAgent: firstHeaderValue(request.headers["user-agent"]),
        remoteAddress: request.socket.remoteAddress ?? null,
        source: firstHeaderValue(request.headers["x-desktop-source"]),
        forceApproval: parseBooleanHeader(
          request.headers["x-desktop-force-approval"]
        ),
        approvalReason: firstHeaderValue(
          request.headers["x-desktop-approval-reason"]
        ),
      });
      const resolvedApproval = approval ? await approval : null;
      if (resolvedApproval && !resolvedApproval.allow) {
        activityDetail =
          typeof resolvedApproval.payload?.error === "string"
            ? resolvedApproval.payload.error
            : "request not approved";
        response.statusCode = resolvedApproval.statusCode;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(resolvedApproval.payload));
        return;
      }

      const handled = await this.operationDispatcher.dispatch({
        method,
        pathname: url.pathname,
        params: {},
        query: url.searchParams,
        rawBody,
        body,
        request,
        response,
      });
      if (handled) {
        return;
      }

      if (this.options.fallbackGatewayOrigin) {
        await proxyToFallbackGateway({
          fallbackGatewayOrigin: this.options.fallbackGatewayOrigin,
          rawBody,
          request,
          requestPath: url.pathname + url.search,
          response,
        });
        return;
      }

      response.statusCode = 501;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: "operation not implemented",
          method,
          path: url.pathname,
        })
      );
      return;
    }

    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "route not found" }));
  }

  private applyCorsHeaders(
    request: IncomingMessage,
    response: ServerResponse
  ): void {
    const requestOrigin = firstHeaderValue(request.headers.origin);
    const resolvedWebAppOrigin =
      this.options.getWebAppOrigin?.() ?? this.options.webAppOrigin;
    const allowed = this.isOriginAllowed(requestOrigin);

    response.setHeader(
      "Access-Control-Allow-Origin",
      allowed && requestOrigin ? requestOrigin : resolvedWebAppOrigin
    );
    response.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,X-Desktop-Gateway-Token,X-Desktop-Session-Token,X-Desktop-Source,X-Desktop-Force-Approval,X-Desktop-Approval-Reason"
    );
    response.setHeader("Access-Control-Allow-Credentials", "false");
    response.setHeader(
      "Vary",
      "Origin,Access-Control-Request-Headers,Access-Control-Request-Private-Network"
    );

    const privateNetworkRequest = firstHeaderValue(
      request.headers["access-control-request-private-network"]
    );
    if (privateNetworkRequest?.toLowerCase() === "true" && allowed) {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
  }

  private isOriginAllowed(origin: string | null | undefined): boolean {
    const webAppOrigin =
      this.options.getWebAppOrigin?.() ?? this.options.webAppOrigin;
    return isOriginAllowed(origin, {
      webAppOrigin,
      prodOriginsOnly: this.options.prodOriginsOnly ?? false,
    });
  }

  private isAuthorizedGatewayRequest(
    request: IncomingMessage
  ): { authorized: true } | { authorized: false; reason: AuthReason } {
    const expectedToken = this.options.getGatewayAuthToken?.();

    // Path 1: Internal cloud executor token -- checked first so relayed
    // commands that happen to carry an Origin header are never blocked
    // by the prod-origins-only gate below.
    const providedGatewayToken = firstHeaderValue(
      request.headers["x-desktop-gateway-token"]
    );
    if (
      expectedToken &&
      providedGatewayToken &&
      safeEqualToken(providedGatewayToken, expectedToken)
    ) {
      return { authorized: true };
    }

    // Prod-origins-only gate: reject disallowed origins for browser paths.
    // Placed after gateway-token check so cloud executor is never blocked,
    // but before no-auth shortcut so blocked origins can't get a free pass.
    if (this.options.prodOriginsOnly) {
      const requestOrigin = firstHeaderValue(request.headers.origin);
      if (!this.isOriginAllowed(requestOrigin)) {
        return {
          authorized: false,
          reason: AuthReason.OriginNotAllowed,
        };
      }
    }

    if (!expectedToken) {
      return { authorized: true };
    }

    const sessionStore = this.options.sessionStore;
    const sessionToken = firstHeaderValue(
      request.headers["x-desktop-session-token"]
    );
    const requestOrigin = firstHeaderValue(request.headers.origin);

    if (sessionToken) {
      if (!requestOrigin || requestOrigin === "null") {
        return {
          authorized: false,
          reason: AuthReason.SessionTokenWithoutOrigin,
        };
      }
      if (!sessionStore) {
        return { authorized: false, reason: AuthReason.SessionStoreMissing };
      }
      if (sessionStore.validate(sessionToken, requestOrigin)) {
        return { authorized: true };
      }
      return { authorized: false, reason: AuthReason.SessionTokenInvalid };
    }

    if (!requestOrigin || requestOrigin === "null") {
      return { authorized: false, reason: AuthReason.NoCredential };
    }
    return { authorized: false, reason: AuthReason.BrowserSessionRequired };
  }

  private async readBody(
    request: IncomingMessage,
    bodyLimit: RequestBodyLimit
  ): Promise<Buffer> {
    // Only a strictly numeric Content-Length can reject early; relayed
    // requests often omit it and are enforced by streamed byte counting.
    const declaredSizeBytes = parseStrictContentLength(
      firstHeaderValue(request.headers["content-length"])
    );
    if (
      declaredSizeBytes !== null &&
      declaredSizeBytes > BigInt(bodyLimit.limitBytes)
    ) {
      throw new RequestBodyTooLargeError({
        limitBytes: bodyLimit.limitBytes,
        routeName: bodyLimit.routeName,
        declaredSizeBytes: bigintToSafeNumber(declaredSizeBytes),
      });
    }

    const chunks: Buffer[] = [];
    let observedSizeBytes = 0;

    for await (const chunk of request) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      observedSizeBytes += buffer.byteLength;
      if (observedSizeBytes > bodyLimit.limitBytes) {
        throw new RequestBodyTooLargeError({
          limitBytes: bodyLimit.limitBytes,
          routeName: bodyLimit.routeName,
          declaredSizeBytes:
            declaredSizeBytes === null
              ? undefined
              : bigintToSafeNumber(declaredSizeBytes),
          observedSizeBytes,
        });
      }
      chunks.push(buffer);
    }

    if (chunks.length === 0) {
      return Buffer.alloc(0);
    }

    return Buffer.concat(chunks);
  }

  /**
   * Answer — or deliberately abandon — a request whose handler threw, never
   * rejecting. See {@link GatewayRouter.handle} for why rejecting is fatal.
   *
   * Four outcomes, because these are not the same failure. A client that
   * vanished mid-body cannot be told anything, and writing to that socket is
   * what would throw a second time, so it is logged as an abort and the response
   * destroyed. A response that already COMPLETED is left alone: the caller has
   * its whole answer, and tearing the socket down would reset a healthy
   * keep-alive connection after a good reply. A handler that only BEGAN its
   * answer cannot have a status put in front of it, so a half-written response
   * is destroyed rather than corrupted into a body the caller would parse as
   * complete. Everything else is our own bug and gets a generic 500 that leaks
   * no internals.
   *
   * A valid request never reaches here: every existing branch of
   * {@link GatewayRouter.routeRequest} still returns its own response, including
   * the 413 a {@link RequestBodyTooLargeError} already answers with.
   */
  private writeUnhandledRequestFailure(
    request: IncomingMessage,
    response: ServerResponse,
    error: unknown
  ): void {
    const method = request.method?.toUpperCase() ?? "GET";
    const target = (request.url ?? "").slice(
      0,
      MAX_LOGGED_REQUEST_TARGET_CHARS
    );
    // Bounded for the same reason `target` is: an error message can echo body
    // or URL content, and the log sink is a buffer plus a durable file.
    const detail = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, MAX_LOGGED_REQUEST_TARGET_CHARS);
    const aborted = isClientAbort(request, error);
    // `headersSent` is equally true for a half-written answer and for one that
    // already completed, so it alone cannot tell them apart (review,
    // marisolashgrove). A delivered response has no status left to change and
    // nothing to tear down -- `destroy()` on it resets a keep-alive socket that
    // carried a good reply, and takes any pipelined request with it.
    const delivered = response.writableEnded;
    const summary = `method=${method} target=${target} error=${detail}`;
    if (aborted) {
      gatewayLog.warn("gateway-router", `${CLIENT_ABORTED_CODE} ${summary}`);
    } else {
      gatewayLog.error(
        "gateway-router",
        // The status is what the caller actually got, never a 500 we did not
        // send: a post-delivery failure is still our bug and still logged, but
        // the answer on the wire is the one already written.
        `${UNHANDLED_REQUEST_ERROR_CODE} ${summary} status=${delivered ? response.statusCode : 500}`
      );
    }
    if (delivered) {
      return;
    }
    if (aborted || response.headersSent) {
      response.destroy();
      return;
    }
    try {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "internal error" }));
    } catch {
      // The socket died between the checks above and the write. There is
      // nothing left to answer on, and this handler must not throw.
      response.destroy();
    }
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value;
}

function parseBooleanHeader(value: string | string[] | undefined): boolean {
  const first = firstHeaderValue(value);
  if (!first) {
    return false;
  }
  return first === "1" || first.toLowerCase() === "true";
}

function safeEqualToken(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Did the CLIENT go away, rather than the handler failing on its own?
 *
 * The SOCKET is the subject, deliberately, and the request stream is not: a
 * request whose body was read to completion is itself `destroyed` on a perfectly
 * healthy connection, so reading that flag would classify every later handler
 * bug as a disconnect and tear the response down instead of answering the 500
 * the caller is still waiting for.
 *
 * The error code is the second signal because the two do not always agree — a
 * mid-body disconnect surfaces as `ECONNRESET`/`ECONNABORTED` out of the body
 * read before the socket has finished tearing down.
 */
function isClientAbort(request: IncomingMessage, error: unknown): boolean {
  if (request.socket.destroyed) {
    return true;
  }
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ECONNRESET" || error.code === "ECONNABORTED")
  );
}
