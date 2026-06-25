import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiKeyProvenance } from "../main/api-key-store.js";
import type { DesktopPopSigner } from "../main/desktop-pop.js";
import type { DesktopPopUnavailableReporter } from "../main/desktop-pop-sign-utils.js";
import { gatewayLog } from "../main/gateway-logger.js";
import type { JobStore } from "../main/job-store.js";
import { verifyChallenge } from "../main/local-auth-verifier.js";
import type { LocalSessionStore } from "../main/local-session-store.js";
import type { LoopSchedulerContext } from "../main/loop-scheduler-context.js";
import type { LoopTokenStore } from "../main/loop-token-store.js";
import type { RetrySpawnDeps } from "../main/spawn-retry.js";
import type {
  ComputeTargetCapabilities,
  HealthResponse,
} from "../shared/contracts.js";
import { isLoopbackIPv4 } from "../shared/network-utils.js";
import { OperationDispatcher } from "./operation-dispatcher.js";
import { registerBinaryPathsRoutes } from "./operations/binary-paths.js";
import {
  ClaudeProvider,
  CodexProvider,
  ProviderRegistry,
} from "./operations/chat-providers.js";
import { registerChatSessionRoutes } from "./operations/chat-session.js";
import { registerCodexRoutes } from "./operations/codex.js";
import { registerDeployRoutes } from "./operations/deploy.js";
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
import { registerHealthCheckRoutes } from "./operations/health-check.js";
import { registerLearningsRoutes } from "./operations/learnings.js";
import { configureMcpDetectionCwdResolver } from "./operations/mcp-detection.js";
import { registerMetadataRoutes } from "./operations/metadata-routes.js";
import { registerReposConfigRoutes } from "./operations/repos-config.js";
import { registerRunViewerChatRoutes } from "./operations/run-viewer-chat.js";
import { registerRunViewerExtractRoutes } from "./operations/run-viewer-extract.js";
import { registerSecurityUpgradeRoutes } from "./operations/security-upgrade.js";
import { registerSymphonyAttachmentsRoutes } from "./operations/symphony-attachments.js";
import { registerSymphonyChatHistoryRoutes } from "./operations/symphony-chat-history.js";
import { registerSymphonyInteractiveRoutes } from "./operations/symphony-interactive.js";
import { registerSymphonyJudgesRoutes } from "./operations/symphony-judges.js";
import { registerSymphonyKillRoutes } from "./operations/symphony-kill.js";
import { registerSymphonyLogsRoutes } from "./operations/symphony-logs.js";
import {
  configureBinaryPathsResolver,
  registerSymphonyLoopRoutes,
  type WorktreeProvider,
} from "./operations/symphony-loop.js";
import { registerSymphonyPlanRoutes } from "./operations/symphony-plan.js";
import { registerSymphonyPlanLoopRoutes } from "./operations/symphony-plan-loop.js";
import { registerSymphonySessionRoutes } from "./operations/symphony-sessions.js";
import { registerSymphonyStatusRoutes } from "./operations/symphony-status.js";
import { registerSymphonyUploadRoutes } from "./operations/symphony-upload.js";
import { SymphonyDirNotConfiguredError } from "./operations/symphony-utils.js";
import { registerTerminalChatRoutes } from "./operations/terminal-chat.js";
import { registerTicketChatRoutes } from "./operations/ticket-chat.js";
import { registerUpdateAndRestartRoutes } from "./operations/update-and-restart.js";
import {
  createClaudeCodeShellEnvProvider,
  getDefaultClaudeCodeOtelReceiverStatus,
} from "./otel/claude-code-env.js";
import { ProcessManager } from "./process-manager.js";

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
  getApiKey?: () => string | null;
  getApiKeyProvenance?: () => ApiKeyProvenance | null;
  signDesktopRequest?: DesktopPopSigner;
  onDesktopPopUnavailable?: DesktopPopUnavailableReporter;
  getApiOrigin?: () => string;
  prodOriginsOnly?: boolean;
  jobStore?: JobStore;
  worktreeProvider?: WorktreeProvider;
  loopTokenStore?: LoopTokenStore;
  /** Per-loop heartbeat/refresh/sleep timer container owned by the gateway. */
  schedulers: LoopSchedulerContext;
  retrySpawnDeps?: RetrySpawnDeps;
  getClaudeCodeOtelReceiverStatus?: () => unknown;
  getGatewayId: () => string;
  getComputeTargetId?: () => string | null;
  handleSecurityUpgrade?: (
    payload: DesktopSecurityUpgradePayload
  ) => Promise<DesktopSecurityUpgradeResult> | DesktopSecurityUpgradeResult;
  getBinaryPaths?: () => {
    claude?: string;
    gh?: string;
    codex?: string;
    cursor?: string;
    opencode?: string;
    python3?: string;
    git?: string;
  };
  applyBinaryPathPatch?: (
    patch: Partial<
      Record<
        "claude" | "gh" | "codex" | "cursor" | "opencode" | "python3" | "git",
        string | null
      >
    >
  ) => {
    claude?: string;
    gh?: string;
    codex?: string;
    cursor?: string;
    opencode?: string;
    python3?: string;
    git?: string;
  };
  checkForUpdate?: () => Promise<{
    updateAvailable: boolean;
    version?: string;
  }>;
  applyUpdate?: () => Promise<void>;
  isUpdateAndRestartEnabled?: () => boolean;
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

