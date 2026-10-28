import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { type ElectronApplication, expect } from "@playwright/test";
import { CollaboratorArtifactType } from "@repo/api/src/types/artifact-collaborators.ts";
import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
} from "@repo/api/src/types/branch";
import type { BranchTraceResponse } from "@repo/api/src/types/branch-trace";
import { CommentSurface } from "@repo/api/src/types/comment.ts";
import { GitHubRepositorySource } from "@repo/api/src/types/github.ts";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model.ts";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity.ts";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind.ts";
import { artifactCollaboratorBatchFixture } from "@repo/app/shared/__tests__/fixtures/artifact-collaborators.ts";
import { z } from "zod";
import { branchActivityPage } from "../../../../../e2e/helpers/branch-details-comprehensive-activity";
import {
  commentsFor,
  nativeComment,
  sessionNativeComment,
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
import { evaluateElectronSynchronously } from "./evaluate-electron-synchronously";

export const AUTHENTICATED_ACCESS_TOKEN = "desktop-branch-details-access-token";
const REFRESH_TOKEN = "desktop-branch-details-refresh-token";
const ROTATED_REFRESH_TOKEN = "desktop-branch-details-rotated-refresh-token";
export const AUTHENTICATED_USER_ID = "desktop-branch-details-user";
export const AUTHENTICATED_ORGANIZATION_ID =
  "desktop-branch-details-organization";
const TOKEN_EXPIRY = "2027-08-07T00:00:00.000Z";
export const AUTHENTICATED_GATEWAY_ID = "44734473-4473-4473-8473-447344734473";
/** Closed fixture IDs used to prove a repeated-ID Cloud batch over the launched IPC bridge. */
export const CLOUD_COLLABORATOR_ARTIFACT_IDS = [
  "55555555-5555-4555-8555-555555555551",
  "55555555-5555-4555-8555-555555555552",
] as const;

export type AuthenticatedCloudRequest = {
  authorization: string | null;
  method: string;
  pathname: string;
  search: string;
};

export type AuthenticatedBranchCloudServer = {
  close: () => Promise<void>;
  origin: string;
  requests: AuthenticatedCloudRequest[];
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
  /**
   * Routes the calling spec owns that are NOT the Branches surface — the tag
   * reads and writes a Branches row's tag cell issues, for instance. Return
   * `true` once the response has been written.
   *
   * Consulted after the session handshake and BEFORE the GET-only rejection
   * below, because a spec asserting a mutation needs its POST/PATCH answered
   * rather than 404'd. Keeping it here, instead of standing up a second server
   * per spec, keeps ONE origin minting the session for
   * {@link AUTHENTICATED_ACCESS_TOKEN} (see {@link routeDesktopSessionRefresh}).
   */
  extraRoutes?: (request: IncomingMessage, response: ServerResponse) => boolean;
};

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
  // Settle the startup context before writing each encrypted fixture file once.
  let encrypted!: { session: string; signingKey: string };
  await expect(async () => {
    encrypted = await evaluateElectronSynchronously(
      app,
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
        serializedSession: JSON.stringify(
          createAuthenticatedDesktopSessionRecord()
        ),
      },
      encryptedDesktopSeedSchema
    );
  }).toPass({ intervals: [100, 250, 500], timeout: 10_000 });

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
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      authorization: request.headers.authorization ?? null,
      method: request.method ?? "GET",
      pathname: requestUrl.pathname,
      search: requestUrl.search,
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
  request: Pick<AuthenticatedCloudRequest, "authorization" | "pathname">
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
  if (pathname === "/artifacts/collaborators") {
    routeCollaborators(request, response, requestUrl);
    return;
  }
  if (
    pathname.startsWith("/branches") &&
    request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  ) {
    rejectUnauthorized(response);
    return;
  }
  if (options.extraRoutes?.(request, response)) {
    return;
  }
  if (request.method !== "GET") {
    rejectNotFound(response);
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
  if (pathname === `/branches/${BRANCH_ID}/activity`) {
    writeApiResult(response, branchActivityPage());
    return;
  }
  if (routeTraceCommentRequest(requestUrl, response)) {
    return;
  }
  rejectNotFound(response);
}

function routeCollaborators(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): void {
  if (
    request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  ) {
    rejectUnauthorized(response);
    return;
  }
  const artifactType = url.searchParams.get("artifactType");
  const ids = url.searchParams.getAll("artifactIds");
  if (
    request.method !== "GET" ||
    (artifactType !== CollaboratorArtifactType.Branch &&
      artifactType !== CollaboratorArtifactType.Session) ||
    ids.join() !== CLOUD_COLLABORATOR_ARTIFACT_IDS.join()
  ) {
    rejectNotFound(response);
    return;
  }
  writeApiResult(response, artifactCollaboratorBatchFixture(artifactType, ids));
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

/** The `{success, data}` envelope every cloud BFF route answers in. */
export function writeApiResult(response: ServerResponse, data: unknown): void {
  writeJson(response, { success: true, data });
}

function writeJson(response: ServerResponse, data: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(data));
}

/** 404 in that same envelope, for a path a stand-in deliberately does not model. */
export function rejectNotFound(response: ServerResponse): void {
  response.statusCode = 404;
  writeApiResult(response, { error: "not found" });
}

/** 401 in that same envelope, for a read that arrived without the bearer token. */
export function rejectUnauthorized(response: ServerResponse): void {
  response.statusCode = 401;
  writeApiResult(response, { error: "unauthorized" });
}

/** Closes a stand-in's listener, surfacing a close error rather than hanging. */
export async function closeServer(server: Server): Promise<void> {
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
    repositoryDefaultAuthority: completeRepositoryAuthority(
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

function isBranchCommentBatchRequest(requestUrl: URL): boolean {
  return (
    requestUrl.pathname === `/branches/${BRANCH_ID}/trace-comments` &&
    requestUrl.searchParams.get("surface") === CommentSurface.BranchTimeline &&
    requestUrl.searchParams.get("includeSessions") === "true"
  );
}

function routeTraceCommentRequest(
  requestUrl: URL,
  response: ServerResponse
): boolean {
  if (!requestUrl.pathname.endsWith("/trace-comments")) {
    return false;
  }
  if (isBranchCommentBatchRequest(requestUrl)) {
    writeApiResult(response, [
      nativeComment(CommentSurface.BranchTimeline),
      sessionNativeComment(),
    ]);
  } else {
    writeApiResult(response, []);
  }
  return true;
}

const encryptedDesktopSeedSchema = z
  .object({ session: z.string().min(1), signingKey: z.string().min(1) })
  .strict();

/** Canonical synthetic session claims reused by both authenticated fixture seed paths. */
export function createAuthenticatedDesktopSessionRecord() {
  return {
    refreshToken: REFRESH_TOKEN,
    refreshTokenExpiresAt: TOKEN_EXPIRY,
    userId: AUTHENTICATED_USER_ID,
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    gatewayId: AUTHENTICATED_GATEWAY_ID,
  };
}

function completeRepositoryAuthority(
  fullName: string,
  providerRepositoryId: string
) {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "main",
    },
    provenance: {
      source: RepositoryDefaultSource.InstallationRepositoriesRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: `desktop-e2e:${fullName}`,
      observedAt: "2026-08-11T12:00:00.000Z",
    },
  };
}
