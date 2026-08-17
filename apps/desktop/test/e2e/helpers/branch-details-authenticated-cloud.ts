import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  type Page,
} from "@playwright/test";
import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
} from "@repo/api/src/types/branch";
import type { BranchTraceResponse } from "@repo/api/src/types/branch-trace";
import { GitHubRepositorySource } from "@repo/api/src/types/github.ts";
import {
  commentsFor,
  timingIncompleteTraceResponse,
  traceResponse,
} from "../../../../../e2e/helpers/branch-details-comprehensive-comments-trace";
import {
  ACTIVE_PR,
  BRANCH_ID,
  detailFor,
  filesFor,
  HISTORICAL_PR,
  timingIncompleteDetailFor,
} from "../../../../../e2e/helpers/branch-details-comprehensive-data";
import type { CloudReadReadinessSnapshot } from "../../../src/shared/cloud-read-readiness-contract.js";
import {
  closeElectronApp,
  cloudReadReadinessEnv,
  cloudReadReadinessLaunchArgs,
  cloudSyncProgressEnv,
  type E2eCloudSyncProgress,
  e2eAppLaunchArgs,
  MAIN_JS,
} from "./desktop-app";
import { completeFakeGitHubAuthority } from "./fake-github-authority-server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const AUTHENTICATED_ACCESS_TOKEN = "desktop-branch-details-access-token";
const REFRESH_TOKEN = "desktop-branch-details-refresh-token";
const ROTATED_REFRESH_TOKEN = "desktop-branch-details-rotated-refresh-token";
export const AUTHENTICATED_USER_ID = "desktop-branch-details-user";
export const AUTHENTICATED_ORGANIZATION_ID =
  "desktop-branch-details-organization";
const TOKEN_EXPIRY = "2027-08-07T00:00:00.000Z";
export const AUTHENTICATED_GATEWAY_ID = "44734473-4473-4473-8473-447344734473";

export type AuthenticatedCloudRequest = {
  authorization: string | null;
  method: string;
  pathname: string;
};

export type AuthenticatedBranchCloudServer = {
  close: () => Promise<void>;
  origin: string;
  requests: AuthenticatedCloudRequest[];
};

/** Launched Electron state needed by the authenticated Branch E2E fixture. */
export type AuthenticatedDesktopApp = {
  app: ElectronApplication;
  cleanup: () => Promise<void>;
  page: Page;
  pageErrors: Error[];
};

/** Inputs for an isolated authenticated Desktop fixture launch. */
export type AuthenticatedDesktopLaunchOptions = {
  beforeLaunch?: (userDataDir: string) => void;
  env?: Record<string, string>;
  userDataDir: string;
  /**
   * ISS-5714: the readiness snapshot the read-source cutover consults. An
   * authenticated launch that asserts the CLOUD Branch path must supply a
   * drained one — signing in no longer moves Branches to the cloud until the
   * upload backlog has demonstrably drained, and the production sampler cannot
   * answer inside a spec's lifetime (see `cloudReadReadinessLaunchArgs`).
   */
  cloudReadReadiness?: CloudReadReadinessSnapshot;
  /**
   * ISS-5489 (PLN-1694 M2): the `cloudSync` half of the runtime-status payload.
   * A spec asserting anything the SESSION lanes report — counts, a progress bar,
   * a drained claim — needs it, because `identified` is true only while the
   * cloud socket is up with a compute target, which no E2E fixture stands up.
   * Without it those surfaces can only ever render their unmeasured state, and
   * the runtime-status → preload → poller chain goes unexercised.
   */
  cloudSyncProgress?: E2eCloudSyncProgress;
};

type AuthenticatedBranchCloudServerOptions = {
  /** Optional authenticated Branches analytics response for complete-page coverage. */
  analyticsFactory?: () => BranchAnalytics;
  /** Overrides only successful detail payloads; timingIncomplete takes precedence. */
  detailFactory?: (pullRequestNumber: number) => BranchPageDetail;
  /** Projects a successful detail after the selected fixture variant resolves. */
  detailProjector?: (detail: BranchPageDetail) => BranchPageDetail;
  /** Optional authenticated Branches List response for launched-list coverage. */
  listFactory?: () => BranchListResponse;
  /** Repositories exposed with complete default-branch authority. */
  repositoryFullNames?: readonly string[];
  timingIncomplete?: boolean;
  traceFactory?: () => BranchTraceResponse;
};

/**
 * Launches the authenticated fixture with a deterministic Linux safeStorage
 * backend. Headless CI cannot expose a usable OS secret key to Electron, so a
 * test-only preload enables Electron's documented basic backend before the
 * production app restores its session; macOS and Windows keep native storage.
 */
