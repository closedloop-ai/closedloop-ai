/**
 * ISS-9184, through a LAUNCHED Electron app — the desktop CLOUD Sessions list
 * refreshes itself while this machine's upsync is LANDING sessions, even though
 * the outbound queue depth never moves.
 *
 * `CloudSessionsSyncBridge` is the only thing that refreshes a cloud Sessions
 * list while a user sits on the page. The HTTP data source exposes no
 * `subscribe`, so `AgentSessionsLiveBridge` is inert on this path, and
 * `createQueryClientForMode` gives the CLOUD client no `refetchInterval` — the
 * FEA-2187 Sessions-list poll defaults are applied to the LOCAL client only. The
 * bridge's movement signal used to key on outbound queue depth alone, and depth
 * is a LEVEL rather than a delivery: during an import the parser refills the
 * queue as fast as the lane drains it, so batch after batch lands in the cloud
 * while the depth reads the SAME number, two consecutive runtime-status samples
 * compare equal, and the list the user is watching never refreshes.
 *
 * The renderer suite pins that signal's DECISION, but it feeds
 * `useCloudSyncProgress` from a mock, so it cannot fail for the way this breaks
 * in the shipped app: `deliveredSessions` is an ISS-7099 field that has to
 * survive main's snapshot → the runtime-status IPC payload → the preload bridge
 * → the shared 1s poller before the bridge can compare two samples at all. That
 * chain is exactly what `apps/desktop/test/AGENTS.md` says a renderer test cannot
 * prove, and driving it is why this spec launches the app.
 *
 * WHAT MAKES THE REFETCH ASSERTION NON-VACUOUS. Both samples come from the same
 * {@link backfillingSample} with ONE argument changed: owed depth, backfilling
 * and caughtUp are identical across them and only `deliveredSessions` moves, so a
 * build whose signal is the owed-only tuple produces two EQUAL signals and emits
 * no movement at all. Nothing else in the run can refetch in its place. The
 * baseline is taken only once the cloud list reads have gone quiet
 * ({@link waitForListReadQuiescence}), so no mount-time read is still in flight
 * when the sample is pushed; after that the spec touches the page not at all — no
 * date-range click, no navigation, no filter change, no reload — the cloud query
 * client has no poll interval, its one other refetch trigger
 * (`refetchOnWindowFocus`) needs a focus event this never-revealed window does
 * not receive, and the stand-in answers every read 200 so nothing retries. The
 * second authenticated list request therefore has exactly one possible cause.
 *
 * The window is never revealed, and a never-revealed page can report
 * `document.hidden`, which would park the bridge's flush behind
 * `useLiveQueryBridge`'s visibility gate until a re-show that never comes. On
 * macOS a suppressed launch reports `visible` on its own; on the Linux/xvfb
 * `desktop-e2e` runner, where the window is never mapped, what covers it is the
 * `backgroundThrottling: false` that `windowRevealSuppressedWebPreferences`
 * (ISS-6112) sets for exactly these launches. This spec depends on that.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  type AgentSessionListItem,
  type AgentSessionListResponse,
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session.ts";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.ts";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  type AuthenticatedCloudRequest,
  closeServer,
  createAuthenticatedDesktopSessionRecord,
  rejectNotFound,
  routeDesktopSessionRefresh,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { pushCloudSyncProgress } from "./helpers/cloud-sync-progress-control";
import {
  drainedCloudReadReadiness,
  type E2eCloudSyncProgress,
  gotoNav,
  identifiedCloudSyncProgress,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

const PROFILE_ID = "iss-9184-cloud-upsync-refresh-profile";
/** Origin used only to parse a relative request URL; never dialled. */
const REQUEST_ORIGIN = "http://127.0.0.1";
const SESSIONS_LIST_PATH = "/agent-sessions";
const SESSIONS_USAGE_PATH = "/agent-sessions/usage";
const CONNECTED_AGENT_PATH = "/compute-targets/has-connected-agent";
const EXPECTED_AUTHORIZATION = `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`;

/**
 * The one row the stand-in serves. Its content is the SAME on every read: this
 * spec's claim is that the read happens again, and a list whose rows also
 * changed would let a stale render satisfy it by accident.
 */
const SESSION_NAME = "ISS-9184 upsync session";
const SESSION_COUNT = 1;

/**
 * The owed depth BOTH samples report — the production shape ISS-9184 was found
 * in. On the fresh-install run that found it, 296 of 769 sessions arrived under
 * a tuple that never changed, including a five-minute stretch pinned at zero
 * owed while 67 sessions landed.
 */
const OWED_BACKFILL_SESSIONS = 5;
/** Sessions the lane had acked at launch, and after two more landed. */
const DELIVERED_BEFORE = 10;
const DELIVERED_AFTER = 12;
const IN_FLIGHT_TOTAL_SESSIONS = 20;

const LIST_MOUNT_TIMEOUT_MS = 30_000;
/**
 * Six times `LIVE_BRIDGE_INVALIDATION_THROTTLE_MS` (5s), which the bridge emits
 * its movement into. Named in prose rather than imported: an extension-less
 * `@repo/*` value import aborts the whole desktop-e2e suite at load time. Drift
 * upward past this budget fails LOUDLY here rather than silently passing.
 */
