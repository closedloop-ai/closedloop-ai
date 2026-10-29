import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { LocalSessionStore } from "../main/auth/local-session-store.js";
import { gatewayLog } from "../main/logging/gateway-logger.js";
import {
  type ComputeTargetCapabilities,
  DEFAULT_GATEWAY_PORT,
  FALLBACK_GATEWAY_PORTS,
  type HealthResponse,
} from "../shared/contracts.js";
import type { BinaryPathKey, BinaryPaths } from "./operations/binary-paths.js";
import {
  buildGitPullRequestApiOptions,
  type DesktopGatewayGitPullRequestSessionAccess,
  type GitPullRequestApiOptions,
} from "./operations/git-pr-api-client.js";
import type { MemberPackInstaller } from "./operations/member-pack-install.js";
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
  gitPullRequestApiOptions?: GitPullRequestApiOptions;
  prodOriginsOnly?: boolean;
  onUnexpectedClose?: () => void;
  getGatewayId?: () => string;
  getComputeTargetId?: () => string | null;
  handleSecurityUpgrade?: (
    payload: DesktopSecurityUpgradePayload
  ) => Promise<DesktopSecurityUpgradeResult> | DesktopSecurityUpgradeResult;
  getBinaryPaths?: () => BinaryPaths;
  applyBinaryPathPatch?: (
    patch: Partial<Record<BinaryPathKey, string | null>>
  ) => BinaryPaths;
  /** Starts a vetted catalog-pack install for member self-service (FEA-4082). */
  installPack?: MemberPackInstaller;
};

export class DesktopGatewayServer {
  private readonly options: DesktopGatewayServerOptions;
  private readonly router: GatewayRouter;
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
      gitPullRequestApiOptions: this.options.gitPullRequestApiOptions,
      prodOriginsOnly: this.options.prodOriginsOnly,
      getGatewayId: this.options.getGatewayId ?? (() => ""),
      getComputeTargetId: this.options.getComputeTargetId,
      handleSecurityUpgrade: this.options.handleSecurityUpgrade,
      getBinaryPaths: this.options.getBinaryPaths,
      applyBinaryPathPatch: this.options.applyBinaryPathPatch,
      installPack: this.options.installPack,
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
    getApiOrigin?: () => string,
    getWebAppOrigin?: () => string,
    prodOriginsOnly?: boolean,
    onUnexpectedClose?: () => void,
    getGatewayId: () => string = () => "",
    getBinaryPaths?: () => BinaryPaths,
    applyBinaryPathPatch?: (
      patch: Partial<Record<BinaryPathKey, string | null>>
    ) => BinaryPaths,
    getComputeTargetId?: () => string | null,
    handleSecurityUpgrade?: (
      payload: DesktopSecurityUpgradePayload
    ) => Promise<DesktopSecurityUpgradeResult> | DesktopSecurityUpgradeResult,
    getOnboardingCompleted?: () => boolean,
    installPack?: MemberPackInstaller,
    gitPullRequestSessionAccess?: DesktopGatewayGitPullRequestSessionAccess
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
      fallbackGatewayOrigin: resolveFallbackGatewayOrigin(),
      onActivityEvent,
      evaluateApproval,
      machineName,
      version,
      capabilities,
      sessionStore,
      gitPullRequestApiOptions: buildGitPullRequestApiOptions(
        gitPullRequestSessionAccess,
        getApiOrigin
      ),
      prodOriginsOnly,
      onUnexpectedClose,
      getGatewayId,
      getComputeTargetId,
      handleSecurityUpgrade,
      getOnboardingCompleted,
      getBinaryPaths,
      applyBinaryPathPatch,
      installPack,
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

/**
 * `SYMPHONY_GATEWAY_FALLBACK_ORIGIN`, checked once at construction (ISS-8234).
 *
 * The value is used as the BASE of `new URL(requestPath, base)` in the fallback
 * proxy. Read straight off `process.env` it got no parse and no format check,
 * so a scheme-less `localhost:3000` was accepted here and only threw later,
 * per-request, deep inside the router.
 *
 * Two checks, because the base has to SURVIVE that join, not merely parse:
 *
 * 1. The TWO-argument `URL.canParse`, which is the join itself. The
 *    one-argument spelling is the obvious-looking one and does NOT reject the
 *    typo this exists to catch: `URL.canParse("localhost:3000")` is `true`,
 *    because `localhost:` parses as a custom scheme — yet that value is still
 *    not a usable base, so `new URL(path, it)` throws and every fallback
 *    request degrades to the generic 502 instead of naming the misconfiguration.
 * 2. No path, query or fragment (ISS-8234 review, whitlockk). `requestPath` is
 *    always absolute, so the join resolves it at the HOST ROOT and discards all
 *    three: a `http://localhost:3000/prefix` base proxies to
 *    `http://localhost:3000/api/gateway/…` with the prefix silently gone.
 *    Rejecting it is the honest answer — a prefix that looks configured and
 *    never applies is the misconfiguration this function exists to name.
 */
function resolveFallbackGatewayOrigin(): string | undefined {
  const configured = process.env.SYMPHONY_GATEWAY_FALLBACK_ORIGIN;
  if (!configured) {
    return undefined;
  }
  if (!URL.canParse("/", configured)) {
    throw new Error(
      `SYMPHONY_GATEWAY_FALLBACK_ORIGIN must be an absolute URL (e.g. http://localhost:3000); got ${JSON.stringify(configured)}`
    );
  }
  const parsed = new URL(configured);
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      `SYMPHONY_GATEWAY_FALLBACK_ORIGIN must be a bare origin with no path, query or fragment (e.g. http://localhost:3000) — the proxy joins it with an absolute request path, which discards all three; got ${JSON.stringify(configured)}`
    );
  }
  return configured;
}
