import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { ApiKeyProvenance } from "../main/api-key-store.js";
import type { DesktopPopSigner } from "../main/desktop-pop.js";
import type { DesktopPopUnavailableReporter } from "../main/desktop-pop-sign-utils.js";
import { gatewayLog } from "../main/gateway-logger.js";
import type { JobStore } from "../main/job-store.js";
import type { LocalSessionStore } from "../main/local-session-store.js";
import type { LoopCompletedHook } from "../main/loop-finalizer.js";
import { LoopSchedulerContext } from "../main/loop-scheduler-context.js";
import type { LoopTokenStore } from "../main/loop-token-store.js";
import {
  getOtlpReceiverState,
  toClaudeCodeOtelReceiverStatus,
} from "../main/otlp-receiver-state.js";
import type { RetrySpawnDeps } from "../main/spawn-retry.js";
import {
  type ComputeTargetCapabilities,
  DEFAULT_GATEWAY_PORT,
  FALLBACK_GATEWAY_PORTS,
  type HealthResponse,
} from "../shared/contracts.js";
import type { BranchPrIdentityResolver } from "./operations/git-pr.js";
import type { WorktreeProvider } from "./operations/symphony-loop.js";
import {
  type DesktopSecurityUpgradePayload,
  type DesktopSecurityUpgradeResult,
  type GatewayActivityEvent,
  type GatewayApprovalRequest,
  type GatewayApprovalResult,
  GatewayRouter,
} from "./router.js";

export type DesktopGatewayServerOptions = {
  host: string;
  preferredPort: number;
  fallbackPorts: readonly number[];
  webAppOrigin: string;
  getWebAppOrigin?: () => string;
  getGatewayAuthToken?: () => string | undefined;
  getAllowedDirectories: () => string[];
  getSymphonyDir?: () => string;
  fallbackGatewayOrigin?: string;
  onActivityEvent?: (event: GatewayActivityEvent) => void;
  evaluateApproval?: (
    request: GatewayApprovalRequest
  ) => GatewayApprovalResult | Promise<GatewayApprovalResult>;
  machineName: string;
  version: string;
  capabilities: ComputeTargetCapabilities;
  getOnboardingCompleted?: () => boolean;
  discoveryFilePath?: string;
  sessionStore?: LocalSessionStore;
  getApiKey?: () => string | null;
  getApiKeyProvenance?: () => ApiKeyProvenance | null;
  signDesktopRequest?: DesktopPopSigner;
  onDesktopPopUnavailable?: DesktopPopUnavailableReporter;
  getApiOrigin?: () => string;
  prodOriginsOnly?: boolean;
  jobStore?: JobStore;
  worktreeProvider?: WorktreeProvider;
  retrySpawnDeps?: RetrySpawnDeps;
  getClaudeCodeOtelReceiverStatus?: () => unknown;
  onUnexpectedClose?: () => void;
  loopTokenStore?: LoopTokenStore;
  /**
   * Per-process container for loop heartbeat/refresh/sleep timers. If not
   * provided, the server constructs and owns one, disposing it in `stop()`.
   * Production passes the app-level singleton so its lifetime matches app boot.
   */
  schedulers?: LoopSchedulerContext;
  /** Fired on the live-exit edge when a loop reaches terminal success. */
  onLoopCompleted?: LoopCompletedHook;
  getGatewayId?: () => string;
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
  enableLegacyGithubDataRoutes?: boolean;
  resolveBranchPrIdentity?: BranchPrIdentityResolver;
};

export class DesktopGatewayServer {
  private readonly options: DesktopGatewayServerOptions;
  private readonly router: GatewayRouter;
  private readonly schedulers: LoopSchedulerContext;
  /** True when this server constructed its own LoopSchedulerContext and must dispose it on stop(). */
  private readonly ownsSchedulers: boolean;
  private server: Server | null = null;
  private alive = false;
  private activePort: number;