export async function launchAuthenticatedDesktopApp({
  beforeLaunch,
  cloudReadReadiness,
  env,
  userDataDir,
  cloudSyncProgress,
}: AuthenticatedDesktopLaunchOptions): Promise<AuthenticatedDesktopApp> {
  fs.mkdirSync(userDataDir, { recursive: true });
  beforeLaunch?.(userDataDir);
  const linuxSafeStorageArgs =
    process.platform === "linux"
      ? [
          "-r",
          path.join(__dirname, "linux-safe-storage-preload.cjs"),
          "--password-store=basic",
        ]
      : [];
  const app = await electron.launch({
    // Chromium switches must precede Electron's app entrypoint. After MAIN_JS
    // they are application arguments and do not select the Linux password store.
    args: [
      ...linuxSafeStorageArgs,
      ...cloudReadReadinessLaunchArgs(cloudReadReadiness),
      MAIN_JS,
      `--user-data-dir=${userDataDir}`,
      ...e2eAppLaunchArgs(false),
    ],
    env: {
      ...process.env,
      ...cloudReadReadinessEnv(cloudReadReadiness),
      ...cloudSyncProgressEnv(cloudSyncProgress),
      CLOSEDLOOP_DISABLE_AUTO_UPDATE: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      OTEL_SDK_DISABLED: "1",
      ...env,
    },
  });
  const page = await app.firstWindow();
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error);
  });
  await page.waitForLoadState("domcontentloaded");
  return {
    app,
    page,
    pageErrors,
    cleanup: () => closeElectronApp(app),
  };
}

/**
 * Encrypts a first-party Desktop session with Electron safeStorage so the next
 * app launch restores through the production refresh-token/session lane.
 */
export async function seedAuthenticatedDesktopSession(
  app: ElectronApplication,
  userDataDir: string
): Promise<void> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPkcs8Pem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const encrypted = await app.evaluate(
    ({ safeStorage }, payload) => {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("Electron safeStorage is unavailable for auth E2E.");
      }
      return {
        session: safeStorage
          .encryptString(payload.serializedSession)
          .toString("base64"),
        signingKey: safeStorage
          .encryptString(payload.privateKeyPkcs8Pem)
          .toString("base64"),
      };
    },
    {
      privateKeyPkcs8Pem,
      serializedSession: JSON.stringify({
        refreshToken: REFRESH_TOKEN,
        refreshTokenExpiresAt: TOKEN_EXPIRY,
        userId: AUTHENTICATED_USER_ID,
        organizationId: AUTHENTICATED_ORGANIZATION_ID,
        gatewayId: AUTHENTICATED_GATEWAY_ID,
      }),
    }
  );

  fs.writeFileSync(
    path.join(userDataDir, "desktop-session.json"),
    JSON.stringify({ encryptedSession: encrypted.session }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(userDataDir, "desktop-gateway-signing-keys.json"),
    JSON.stringify({
      encryptedPrivateKeysByGatewayId: {
        [AUTHENTICATED_GATEWAY_ID]: encrypted.signingKey,
      },
    }),
    "utf8"
  );
}

/** Starts a bounded local stand-in for the authenticated cloud BFF routes. */
export async function startAuthenticatedBranchCloudServer(
  options: AuthenticatedBranchCloudServerOptions = {}
): Promise<AuthenticatedBranchCloudServer> {
  const requests: AuthenticatedCloudRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization ?? null,
      method: request.method ?? "GET",
      pathname: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    });
    routeRequest(request, response, options);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Authenticated Branch cloud server did not bind.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

/**
 * Answer the first-party session refresh the restore lane calls on boot, and say
 * whether this request WAS that call.
 *
 * Exported because a spec whose cloud surface is not Branches still needs a
 * signed-in app: it stands up its own stand-in for the routes it asserts and
 * delegates the auth handshake here, so the token pair and the identity claims
 * this fixture mints stay stated in ONE place. Copying the payload into a second
 * server is how the two would drift into minting different sessions for the same
 * {@link AUTHENTICATED_ACCESS_TOKEN}.
 */
export function routeDesktopSessionRefresh(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (!(request.method === "POST" && pathname === "/desktop/session/refresh")) {
    return false;
  }
  writeJson(response, {
    accessToken: AUTHENTICATED_ACCESS_TOKEN,
    accessTokenExpiresAt: TOKEN_EXPIRY,
    refreshToken: ROTATED_REFRESH_TOKEN,
    refreshTokenExpiresAt: TOKEN_EXPIRY,
    userId: AUTHENTICATED_USER_ID,
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
  });
  return true;
}

