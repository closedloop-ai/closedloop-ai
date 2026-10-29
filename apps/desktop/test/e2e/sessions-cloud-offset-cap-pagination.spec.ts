/**
 * ISS-9074 — the desktop Sessions paginator, in CLOUD mode, must not advertise a
 * page the cloud API refuses to serve.
 *
 * `GET /agent-sessions` rejects `offset > SESSION_LIST_MAX_OFFSET` with a 400
 * (ISS-8528). The footer always renders a last-page link, so before this fix a
 * cloud account past the ceiling got a link whose only possible answer was that
 * 400 — on a page that could not repair itself, because the clamp that would
 * rescue it reads a `total` the failed query never returned.
 *
 * WHY CLOUD, and why that is the whole reachable half of this shell's contract.
 * `SessionsView` takes the ceiling as `isCloudMode ? SESSION_LIST_MAX_OFFSET :
 * undefined`, because the local SQLite source has no offset ceiling and must
 * keep advertising every page its rows imply. Only the cloud arm is drivable
 * here: the local arm's boundary sits past 10,000 rows, which is not a corpus a
 * spec can seed, so it stays pinned by the renderer suites
 * (`__tests__/sessions-render-model-pagination.test.ts`,
 * `__tests__/sessions-page-bounds.test.ts`) which call the derivations with an
 * absent `maxOffset` directly.
 *
 * WHY A LAUNCHED-APP SPEC at all, given those suites: they call the derivations.
 * The defect is a rendered link whose destination the server refuses, and the
 * chain that produces it — the cloud HTTP source, the react-query read, the page
 * clamp effect and the shipped footer — is exactly what a derivation test does
 * not execute. `apps/desktop/AGENTS.md` ("UI bug fix ⇒ regression e2e") asks for
 * this. The placeholder-footer case retains the separate native held-empty-read
 * boundary; this case owns the cloud-offset/pagination boundary.
 *
 * WHAT MAKES IT NON-VACUOUS. The stand-in answers exactly as the real route
 * does: 400 above the ceiling, and otherwise the window the request named,
 * GENERATED from that `offset`. So a build that advertises page
 * {@link UNCAPPED_LAST_PAGE_LABEL} does not merely render a different number —
 * clicking it reaches the reported dead end. Both halves are asserted: the
 * number the footer offers, and the ROWS that arrive when it is followed.
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
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type AgentSessionListItem,
  type AgentSessionListResponse,
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session.ts";
import { SESSION_LIST_MAX_OFFSET } from "@repo/api/src/types/agent-session-list-limits.ts";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.ts";
import { resolveMaxPageIndex } from "@repo/api/src/utils/math.ts";
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
import {
  drainedCloudReadReadiness,
  gotoNav,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

const PROFILE_ID = "iss-9074-cloud-offset-cap-profile";
/** Origin used only to parse a relative request URL; never dialled. */
const REQUEST_ORIGIN = "http://127.0.0.1";
const SESSIONS_LIST_PATH = "/agent-sessions";
const SESSIONS_USAGE_PATH = "/agent-sessions/usage";
const CONNECTED_AGENT_PATH = "/compute-targets/has-connected-agent";
const EXPECTED_AUTHORIZATION = `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`;

/**
 * `PAGE_SIZE` from `src/renderer/components/sessions/sessions-render-model.ts`,
 * restated as a literal. That module is renderer code and importing it into a
 * spec pulls a component runtime through Playwright's ESM loader, where a
 * spec-level import failure aborts the WHOLE desktop-e2e suite at load. The ceiling
 * itself is imported — `agent-session-list-limits.ts` is a dependency-free
 * `@repo/api` module that resolves with its extension.
 */
const PAGE_SIZE = 25;
/**
 * A population far past the ceiling: 30,000 rows at 25/page is 1,200 pages of
 * rows and 401 the cloud route will actually answer.
 */
const TOTAL_SESSIONS = 30_000;
/** Zero-based; the highest page whose offset the cloud route still serves. */
const LAST_SERVABLE_PAGE_INDEX = resolveMaxPageIndex(
  SESSION_LIST_MAX_OFFSET,
  PAGE_SIZE
);
/** One-based, as the footer labels it. */
const LAST_SERVABLE_PAGE_LABEL = String(LAST_SERVABLE_PAGE_INDEX + 1);
/** What the footer read before the cap — the number this spec must never see. */
const UNCAPPED_LAST_PAGE_LABEL = String(Math.ceil(TOTAL_SESSIONS / PAGE_SIZE));