  constructor(options: DesktopGatewayServerOptions) {
    this.options = {
      ...options,
      getGatewayId: options.getGatewayId ?? (() => ""),
      discoveryFilePath:
        options.discoveryFilePath ??
        path.join(os.homedir(), ".closedloop-ai", "electron-port"),
    };
    // When no scheduler context is injected (tests, ad-hoc usage), the server
    // owns a fresh one and tears it down in stop() — so a test that only
    // constructs DesktopGatewayServer cannot leak heartbeat/refresh timers.
    this.schedulers = options.schedulers ?? new LoopSchedulerContext();
    this.ownsSchedulers = options.schedulers === undefined;
    this.activePort = this.options.preferredPort;
    this.router = new GatewayRouter({
      webAppOrigin: this.options.webAppOrigin,
      getWebAppOrigin: this.options.getWebAppOrigin,
      getGatewayAuthToken: this.options.getGatewayAuthToken,
      machineName: this.options.machineName,
      version: this.options.version,
      capabilities: this.options.capabilities,
      getOnboardingCompleted: this.options.getOnboardingCompleted,
      getActivePort: () => this.activePort,
      getAllowedDirectories: this.options.getAllowedDirectories,
      getSymphonyDir: this.options.getSymphonyDir,
      fallbackGatewayOrigin: this.options.fallbackGatewayOrigin,
      onActivityEvent: this.options.onActivityEvent,
      evaluateApproval: this.options.evaluateApproval,
      sessionStore: this.options.sessionStore,
      getApiKey: this.options.getApiKey,
      getApiKeyProvenance: this.options.getApiKeyProvenance,
      signDesktopRequest: this.options.signDesktopRequest,
      onDesktopPopUnavailable: this.options.onDesktopPopUnavailable,
      getApiOrigin: this.options.getApiOrigin,
      prodOriginsOnly: this.options.prodOriginsOnly,
      jobStore: this.options.jobStore,
      worktreeProvider: this.options.worktreeProvider,
      loopTokenStore: this.options.loopTokenStore,
      schedulers: this.schedulers,
      onLoopCompleted: this.options.onLoopCompleted,
      retrySpawnDeps: this.options.retrySpawnDeps,
      getClaudeCodeOtelReceiverStatus:
        this.options.getClaudeCodeOtelReceiverStatus,
      getGatewayId: this.options.getGatewayId ?? (() => ""),
      getComputeTargetId: this.options.getComputeTargetId,
      handleSecurityUpgrade: this.options.handleSecurityUpgrade,
      getBinaryPaths: this.options.getBinaryPaths,
      applyBinaryPathPatch: this.options.applyBinaryPathPatch,
      checkForUpdate: this.options.checkForUpdate,
      applyUpdate: this.options.applyUpdate,
      isUpdateAndRestartEnabled: this.options.isUpdateAndRestartEnabled,
      enableLegacyGithubDataRoutes: this.options.enableLegacyGithubDataRoutes,
      resolveBranchPrIdentity: this.options.resolveBranchPrIdentity,
    });
  }