export function isAuthenticatedBranchRequest(
  request: AuthenticatedCloudRequest
): boolean {
  return (
    request.pathname.startsWith(`/branches/${BRANCH_ID}`) &&
    request.authorization === `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  );
}

function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AuthenticatedBranchCloudServerOptions
): void {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = requestUrl.pathname;
  if (routeDesktopSessionRefresh(request, response)) {
    return;
  }
  if (
    pathname.startsWith("/branches") &&
    request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  ) {
    rejectUnauthorized(response);
    return;
  }
  if (request.method !== "GET") {
    reject(response);
    return;
  }
  if (
    routeRepositoryAuthorityRequest(
      pathname,
      response,
      options.repositoryFullNames ?? []
    ) ||
    routeBranchListRequest(
      pathname,
      response,
      options.listFactory,
      options.analyticsFactory
    )
  ) {
    return;
  }
  if (pathname === `/branches/${BRANCH_ID}`) {
    const pullRequestNumber = selectedPullRequestNumber(requestUrl);
    let detail = detailFor(pullRequestNumber);
    if (options.timingIncomplete) {
      detail = timingIncompleteDetailFor(pullRequestNumber);
    } else if (options.detailFactory) {
      detail = options.detailFactory(pullRequestNumber);
    }
    writeApiResult(response, projectDetail(detail, options.detailProjector));
    return;
  }
  if (pathname === `/branches/${BRANCH_ID}/comments`) {
    writeApiResult(
      response,
      commentsFor(selectedPullRequestNumber(requestUrl))
    );
    return;
  }
  if (pathname === `/branches/${BRANCH_ID}/selected-pull-request/files`) {
    writeApiResult(response, filesFor(selectedPullRequestNumber(requestUrl)));
    return;
  }
  if (pathname === `/branches/${BRANCH_ID}/trace`) {
    writeApiResult(response, branchTraceFixture(options));
    return;
  }
  if (pathname.endsWith("/trace-comments")) {
    writeApiResult(response, []);
    return;
  }
  reject(response);
}

function selectedPullRequestNumber(requestUrl: URL): number {
  const requested = Number(requestUrl.searchParams.get("pullRequestNumber"));
  return requested === HISTORICAL_PR ? HISTORICAL_PR : ACTIVE_PR;
}

function projectDetail(
  detail: BranchPageDetail,
  projector: AuthenticatedBranchCloudServerOptions["detailProjector"]
): BranchPageDetail {
  return projector?.(detail) ?? detail;
}

function writeApiResult(response: ServerResponse, data: unknown): void {
  writeJson(response, { success: true, data });
}

function writeJson(response: ServerResponse, data: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(data));
}

function reject(response: ServerResponse): void {
  response.statusCode = 404;
  writeApiResult(response, { error: "not found" });
}

function rejectUnauthorized(response: ServerResponse): void {
  response.statusCode = 401;
  writeApiResult(response, { error: "unauthorized" });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolve();
    });
  });
}

function authenticatedRepositoryFixture(fullName: string, index: number) {
  const providerRepositoryId = `desktop-authenticated-repository-${index}`;
  return {
    id: providerRepositoryId,
    fullName,
    githubRepoId: providerRepositoryId,
    source: GitHubRepositorySource.Installation,
    repositoryDefaultAuthority: completeFakeGitHubAuthority(
      fullName,
      providerRepositoryId
    ),
  };
}

function routeRepositoryAuthorityRequest(
  pathname: string,
  response: ServerResponse,
  repositoryFullNames: readonly string[]
): boolean {
  const repositoryFixtures = repositoryFullNames.map(
    authenticatedRepositoryFixture
  );
  if (pathname === "/integrations/github/repositories") {
    writeJson(response, repositoryFixtures);
    return true;
  }
  const repository = repositoryFixtures.find((candidate) =>
    pathname.startsWith(
      `/integrations/github/repositories/${candidate.githubRepoId}/`
    )
  );
  if (repository && pathname.endsWith("/branches")) {
    writeJson(response, { branches: [] });
    return true;
  }
  if (repository && pathname.endsWith("/pull-requests")) {
    writeJson(response, { pullRequests: [] });
    return true;
  }
  return false;
}

function routeBranchListRequest(
  pathname: string,
  response: ServerResponse,
  listFactory: AuthenticatedBranchCloudServerOptions["listFactory"],
  analyticsFactory: AuthenticatedBranchCloudServerOptions["analyticsFactory"]
): boolean {
  if (pathname === "/branches" && listFactory) {
    writeApiResult(response, listFactory());
    return true;
  }
  if (pathname === "/branches/analytics" && analyticsFactory) {
    writeApiResult(response, analyticsFactory());
    return true;
  }
  return false;
}

function branchTraceFixture(
  options: AuthenticatedBranchCloudServerOptions
): BranchTraceResponse {
  if (options.timingIncomplete) {
    return timingIncompleteTraceResponse();
  }
  return options.traceFactory?.() ?? traceResponse();
}