const GATEWAY_AUTH_EXCHANGE_LIMIT_BYTES = 4 * 1024;
const GENERIC_JSON_LIMIT_BYTES = 256 * 1024;
// Matches the current symphony-alpha /dispatch 1 MiB relay-envelope cap.
const SYMPHONY_LOOP_LIMIT_BYTES = 1 * 1024 * 1024;
const SYMPHONY_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const RUN_VIEWER_EXTRACT_LIMIT_BYTES = 210 * 1024 * 1024;
const REQUEST_BODY_TOO_LARGE_CODE = "request_body_too_large";

type RequestBodyLimit = {
  limitBytes: number;
  routeName: string;
};

class RequestBodyTooLargeError extends Error {
  readonly code = REQUEST_BODY_TOO_LARGE_CODE;
  readonly limitBytes: number;
  readonly routeName: string;
  readonly declaredSizeBytes?: number;
  readonly observedSizeBytes?: number;

  constructor(input: {
    limitBytes: number;
    routeName: string;
    declaredSizeBytes?: number;
    observedSizeBytes?: number;
  }) {
    super("request body too large");
    this.name = "RequestBodyTooLargeError";
    this.limitBytes = input.limitBytes;
    this.routeName = input.routeName;
    this.declaredSizeBytes = input.declaredSizeBytes;
    this.observedSizeBytes = input.observedSizeBytes;
  }
}

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
    configureMcpDetectionCwdResolver(() => {
      const [sandboxRoot] = this.options.getAllowedDirectories();
      return sandboxRoot?.trim() || undefined;
    });
    configureBinaryPathsResolver(this.options.getBinaryPaths ?? null);
    const getClaudeCodeShellEnv = createClaudeCodeShellEnvProvider({
      getReceiverStatus:
        this.options.getClaudeCodeOtelReceiverStatus ??
        getDefaultClaudeCodeOtelReceiverStatus,
      diagnostics: gatewayLog,
    });
    const getSymphonyDir =
      this.options.getSymphonyDir ??
      (() => {
        throw new SymphonyDirNotConfiguredError();
      });
    registerFilesystemDirectoriesRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories
    );
    registerCodexRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories,
      getClaudeCodeShellEnv
    );
    registerDeployRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories,
      getSymphonyDir
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
      this.options.getAllowedDirectories
    );
    registerGitRepoPathRoutes(this.operationDispatcher, getSymphonyDir);
    registerGitWorktreeRoutes(
      this.operationDispatcher,
      this.processManager,
      this.options.getAllowedDirectories,
      getSymphonyDir
    );
    registerHealthCheckRoutes(
      this.operationDispatcher,
      this.processManager,
      getSymphonyDir,
      undefined,
      this.options.getBinaryPaths,
      () => this.options.version
    );
    if (this.options.getBinaryPaths && this.options.applyBinaryPathPatch) {
      registerBinaryPathsRoutes(
        this.operationDispatcher,
        this.options.getBinaryPaths,
        this.options.applyBinaryPathPatch
      );
    }
    registerLearningsRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories,
      getSymphonyDir
    );
    registerMetadataRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories,
      getSymphonyDir
    );
    registerReposConfigRoutes(this.operationDispatcher, getSymphonyDir);
    registerRunViewerChatRoutes(
      this.operationDispatcher,
      this.processManager,
      this.options.getAllowedDirectories,
      getSymphonyDir,
      getClaudeCodeShellEnv
    );
    registerRunViewerExtractRoutes(this.operationDispatcher);
    registerSymphonyAttachmentsRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories
    );
    registerSymphonyChatHistoryRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories
    );
    registerSymphonyJudgesRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories
    );
    registerSymphonyKillRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories,
      this.options.jobStore
    );
    registerSymphonyLoopRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories,
      this.options.schedulers,
      this.options.getApiOrigin,
      this.options.jobStore,
      this.options.getWebAppOrigin ?? (() => this.options.webAppOrigin),
      this.options.worktreeProvider,
      this.options.loopTokenStore,
      getSymphonyDir,
      this.options.getBinaryPaths,
      // Pass PoP deps unconditionally — buildManagedDesktopPopHeaders degrades
      // gracefully when provenance is not DESKTOP_MANAGED or signer is absent.
      {
        getApiKey: this.options.getApiKey,
        getApiKeyProvenance: this.options.getApiKeyProvenance,
        signDesktopRequest: this.options.signDesktopRequest,
        onDesktopPopUnavailable: this.options.onDesktopPopUnavailable,
      },
      getClaudeCodeShellEnv
    );
    registerSymphonyLogsRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories
    );
    registerSymphonyPlanRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories
    );
    registerSymphonySessionRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories,
      getSymphonyDir
    );
    registerSymphonyStatusRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories,
      this.options.jobStore
    );
    registerSymphonyInteractiveRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories,
      this.options.retrySpawnDeps ?? {
        log: (_level, msg) =>
          gatewayLog.warn("spawn-retry", `fallback: ${msg}`),
        refreshTray: () => {},
        isShuttingDown: () => false,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      getClaudeCodeShellEnv
    );
    if (this.options.getApiKey && this.options.getApiOrigin) {
      const getApiKey = this.options.getApiKey;
      const getApiOrigin = this.options.getApiOrigin;
      registerSymphonyPlanLoopRoutes(
        this.operationDispatcher,
        this.options.getAllowedDirectories,
        getApiKey,
        getApiOrigin,
        this.options.jobStore,
        this.options.getApiKeyProvenance,
        this.options.signDesktopRequest,
        this.options.onDesktopPopUnavailable
      );
    }
    registerSymphonyUploadRoutes(
      this.operationDispatcher,
      this.options.getAllowedDirectories
    );
    registerTerminalChatRoutes(
      this.operationDispatcher,
      this.processManager,
      this.options.getAllowedDirectories,
      getSymphonyDir,
      getClaudeCodeShellEnv
    );
    registerTicketChatRoutes(
      this.operationDispatcher,
      this.processManager,
      this.options.getAllowedDirectories,
      getSymphonyDir,
      getClaudeCodeShellEnv
    );
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      new ClaudeProvider(this.processManager, getClaudeCodeShellEnv)
    );
    providerRegistry.register(
      new CodexProvider(this.options.getAllowedDirectories)
    );
    registerChatSessionRoutes(
      this.operationDispatcher,
      this.processManager,
      providerRegistry,
      this.options.getGatewayId
    );
    if (
      this.options.checkForUpdate &&
      this.options.applyUpdate &&
      this.options.isUpdateAndRestartEnabled
    ) {
      registerUpdateAndRestartRoutes(this.operationDispatcher, {
        isUpdateAndRestartEnabled: this.options.isUpdateAndRestartEnabled,
        checkForUpdate: this.options.checkForUpdate,
        applyUpdate: this.options.applyUpdate,
      });
    }
    registerSecurityUpgradeRoutes(this.operationDispatcher, {
      getGatewayId: this.options.getGatewayId,
      getComputeTargetId: this.options.getComputeTargetId,
      handleSecurityUpgrade: this.options.handleSecurityUpgrade,
    });
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    this.applyCorsHeaders(request, response);

    const method = request.method?.toUpperCase() ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const isGatewayRoute = url.pathname.startsWith("/api/gateway/");
    const isExchangeRoute =
      method === "POST" && url.pathname === "/gateway-auth/exchange";
    const startedAt = Date.now();
    let activityType: GatewayActivityEvent["type"] = "request";
    let activityDetail: string | undefined;
    let requestSizeBytes: number | undefined;
    let responseSizeBytes = 0;

    if ((isGatewayRoute || isExchangeRoute) && method !== "OPTIONS") {
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

    if (isExchangeRoute) {
      const exchangeResult = await this.handleExchange(request, response);
      if (exchangeResult) {
        activityType = exchangeResult.activityType;
        activityDetail = exchangeResult.activityDetail;
        requestSizeBytes = exchangeResult.requestSizeBytes;
      }
      return;
    }

    const authResult = this.isAuthorizedGatewayRequest(request);
    if (isGatewayRoute && !authResult.authorized) {
      activityType = "security";
      activityDetail = authResult.reason ?? "unauthorized";
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
      const requestBodyLimit = resolveRequestBodyLimit(method, url.pathname);
      let rawBody: Buffer;
      try {
        rawBody = await this.readBody(request, requestBodyLimit);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          activityType = "security";
          activityDetail = REQUEST_BODY_TOO_LARGE_CODE;
          requestSizeBytes = error.observedSizeBytes ?? error.declaredSizeBytes;
          this.logOversizedRequest(method, url.pathname, error);
          this.writeRequestTooLargeResponse(response, error);
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
        await this.proxyToFallback(
          request,
          response,
          url.pathname + url.search,
          rawBody
        );
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
    if (!origin) {
      return true;
    }
    if (origin === "null") {
      return false;
    }
    const webAppOrigin =
      this.options.getWebAppOrigin?.() ?? this.options.webAppOrigin;
    if (sameOrigin(origin, webAppOrigin)) {
      return true;
    }
    if (this.options.prodOriginsOnly) {
      return false;
    }
    if (isLoopbackOrigin(origin)) {
      return true;
    }
    return false;
  }

  private isAuthorizedGatewayRequest(
    request: IncomingMessage
  ): { authorized: true } | { authorized: false; reason: string } {
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
          reason: "origin not allowed in prod-origins-only mode",
        };
      }
    }

    if (!expectedToken) {
      return { authorized: true };
    }

    // Path 2: Browser session token with origin validation
    const sessionStore = this.options.sessionStore;
    const sessionToken = firstHeaderValue(
      request.headers["x-desktop-session-token"]
    );
    const requestOrigin = firstHeaderValue(request.headers.origin);

    if (sessionToken) {
      if (!requestOrigin || requestOrigin === "null") {
        return {
          authorized: false,
          reason: "session token present but Origin header missing",
        };
      }
      if (!sessionStore) {
        return { authorized: false, reason: "session store not configured" };
      }
      if (sessionStore.validate(sessionToken, requestOrigin)) {
        return { authorized: true };
      }
      return {
        authorized: false,
        reason: "invalid or expired session token, or origin mismatch",
      };
    }

    // No valid credential provided
    if (!requestOrigin || requestOrigin === "null") {
      return { authorized: false, reason: "no credential provided" };
    }
    return {
      authorized: false,
      reason: "session token required for browser requests",
    };
  }

  private async handleExchange(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<{
    activityType: GatewayActivityEvent["type"];
    activityDetail?: string;
    requestSizeBytes?: number;
  } | null> {
    const requestOrigin = firstHeaderValue(request.headers.origin);

    if (!requestOrigin || requestOrigin === "null") {
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ error: "Origin header required" }));
      return null;
    }

    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      response.statusCode = 403;
      response.setHeader("content-type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ error: "loopback only" }));
      return {
        activityType: "security",
        activityDetail: "exchange rejected: non-loopback origin",
      };
    }

    if (this.options.prodOriginsOnly && !this.isOriginAllowed(requestOrigin)) {
      response.statusCode = 403;
      response.setHeader("content-type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(
        JSON.stringify({
          error:
            "Origin not allowed -- gateway is in production-origins-only mode",
        })
      );
      return {
        activityType: "security",
        activityDetail:
          "exchange rejected: origin blocked by prod-origins-only",
      };
    }

    // No-auth mode: skip challenge verification and issue a session immediately
    const noAuth = !this.options.getGatewayAuthToken?.();
    if (noAuth) {
      const sessionStore = this.options.sessionStore;
      if (!sessionStore) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify({ error: "session store not available" }));
        return null;
      }
      const session = sessionStore.create(requestOrigin, 86_400); // 24h session
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(
        JSON.stringify({
          sessionToken: session.sessionToken,
          expiresAt: session.expiresAt,
        })
      );
      return null;
    }

    const apiKey = this.options.getApiKey?.();
    if (!apiKey) {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(
        JSON.stringify({
          error: "Local gateway auth unavailable: API key required",
        })
      );
      return null;
    }

    const apiOrigin = this.options.getApiOrigin?.();
    if (!apiOrigin) {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ error: "API origin not configured" }));
      return null;
    }

    let rawBody: Buffer;
    try {
      rawBody = await this.readBody(
        request,
        resolveRequestBodyLimit(
          request.method?.toUpperCase() ?? "POST",
          "/gateway-auth/exchange"
        )
      );
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        this.logOversizedRequest(
          request.method?.toUpperCase() ?? "POST",
          "/gateway-auth/exchange",
          error
        );
        this.writeRequestTooLargeResponse(response, error);
        return {
          activityType: "security",
          activityDetail: REQUEST_BODY_TOO_LARGE_CODE,
          requestSizeBytes: error.observedSizeBytes ?? error.declaredSizeBytes,
        };
      }
      throw error;
    }
    const exchangeRequestSizeBytes = rawBody.byteLength;
    let challengeToken: string;
    try {
      const parsed = JSON.parse(rawBody.toString("utf-8")) as Record<
        string,
        unknown
      >;
      if (typeof parsed.challengeToken !== "string" || !parsed.challengeToken) {
        throw new Error("missing challengeToken");
      }
      challengeToken = parsed.challengeToken;
    } catch {
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(
        JSON.stringify({
          error: "invalid request body: challengeToken required",
        })
      );
      return {
        activityType: "request",
        requestSizeBytes: exchangeRequestSizeBytes,
      };
    }

    const userAgent =
      firstHeaderValue(request.headers["user-agent"]) ?? undefined;
    const result = await verifyChallenge({
      challengeToken,
      requestOrigin,
      userAgent,
      apiOrigin,
      apiKey,
      apiKeyProvenance: this.options.getApiKeyProvenance?.() ?? "USER_CREATED",
      signDesktopRequest: this.options.signDesktopRequest,
      onDesktopPopUnavailable: this.options.onDesktopPopUnavailable,
    });

    if (!result.ok) {
      const statusCode = result.statusCode ?? 401;
      response.statusCode = statusCode;
      response.setHeader("content-type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ error: result.error }));
      return {
        activityType: "security",
        activityDetail: `exchange rejected: ${result.error}`,
        requestSizeBytes: exchangeRequestSizeBytes,
      };
    }

    const sessionStore = this.options.sessionStore;
    if (!sessionStore) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ error: "session store not available" }));
      return {
        activityType: "request",
        requestSizeBytes: exchangeRequestSizeBytes,
      };
    }

    const session = sessionStore.create(
      requestOrigin,
      result.sessionTtlSeconds
    );

    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.end(
      JSON.stringify({
        sessionToken: session.sessionToken,
        expiresAt: session.expiresAt,
      })
    );
    return {
      activityType: "request",
      requestSizeBytes: exchangeRequestSizeBytes,
    };
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

  private writeRequestTooLargeResponse(
    response: ServerResponse,
    error: RequestBodyTooLargeError
  ): void {
    response.statusCode = 413;
    response.setHeader("content-type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.end(
      JSON.stringify({
        error: "request body too large",
        code: REQUEST_BODY_TOO_LARGE_CODE,
        maxBytes: error.limitBytes,
      })
    );
  }

  private logOversizedRequest(
    method: string,
    path: string,
    error: RequestBodyTooLargeError
  ): void {
    gatewayLog.warn(
      "gateway-router",
      [
        REQUEST_BODY_TOO_LARGE_CODE,
        `method=${method}`,
        `path=${path}`,
        "status=413",
        `route=${error.routeName}`,
        `limitBytes=${error.limitBytes}`,
        `declaredSizeBytes=${error.declaredSizeBytes ?? "absent"}`,
        `observedSizeBytes=${error.observedSizeBytes ?? "absent"}`,
      ].join(" ")
    );
  }

  private async proxyToFallback(
    request: IncomingMessage,
    response: ServerResponse,
    requestPath: string,
    rawBody: Buffer
  ): Promise<void> {
    const targetUrl = new URL(requestPath, this.options.fallbackGatewayOrigin);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (!value) {
        continue;
      }
      if (name.toLowerCase() === "host") {
        continue;
      }
      if (Array.isArray(value)) {
        headers.set(name, value.join(", "));
      } else {
        headers.set(name, value);
      }
    }

    const method = request.method?.toUpperCase() ?? "GET";
    const upstreamResponse = await fetch(targetUrl, {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : new Uint8Array(rawBody),
    });

    response.statusCode = upstreamResponse.status;
    for (const [name, value] of upstreamResponse.headers) {
      if (name.toLowerCase() === "access-control-allow-origin") {
        continue;
      }
      response.setHeader(name, value);
    }

    if (!upstreamResponse.body) {
      response.end();
      return;
    }

    const reader = upstreamResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      response.write(Buffer.from(value));
    }
    response.end();
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