/** `Pagination`'s wrapper (`@closedloop-ai/design-system/components/ui/pagination`). */
const PAGER_SELECTOR = '[aria-label="pagination"]';
/**
 * The footer's NUMBERED page controls. `PaginationPrevious`/`PaginationNext`
 * render the same `data-slot` and are separated by their `aria-label` — only
 * the numbered links carry none.
 */
const NUMBERED_PAGE_LINK_SELECTOR =
  '[data-slot="pagination-link"]:not([aria-label])';

const MOUNT_TIMEOUT_MS = 30_000;

/** Playwright's default accessible-name match is a substring match. */
const EXACT_NAME = { exact: true } as const;

type SessionsCloudServer = {
  close: () => Promise<void>;
  origin: string;
  requests: AuthenticatedCloudRequest[];
};

test.describe("Cloud Sessions offset ceiling (ISS-9074)", () => {
  test("offers only pages the cloud route will serve, and lands on the last of them", async () => {
    test.setTimeout(240_000);

    // Empty CLAUDE_HOME/CODEX_HOME so the boot collectors ingest nothing and the
    // local store cannot contribute rows or a total of its own.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-9074-claude-")
    );
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-9074-codex-"));
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-9074-udd-"));
    const server = await startSessionsCloudServer();

    try {
      // Close the production-migrated DB before the unchanged schema barrier.
      await initializeDesktopProfileSchema(userDataDir);
      await waitForBranchesSchema(userDataDir);

      const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp(
        {
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
                  name: "ISS-9074 Cloud Offset Cap E2E",
                  relayOrigin: "http://127.0.0.1:9",
                  webAppOrigin: "http://127.0.0.1:3000",
                },
              ],
            });
          },
          cloudReadReadiness: drainedCloudReadReadiness(),
          env: {
            CLAUDE_HOME: claudeHome,
            CL_AUTH_API_ORIGIN: server.origin,
            CODEX_HOME: codexHome,
          },
          sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
          userDataDir,
        }
      );

      try {
        // Cloud mode is authenticated + online + permitted to sync, and it is
        // what supplies the ceiling at all. Asserted first so a restore that
        // never landed fails HERE, naming itself, rather than downstream as a
        // paginator that was never capped because the mode was Local.
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

        // Page 1 settled against the large population, so the footer below is
        // derived from a real total rather than rendered over a pending read.
        await expect(sessionRowLink(page, 1)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(pager(page)).toBeVisible();

        // The claim: the highest page offered is the last one the ceiling
        // allows.
        const numbered = numberedPageLinks(page);
        const lastPageLink = numbered.last();
        await expect(lastPageLink).toHaveText(LAST_SERVABLE_PAGE_LABEL);
        // The same claim from the other side, on the SAME locator, so the
        // assertion above is not the only thing standing between this build and
        // the reported defect: the page count the ROW TOTAL implies is what the
        // uncapped footer rendered, and it must not be offered at all.
        await expect(
          numbered.filter({ hasText: UNCAPPED_LAST_PAGE_LABEL })
        ).toHaveCount(0);

        // And it is genuinely reachable — the half a number-only assertion
        // cannot see. The rows are generated from the requested window, so both
        // an empty page and the route's refusal fail here.
        await lastPageLink.click();
        await expect(
          sessionRowLink(page, SESSION_LIST_MAX_OFFSET + 1)
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // Asserted from the test body after an awaited UI state proved the
        // stand-in answered: nothing the surface asked the cloud route for could
        // have been refused.
        expect(
          refusedOffsets(server.requests),
          "the Sessions view asked the cloud route for an offset past the ceiling"
        ).toEqual([]);
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

/** The visible view's pager — keep-alive views stay mounted but hidden. */
function pager(page: Page): Locator {
  return page.locator(PAGER_SELECTOR).locator("visible=true").first();
}

function numberedPageLinks(page: Page): Locator {
  return pager(page).locator(NUMBERED_PAGE_LINK_SELECTOR);
}

/** The row the stand-in generates for a one-based position in the population. */
function sessionRowLink(page: Page, position: number): Locator {
  return page
    .getByRole("link", { ...EXACT_NAME, name: rowName(position) })
    .locator("visible=true")
    .first();
}

function rowName(position: number): string {
  return `ISS-9074 cloud session ${position}`;
}

/** Every authenticated list `offset` the stand-in had to refuse. */
function refusedOffsets(requests: AuthenticatedCloudRequest[]): number[] {
  return requests
    .filter(
      (request) =>
        request.method === "GET" &&
        request.pathname === SESSIONS_LIST_PATH &&
        request.authorization === EXPECTED_AUTHORIZATION
    )
    .map((request) => requestedOffset(request.search))
    .filter((offset) => offset > SESSION_LIST_MAX_OFFSET);
}

function requestedOffset(search: string): number {
  return Number(new URLSearchParams(search).get("offset") ?? "0");
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
    routeSessionsRequest(request, requestUrl, response);
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
    throw new Error("The ISS-9074 Sessions cloud stand-in did not bind.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

function routeSessionsRequest(
  request: IncomingMessage,
  requestUrl: URL,
  response: ServerResponse
): void {
  if (routeDesktopSessionRefresh(request, response)) {
    return;
  }
  if (request.method !== "GET") {
    rejectNotFound(response);
    return;
  }
  if (requestUrl.pathname === SESSIONS_LIST_PATH) {
    writeListPage(response, requestUrl.searchParams);
    return;
  }
  if (requestUrl.pathname === SESSIONS_USAGE_PATH) {
    writeApiResult(response, usageFixture());
    return;
  }
  if (requestUrl.pathname === CONNECTED_AGENT_PATH) {
    // An org that HAS onboarded, so the list's empty state can only ever be a
    // filters/date result — never the onboarding ask, which renders no rows.
    writeApiResult(response, { hasConnectedAgent: true });
    return;
  }
  rejectNotFound(response);
}

/**
 * The list route's answer for one request: the real 400 above the ceiling, and
 * otherwise a page GENERATED from the requested window, so this stand-in cannot
 * stay green if the surface stops honoring `limit`/`offset`.
 */
function writeListPage(
  response: ServerResponse,
  params: URLSearchParams
): void {
  const offset = Number(params.get("offset") ?? "0");
  const limit = Number(params.get("limit") ?? String(PAGE_SIZE));
  if (offset > SESSION_LIST_MAX_OFFSET) {
    response.statusCode = 400;
    writeApiResult(response, {
      error: `offset must be at most ${SESSION_LIST_MAX_OFFSET}`,
    });
    return;
  }
  writeApiResult(response, listFixture(offset, limit));
}

function listFixture(offset: number, limit: number): AgentSessionListResponse {
  const size = Math.max(0, Math.min(limit, TOTAL_SESSIONS - offset));
  return {
    items: Array.from({ length: size }, (_, cursor) =>
      sessionRow(offset + cursor + 1)
    ),
    total: TOTAL_SESSIONS,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

/**
 * One synthetic cloud row, named by its one-based position in the population so
 * the rendered row states which WINDOW the read returned.
 *
 * Not `sessionListRow` from `e2e/helpers/sessions-list-fixtures.ts`, canonical
 * though it is: that module imports `./mock-users`, which takes a VALUE off an
 * extension-less `@repo/api` subpath, and one such import in a desktop e2e spec
 * aborts the entire suite at load time. The fields here are the type's required
 * set and nothing more.
 */
function sessionRow(position: number): AgentSessionListItem {
  const startedAt = new Date("2026-08-20T12:00:00.000Z");
  const endedAt = new Date("2026-08-20T12:30:00.000Z");
  return {
    agentCount: 1,
    awaitingInputSince: null,
    baseBranch: "main",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    computeTarget: {
      id: "compute-target-iss-9074",
      isOnline: true,
      lastSeenAt: endedAt,
      machineName: "MacBook Pro",
    },
    cwd: "/workspace/closedloop-ai",
    endedAt,
    errorCount: 0,
    estimatedCost: 0,
    externalSessionId: `external-iss-9074-${position}`,
    harness: "claude",
    id: `iss-9074-session-${position}`,
    inputTokens: 0,
    lastActivityAt: endedAt,
    model: "claude-opus-5",
    name: rowName(position),
    outputTokens: 0,
    project: null,
    repositoryFullName: "closedloop-ai/closedloop-ai",
    slug: `SES-9074-${position}`,
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
      email: "offset-cap-fixture@example.com",
      firstName: "Offset",
      id: AUTHENTICATED_USER_ID,
      lastName: "Fixture",
    },
    worktreePath: null,
  };
}

/**
 * The usage aggregate. Deliberately flat: this spec grades a PAGE COUNT, not a
 * number in a card, and every card reading a zero here still settles out of its
 * loading state — which is what keeps the strip from holding the view mid-mount.
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
        sessionCount: TOTAL_SESSIONS,
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
    totalSessions: TOTAL_SESSIONS,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}