  static createDefault(
    webAppOrigin: string,
    getGatewayAuthToken: () => string | undefined,
    getAllowedDirectories: () => string[],
    machineName: string,
    version: string,
    capabilities: ComputeTargetCapabilities,
    onActivityEvent?: (event: GatewayActivityEvent) => void,
    evaluateApproval?: (
      request: GatewayApprovalRequest
    ) => GatewayApprovalResult | Promise<GatewayApprovalResult>,
    getSymphonyDir?: () => string,
    sessionStore?: LocalSessionStore,
    getApiKey?: () => string | null,
    getApiOrigin?: () => string,
    getWebAppOrigin?: () => string,
    prodOriginsOnly?: boolean,
    jobStore?: JobStore,
    onUnexpectedClose?: () => void,
    loopTokenStore?: LoopTokenStore,
    retrySpawnDeps?: RetrySpawnDeps,
    getGatewayId: () => string = () => "",
    getBinaryPaths?: () => {
      claude?: string;
      gh?: string;
      codex?: string;
      cursor?: string;
      opencode?: string;
      python3?: string;
      git?: string;
    },
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
    },
    checkForUpdate?: () => Promise<{
      updateAvailable: boolean;
      version?: string;
    }>,
    applyUpdate?: () => Promise<void>,
    isUpdateAndRestartEnabled?: () => boolean,
    getApiKeyProvenance?: () => ApiKeyProvenance | null,
    signDesktopRequest?: DesktopPopSigner,
    onDesktopPopUnavailable?: DesktopPopUnavailableReporter,
    getComputeTargetId?: () => string | null,
    handleSecurityUpgrade?: (
      payload: DesktopSecurityUpgradePayload
    ) => Promise<DesktopSecurityUpgradeResult> | DesktopSecurityUpgradeResult,
    getOnboardingCompleted?: () => boolean,
    schedulers?: LoopSchedulerContext,
    onLoopCompleted?: LoopCompletedHook,
    resolveBranchPrIdentity?: BranchPrIdentityResolver
  ): DesktopGatewayServer {
    return new DesktopGatewayServer({
      host: "127.0.0.1",
      preferredPort: DEFAULT_GATEWAY_PORT,
      fallbackPorts: FALLBACK_GATEWAY_PORTS,
      webAppOrigin,
      getWebAppOrigin,
      getGatewayAuthToken,
      getAllowedDirectories,
      getSymphonyDir,
      fallbackGatewayOrigin: process.env.SYMPHONY_GATEWAY_FALLBACK_ORIGIN,
      onActivityEvent,
      evaluateApproval,
      machineName,
      version,
      capabilities,
      sessionStore,
      getApiKey,
      getApiKeyProvenance,
      signDesktopRequest,
      onDesktopPopUnavailable,
      getApiOrigin,
      prodOriginsOnly,
      jobStore,
      onUnexpectedClose,
      loopTokenStore,
      retrySpawnDeps,
      getClaudeCodeOtelReceiverStatus: () =>
        toClaudeCodeOtelReceiverStatus(getOtlpReceiverState()),
      getGatewayId,
      getComputeTargetId,
      handleSecurityUpgrade,
      getOnboardingCompleted,
      getBinaryPaths,
      applyBinaryPathPatch,
      checkForUpdate,
      applyUpdate,
      isUpdateAndRestartEnabled,
      schedulers,
      onLoopCompleted,
      resolveBranchPrIdentity,
    });
  }

  getAddress(): DesktopGatewayServerOptions {
    return this.options;
  }

  getActivePort(): number {
    return this.activePort;
  }

  getHealthResponse(): HealthResponse {
    return {
      status: "ok",
      machineName: this.options.machineName,
      capabilities: this.options.capabilities,
      gatewayId: this.options.getGatewayId?.() || undefined,
      onboardingCompleted: this.options.getOnboardingCompleted?.() ?? false,
      version: this.options.version,
      port: this.activePort,
    };
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const candidates = [
      this.options.preferredPort,
      ...this.options.fallbackPorts,
    ];
    let lastError: Error | null = null;

    for (const candidate of candidates) {
      const candidateServer = createServer((request, response) => {
        void this.router.handle(request, response);
      });

      try {
        await this.listen(candidateServer, candidate);
        this.server = candidateServer;
        this.alive = true;
        const addr = candidateServer.address();
        this.activePort =
          typeof addr === "object" && addr ? addr.port : candidate;
        candidateServer.on("error", (err) => {
          gatewayLog.error("gateway-server", `Server error: ${err.message}`);
        });
        candidateServer.on("close", () => {
          if (this.server === candidateServer) {
            this.alive = false;
            this.server = null;
            gatewayLog.warn("gateway-server", "Server closed unexpectedly");
            this.options.onUnexpectedClose?.();
          }
        });
        await this.writeDiscoveryFile();
        return;
      } catch (error) {
        candidateServer.removeAllListeners();
        candidateServer.close();
        const boundError = error as NodeJS.ErrnoException;
        if (boundError.code === "EADDRINUSE") {
          lastError = boundError;
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `failed to bind gateway server to any candidate port (${candidates.join(", ")}): ${lastError?.message ?? "unknown error"}`
    );
  }

  async stop(): Promise<void> {
    this.alive = false;
    if (!this.server) {
      if (this.ownsSchedulers) {
        this.schedulers[Symbol.dispose]();
      }
      return;
    }

    const runningServer = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      runningServer.close((error) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
        ) {
          reject(error);
          return;
        }
        resolve();
      });
      // Force-drop active NDJSON/SSE streams so close() can actually complete.
      runningServer.closeAllConnections();
    });
    if (this.ownsSchedulers) {
      this.schedulers[Symbol.dispose]();
    }
  }

  isAlive(): boolean {
    return this.alive && this.server?.listening === true;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async listen(server: Server, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, this.options.host, () => resolve());
    });
  }

  private async writeDiscoveryFile(): Promise<void> {
    if (!this.options.discoveryFilePath) {
      return;
    }

    const discoveryDirectory = path.dirname(this.options.discoveryFilePath);
    await fs.mkdir(discoveryDirectory, { recursive: true });
    await fs.writeFile(
      this.options.discoveryFilePath,
      String(this.activePort),
      "utf-8"
    );
  }
}
