/**
 * ISS-7720: the desktop e2e stand-in for the authenticated cloud SESSION-DETAIL
 * routes — `GET /agent-sessions/:id` and the reads the detail screen issues
 * around it.
 *
 * WHAT THE LOCAL SQLITE PATH CANNOT PRODUCE, and why a spec must come here for
 * it. `evidenceCoverage` has exactly ONE producer,
 * `resolveSessionEvidenceCoverage` (`apps/api/app/agent-sessions/service/
 * session-evidence-coverage.ts`, called from `service.ts`). The desktop LOCAL
 * read (`src/main/session/shared-agent-session-detail-projection.ts`) never
 * emits the field, and every other `test/e2e/session-*.spec.ts` drives that
 * local path — so a local-path spec asserting anything keyed on
 * `evidenceCoverage` CANNOT FAIL. Route it through this stand-in instead.
 * Whether the local projection SHOULD emit the field is a product question,
 * deliberately not settled here (ISS-7720, "Note").
 *
 * The request record, bearer token, envelope writer, refusals and close come
 * from the branch stand-in rather than being restated.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AgentComponentInvocationSessionTreePage } from "@repo/api/src/types/agent-component-invocation-session-tree";
import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
// `.ts` is load-bearing on this VALUE import and absent on the type-only one
// above: extensionless value specifiers do not resolve under the spec loader,
// and a spec-level import failure aborts the WHOLE desktop-e2e suite at load.
import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session.ts";
import {
  SESSION_ID,
  sessionDetailFixture,
} from "../../../../../e2e/helpers/session-detail-fixtures";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  type AuthenticatedCloudRequest,
  closeServer,
  rejectNotFound,
  rejectUnauthorized,
  routeDesktopSessionRefresh,
  writeApiResult,
} from "./branch-details-authenticated-cloud";
import { seedDesktopFeatureFlags, seedDesktopSettings } from "./desktop-app";

/** The session this stand-in serves — the WEB fixture's, so the two surfaces' specs cannot drift onto different sessions. */
export const CLOUD_SESSION_DETAIL_ID = SESSION_ID;

export type AuthenticatedSessionDetailCloudServer = {
  close: () => Promise<void>;
  origin: string;
  requests: AuthenticatedCloudRequest[];
};

export type AuthenticatedSessionDetailCloudServerOptions = {
  /** Fields laid over {@link sessionDetailFixture} on the detail response — the seam a spec varies. */
  detailOverrides?: Partial<AgentSessionDetail>;
  /**
   * ISS-10737: the page `GET /agent-sessions/:id/invocation-tree` answers.
   *
   * Absent, the path 404s rather than serving an empty page: a spec that never
   * seeded a tree must not be able to read "no components ran" as a pass, and a
   * spec that DID seed one must fail loudly if the shell asked for something
   * else.
   */
  invocationTree?: AgentComponentInvocationSessionTreePage;
  /**
   * Routes the calling spec owns beyond the detail reads, consulted after the
   * session handshake and before the GET-only rejection, as the Branch
   * stand-in's option of the same name is (ISS-12302: custom-field reads and
   * writes). Return `true` once the response has been written.
   */
  extraRoutes?: (request: IncomingMessage, response: ServerResponse) => boolean;
};

/**
 * Starts a bounded local stand-in for the authenticated cloud session-detail
 * routes.
 *
 * Paths resolve by EXACT equality against a closed set, never by prefix: a
 * `startsWith` matcher answers every sub-resource the screen also requests with
 * a well-formed 200 of the wrong container.
 *
 * Session reads REQUIRE the bearer token the restore lane mints; without that
 * 401, a build that stopped sending the header would still render every
 * asserted row and no arm would go red.
 */