/** Selects the in-code request cap for the current gateway route. */
function resolveRequestBodyLimit(
  method: string,
  pathname: string
): RequestBodyLimit {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "POST" && pathname === "/gateway-auth/exchange") {
    return {
      limitBytes: GATEWAY_AUTH_EXCHANGE_LIMIT_BYTES,
      routeName: "gateway-auth-exchange",
    };
  }
  if (
    normalizedMethod === "POST" &&
    pathname === "/api/gateway/symphony/loop"
  ) {
    return {
      limitBytes: SYMPHONY_LOOP_LIMIT_BYTES,
      routeName: "symphony-loop",
    };
  }
  if (
    normalizedMethod === "POST" &&
    /^\/api\/gateway\/symphony\/upload\/[^/]+$/.test(pathname)
  ) {
    return {
      limitBytes: SYMPHONY_UPLOAD_LIMIT_BYTES,
      routeName: "symphony-upload",
    };
  }
  if (
    normalizedMethod === "POST" &&
    pathname === "/api/gateway/run-viewer-extract"
  ) {
    return {
      limitBytes: RUN_VIEWER_EXTRACT_LIMIT_BYTES,
      routeName: "run-viewer-extract",
    };
  }
  return {
    limitBytes: GENERIC_JSON_LIMIT_BYTES,
    routeName: "generic-json",
  };
}

function parseStrictContentLength(value: string | null): bigint | null {
  if (!(value && /^\d+$/.test(value))) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function bigintToSafeNumber(value: bigint): number | undefined {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(value);
}

function byteLengthOfResponseChunk(chunk: unknown, encoding: unknown): number {
  if (typeof chunk === "string") {
    return Buffer.byteLength(
      chunk,
      typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8"
    );
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.byteLength;
  }
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }
  return 0;
}

function safeEqualToken(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) {
    return false;
  }

  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function isLoopbackOrigin(originValue: string): boolean {
  try {
    const parsed = new URL(originValue);
    const h = parsed.hostname;
    return (
      h === "localhost" ||
      h === "::1" ||
      h === "[::1]" ||
      isLoopbackIPv4(h) ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