const REFRESH_BUDGET_MS = 30_000;
/** Gap between quiescence samples — longer than a read against a local stand-in. */
const LIST_READ_QUIET_MS = 3000;
const LIST_READ_QUIESCENCE_TIMEOUT_MS = 60_000;

type SessionsCloudServer = {
  close: () => Promise<void>;
  origin: string;
  requests: AuthenticatedCloudRequest[];
};

test.describe("Cloud Sessions upsync refresh (ISS-9184)", () => {
  test("refetches the cloud list when sessions land under an unchanged queue depth", async () => {
    test.setTimeout(240_000);

    // Empty CLAUDE_HOME/CODEX_HOME so the boot collectors ingest nothing and the
    // local store cannot contribute rows of its own.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-9184-claude-")
    );
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-9184-codex-"));
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-9184-udd-"));
    const server = await startSessionsCloudServer();

    try {
      // Close the production-migrated DB before the unchanged schema barrier.
      await initializeDesktopProfileSchema(userDataDir);
      await waitForBranchesSchema(userDataDir);

      const { app, page, pageErrors, cleanup } =
        await launchAuthenticatedDesktopApp({
          beforeLaunch: (launchUserDataDir) => {
            seedDesktopSettings(launchUserDataDir, {
              activeConfigId: PROFILE_ID,
              apiOrigin: server.origin,
              cloudConnectionEnabled: true,
              savedConfigs: [
                {
                  apiOrigin: server.origin,
                  gatewayId: AUTHENTICATED_GATEWAY_ID,
                  id: PROFILE_ID,
                  name: "ISS-9184 Cloud Upsync Refresh E2E",
                  relayOrigin: "http://127.0.0.1:9",
                  webAppOrigin: "http://127.0.0.1:3000",
                },
              ],
            });
          },
          cloudReadReadiness: drainedCloudReadReadiness(),
          cloudSyncProgress: backfillingSample(DELIVERED_BEFORE),
          env: {
            CLAUDE_HOME: claudeHome,
            CL_AUTH_API_ORIGIN: server.origin,
            CODEX_HOME: codexHome,
          },
          sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
          userDataDir,
        });

      try {
        // Cloud mode is authenticated + online + permitted to sync. Asserted
        // first so a restore that never landed fails HERE, naming itself,
        // instead of downstream as an absent cloud read.
        await expect
          .poll(() =>
            page.evaluate(() => window.desktopApi.getDesktopAuthState())
          )
          .toMatchObject({
            organizationId: AUTHENTICATED_ORGANIZATION_ID,
            status: DesktopAuthStatus.Authenticated,
            userId: AUTHENTICATED_USER_ID,
          });

        await gotoNav(page, "sessions");
        // The row proves the cloud read reached the screen, and it is also what
        // ARMS the bridge: the runtime-status subscription is gated on a Sessions
        // read having a mounted observer (`useSessionsReadsObserved`), so a
        // sample pushed before the list mounted would reach nothing.
        await expect(
          page.getByRole("link", { name: SESSION_NAME })
        ).toBeVisible({ timeout: LIST_MOUNT_TIMEOUT_MS });

        const readsBeforeDelivery = await waitForListReadQuiescence(server);
        expect(
          readsBeforeDelivery,
          "the Sessions view never issued an authenticated cloud list read"
        ).toBeGreaterThanOrEqual(1);

        // Two sessions landed while the queue depth never moved. This is the
        // whole ticket: the owed segment of the tuple is byte-identical to the
        // launch sample, so ONLY the delivered segment can report the movement.
        await pushCloudSyncProgress(app, backfillingSample(DELIVERED_AFTER));

        await expect
          .poll(() => authenticatedListReads(server.requests).length, {
            timeout: REFRESH_BUDGET_MS,
          })
          .toBeGreaterThan(readsBeforeDelivery);
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await server.close();
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

/**
 * The lane mid-backfill, parameterized ONLY by what it has delivered.
 *
 * Every other field is fixed HERE rather than at the two call sites, so the two
 * samples this spec pushes cannot differ in anything but `deliveredSessions` —
 * which is what makes the refetch a read of that one segment and not of the
 * tuple around it.
 */
function backfillingSample(delivered: number): E2eCloudSyncProgress {
  return {
    ...identifiedCloudSyncProgress(),
    backfilling: true,
    caughtUp: false,
    deliveredSessions: delivered,
    inFlightTotalSessions: IN_FLIGHT_TOTAL_SESSIONS,
    pendingBackfillSessions: OWED_BACKFILL_SESSIONS,
    pendingIncrementalSessions: 0,
  };
}

/** The authenticated cloud list reads the stand-in has answered so far. */
function authenticatedListReads(
  requests: AuthenticatedCloudRequest[]
): AuthenticatedCloudRequest[] {
  return requests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname === SESSIONS_LIST_PATH &&
      request.authorization === EXPECTED_AUTHORIZATION
  );
}

/**
 * Block until the mount-time cloud list reads have stopped arriving, and answer
 * with the count they settled at.
 *
 * Load-bearing rather than tidy: a baseline captured while a mount-time read was
 * still in flight would be beaten by that read landing, and the refetch
 * assertion would pass without the bridge ever emitting anything. Two samples a
 * quiet window apart is what rules that out — the cloud query client has no poll
 * interval, so once the view has settled nothing else asks again.
 */
async function waitForListReadQuiescence(
  server: SessionsCloudServer
): Promise<number> {
  let previous = -1;
  await expect
    .poll(
      () => {
        const current = authenticatedListReads(server.requests).length;
        const quiet = current === previous;
        previous = current;
        return quiet;
      },
      {
        intervals: [LIST_READ_QUIET_MS],
        timeout: LIST_READ_QUIESCENCE_TIMEOUT_MS,
      }
    )
    .toBe(true);
  return previous;
}

/**
 * A bounded stand-in for the authenticated cloud Sessions routes.
 *
 * Deliberately NOT folded into `startAuthenticatedBranchCloudServer`: that
 * fixture owns the Branch payloads. The pieces both need — minting the
 * first-party session, the envelope writer, the refusals and the close — are
 * delegated to its exports rather than copied.
 */
async function startSessionsCloudServer(): Promise<SessionsCloudServer> {
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
    routeSessionsRequest(request, requestUrl.pathname, response);
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
    throw new Error("The ISS-9184 Sessions cloud stand-in did not bind.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

function routeSessionsRequest(
  request: IncomingMessage,
  pathname: string,
  response: ServerResponse
): void {
  if (routeDesktopSessionRefresh(request, response)) {
    return;
  }
  if (request.method !== "GET") {
    rejectNotFound(response);
    return;
  }
  if (pathname === SESSIONS_LIST_PATH) {
    writeApiResult(response, listFixture());
    return;
  }
  if (pathname === SESSIONS_USAGE_PATH) {
    writeApiResult(response, usageFixture());
    return;
  }
  if (pathname === CONNECTED_AGENT_PATH) {
    // An org that HAS onboarded, so the list's empty state can only ever be a
    // filters/date result — never the onboarding ask, which renders no rows.
    writeApiResult(response, { hasConnectedAgent: true });
    return;
  }
  rejectNotFound(response);
}

function listFixture(): AgentSessionListResponse {
  return {
    items: [sessionRow()],
    total: SESSION_COUNT,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

/**
 * One synthetic cloud row.
 *
 * Not `sessionListRow` from `e2e/helpers/sessions-list-fixtures.ts`, canonical
 * though it is: that module imports `./mock-users`, which takes a VALUE off an
 * extension-less `@repo/api` subpath, and one such import in a desktop e2e spec
 * aborts the entire suite at load time. The fields here are the type's required
 * set and nothing more.
 */
function sessionRow(): AgentSessionListItem {
  const startedAt = new Date("2026-08-20T12:00:00.000Z");
  const endedAt = new Date("2026-08-20T12:30:00.000Z");
  return {
    agentCount: 1,
    awaitingInputSince: null,
    baseBranch: "main",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    computeTarget: {
      id: "compute-target-iss-9184",
      isOnline: true,
      lastSeenAt: endedAt,
      machineName: "MacBook Pro",
    },
    cwd: "/workspace/closedloop-ai",
    endedAt,
    errorCount: 0,
    estimatedCost: 0,
    externalSessionId: "external-iss-9184-1",
    harness: "claude",
    id: "iss-9184-session-1",
    inputTokens: 0,
    lastActivityAt: endedAt,
    model: "claude-opus-5",
    name: SESSION_NAME,
    outputTokens: 0,
    project: null,
    repositoryFullName: "closedloop-ai/closedloop-ai",
    slug: "SES-9184",
    sourceArtifact: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    startedAt,
    status: SESSION_STATUS.INACTIVE,
    toolUseCount: 0,
    updatedAt: endedAt,
    // Populated rather than null: a cloud row carries the account that uploaded
    // it, and the list renders that cell — a null here would put the row on a
    // branch no production cloud read produces.
    user: {
      avatarUrl: null,
      email: "<redacted-email>",
      firstName: "Upsync",
      id: AUTHENTICATED_USER_ID,
      lastName: "Fixture",
    },
    worktreePath: null,
  };
}

/**
 * The usage aggregate. Deliberately flat: this spec grades a REFETCH, not a
 * number, and every card reading a zero here still settles out of its loading
 * state — which is what keeps the strip from holding the view mid-mount.
 *
 * One `byRepository` entry so the Repository facet needs no analytics fallback
 * read, which this stand-in deliberately does not serve.
 */
function usageFixture(): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 0,
    byHarness: [],
    byModel: [],
    byRepository: [
      {
        errorCount: 0,
        estimatedCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        sessionCount: SESSION_COUNT,
      },
    ],
    byUser: [],
    earliestSessionAt: null,
    lastSyncTargets: [],
    latestSessionAt: null,
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalSessions: SESSION_COUNT,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}