export async function startAuthenticatedSessionDetailCloudServer(
  options: AuthenticatedSessionDetailCloudServerOptions = {}
): Promise<AuthenticatedSessionDetailCloudServer> {
  const requests: AuthenticatedCloudRequest[] = [];
  const server = createServer((request, response) => {
    // Concatenated, not `new URL(target, base)`: a target beginning `//` parses
    // as protocol-relative and yields a DIFFERENT pathname, which would record
    // and route the request as something it is not. `URL.parse` returns null
    // instead of throwing, so a malformed target 404s rather than escaping this
    // listener — an uncaught throw here writes no response and hangs the socket.
    const requestUrl = URL.parse(`${REQUEST_ORIGIN}${request.url ?? "/"}`);
    if (!requestUrl) {
      rejectNotFound(response);
      return;
    }
    requests.push({
      authorization: request.headers.authorization ?? null,
      method: request.method ?? "GET",
      pathname: requestUrl.pathname,
      search: requestUrl.search,
    });
    routeSessionDetailRequest(request, requestUrl.pathname, response, options);
  });
  // `listen` reports a bind failure on the `error` event. Unhandled, the promise
  // below never settles and the spec burns its whole timeout with no cause.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("The session-detail cloud stand-in did not bind.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

/**
 * Points the shell at {@link startAuthenticatedSessionDetailCloudServer} and
 * turns Cloud read mode ON, from inside a launcher's `beforeLaunch`.
 *
 * The server alone is inert: `SessionDetailView` reads cloud only when
 * `useDesktopAppCoreMode()` resolves to Cloud, which needs a restored session
 * and a renderer that reports itself online, and it reaches THIS server only
 * with a saved profile pointing at this origin. `cloudConnectionEnabled` is
 * seeded below for the device's sync level; since 2026-09-25 it is no longer a
 * term in the read-source decision.
 */
export function seedCloudSessionDetailProfile(
  userDataDir: string,
  apiOrigin: string,
  featureFlags: Record<string, boolean> = {}
): void {
  seedDesktopSettings(userDataDir, {
    activeConfigId: CLOUD_SESSION_DETAIL_PROFILE_ID,
    apiOrigin,
    cloudConnectionEnabled: true,
    savedConfigs: [
      {
        apiOrigin,
        gatewayId: AUTHENTICATED_GATEWAY_ID,
        id: CLOUD_SESSION_DETAIL_PROFILE_ID,
        name: "Desktop cloud session-detail E2E",
        relayOrigin: "http://127.0.0.1:9",
        webAppOrigin: "http://127.0.0.1:3000",
      },
    ],
  });
  seedDesktopFeatureFlags(userDataDir, featureFlags);
}

/**
 * Whether the recorded request is the AUTHENTICATED detail read under test —
 * bearer token included, so a build that dropped the header cannot satisfy it.
 */
export function isAuthenticatedCloudSessionDetailRead(
  request: Pick<
    AuthenticatedCloudRequest,
    "authorization" | "method" | "pathname"
  >
): boolean {
  return (
    request.method === "GET" &&
    request.pathname === sessionDetailPath() &&
    request.authorization === `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  );
}

function routeSessionDetailRequest(
  request: IncomingMessage,
  pathname: string,
  response: ServerResponse,
  options: AuthenticatedSessionDetailCloudServerOptions
): void {
  if (routeDesktopSessionRefresh(request, response)) {
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
    pathname.startsWith("/agent-sessions") &&
    request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  ) {
    rejectUnauthorized(response);
    return;
  }
  if (pathname === sessionDetailPath()) {
    writeApiResult(response, {
      ...sessionDetailFixture(),
      ...options.detailOverrides,
    });
    return;
  }
  if (pathname === `${sessionDetailPath()}/trace-comments`) {
    writeApiResult(response, []);
    return;
  }
  if (
    pathname === `${sessionDetailPath()}/invocation-tree` &&
    options.invocationTree !== undefined
  ) {
    writeApiResult(response, options.invocationTree);
    return;
  }
  if (pathname === "/agent-sessions") {
    writeApiResult(response, emptyListFixture());
    return;
  }
  if (pathname === "/compute-targets/has-connected-agent") {
    writeApiResult(response, { hasConnectedAgent: true });
    return;
  }
  rejectNotFound(response);
}

/**
 * An empty page — still SETTLES the Sessions read the shell issues on the way
 * to the detail route, which keeps its surfaces out of a permanent load state.
 */
function emptyListFixture(): AgentSessionListResponse {
  return {
    items: [],
    total: 0,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

function sessionDetailPath(): string {
  return `/agent-sessions/${CLOUD_SESSION_DETAIL_ID}`;
}

/** Origin used only to parse a relative request URL; never dialled. */
const REQUEST_ORIGIN = "http://127.0.0.1";

const CLOUD_SESSION_DETAIL_PROFILE_ID = "cloud-session-detail-e2e-profile";
