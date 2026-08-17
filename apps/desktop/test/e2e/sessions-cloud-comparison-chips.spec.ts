/**
 * ISS-6041, through a LAUNCHED Electron app — the desktop Sessions strip asks the
 * cloud producer for the prior-window comparison and chips what comes back.
 *
 * wongk review on #5023. The renderer suite
 * (`components/sessions/__tests__/sessions-view-summary-deltas.test.tsx`) mocks
 * the mode, the Labs gate and the page-data hook, so it pins the DECISION but
 * cannot fail for the two ways the wiring can actually break: a Labs toggle that
 * never reaches `useFeatureFlagEnabled` in the shipped renderer, and a Cloud-mode
 * read whose `comparison` opt-in is dropped somewhere between the combined
 * `pageData` filters and the URL that leaves the main process. The desktop UI
 * bug-fix rule wants the regression driven through a launched app, so this drives
 * it through the shipped auth restore, the shipped cloud IPC transport, the
 * shipped HTTP data source and the shipped summary cards.
 *
 * WHAT MAKES THE CHIP ASSERTION NON-VACUOUS. The stand-in below emits
 * `comparison` ONLY when the request carried `comparison=prior`. A build that
 * stopped sending the opt-in therefore renders no chip at all rather than the
 * same chip from a fixture that always answered — the delta text IS a read of the
 * request, not just of the response.
 *
 * The window is pinned to 30 days by clicking the toolbar rather than inherited
 * from `DEFAULT_DATE_RANGE`, because the caption under test is the cadence for
 * that window (`GROWTH_LABEL["30d"]`), and a spec must state the range it grades.
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
  type AgentSessionListResponse,
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session.ts";
import {
  AgentSessionComparisonMetric,
  AgentSessionComparisonMode,
} from "@repo/api/src/types/agent-session-usage-comparison.ts";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  launchAuthenticatedDesktopApp,
  routeDesktopSessionRefresh,
  seedAuthenticatedDesktopSession,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoNav,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  CARD_SELECTOR,
  MOUNT_TIMEOUT_MS,
  STRIP_SELECTOR,
} from "./helpers/summary-strip";

/**
 * Spelled as literals rather than imported. An extension-less `@repo/*` subpath
 * does not resolve under Playwright's ESM loader and a spec-level import failure
 * aborts the WHOLE desktop-e2e suite at load time (the constraint
 * `sessions-header-reorder-drag.spec.ts` documents), which rules out
 * `@repo/app/agents/...` and `@closedloop-ai/design-system/...`. Drift is caught first by
 * `apps/desktop/test/feature-flags.test.ts` and by the renderer delta suite.
 *
 * `GRID_TABLE_V2_FLAG_KEY` — `DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY`.
 * `SESSIONS_CARD_LABEL` — `SESSIONS_METRIC_CARD_LABEL`.
 * `DELTA_CHIP_TEST_ID` / `LABEL_TEXT_SLOT` — `MetricCard`'s two handles.
 * `NO_PRIOR_PERIOD` — `SUMMARY_NO_PRIOR_PERIOD`.
 * `MOM_CAPTION` — `GROWTH_LABEL["30d"]`, the cadence the flag turns the caption
 * over to.
 */
const GRID_TABLE_V2_FLAG_KEY = "grid-table-v2";
const SESSIONS_CARD_LABEL = "Sessions";
const DELTA_CHIP_TEST_ID = "metric-delta-chip";
const LABEL_TEXT_SLOT = '[data-slot="metric-card-label-text"]';
const NO_PRIOR_PERIOD = "No prior period";
const MOM_CAPTION = "MoM";

/**
 * The one movement the producer grades. Positive, so it is unambiguously a
 * MOVEMENT rather than the fabricated `0%` an absent entry must never become,
 * and emitted for `sessions` alone so every other card in the same strip
 * exercises the absent-entry placeholder in the same render.
 */
const SESSIONS_DELTA_PCT = 25;
/** `formatDeltaPct(25)` — the exact string the chip must read. */
const SESSIONS_DELTA_TEXT = "+25%";

const PROFILE_ID = "iss-6041-cloud-comparison-profile";
const SESSION_COUNT = 50;
/** Only this window's cadence caption is asserted; see the file docstring. */
const THIRTY_DAY_RANGE_LABEL = "Last 30 days";
const REQUEST_ORIGIN = "http://127.0.0.1";

type RecordedRequest = {
  authorization: string | null;
  method: string;
  url: string;
};

type SessionsCloudServer = {
  close: () => Promise<void>;
  origin: string;
  requests: RecordedRequest[];
};

test.describe("Sessions cloud period comparison (ISS-6041)", () => {
  test("asks the cloud producer for the prior window and chips the delta", async () => {
    test.setTimeout(240_000);

    // Empty CLAUDE_HOME/CODEX_HOME so the boot collectors ingest nothing and the
    // local store cannot contribute rows or totals of its own.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-6041-claude-")
    );
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-6041-codex-"));
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-6041-udd-"));
    const server = await startSessionsCloudServer();

    try {
      // Launch 1 — migrate the SQLite schema and encrypt a first-party session
      // the next launch restores through the production refresh lane. The schema
      // matters even though nothing is seeded into it: the summary cards' local
      // fallback read has to SETTLE (at zero) before they leave their loading
      // state, and a loading card renders no chip.
      const seedLaunch = await launchAuthenticatedDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataDir,
      });
      try {
        await seedAuthenticatedDesktopSession(seedLaunch.app, userDataDir);
        await waitForBranchesSchema(userDataDir);
      } finally {
        await seedLaunch.cleanup();
      }

      const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp(
        {
          // Signed in, online, and the upload backlog demonstrably drained — the
          // state `resolveCloudReadCutover` needs before Sessions reads the cloud.
          // Without it this surface stays on the local SQLite producer and the
          // comparison is correctly never requested.
          cloudReadReadiness: drainedCloudReadReadiness(),
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
                  name: "ISS-6041 Cloud Comparison E2E",
                  relayOrigin: "http://127.0.0.1:9",
                  webAppOrigin: "http://127.0.0.1:3000",
                },
              ],
            });
            // The chips ride the shared Grid Parity gate, closed by default.
            seedDesktopFeatureFlags(launchUserDataDir, {
              [GRID_TABLE_V2_FLAG_KEY]: true,
            });
          },
          env: {
            CLAUDE_HOME: claudeHome,
            CL_AUTH_API_ORIGIN: server.origin,
            CODEX_HOME: codexHome,
          },
          userDataDir,
        }
      );

      try {
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
        // `:visible` scopes to the Sessions toolbar — keep-alive views stay
        // mounted-but-hidden and render the same control.
        await page
          .locator(`[aria-label="${THIRTY_DAY_RANGE_LABEL}"]:visible`)
          .click();

        const chip = sessionsCardDeltaChip(page);
        await expect(chip).toHaveText(SESSIONS_DELTA_TEXT, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        // The caption names the cadence of the window the chip grades, which is
        // the half of the comparison the Grid Parity gate turns on beside the
        // `PRs Shipped` chip.
        await expect(sessionsCard(page)).toContainText(MOM_CAPTION);
        // The producer graded one card only, so the rest must show the
        // placeholder rather than a fabricated `0%`.
        await expect(
          strip(page).getByText(NO_PRIOR_PERIOD).first()
        ).toBeVisible();

        const comparisonReads = usageRequests(server.requests).filter(
          (request) =>
            searchParams(request).get("comparison") ===
            AgentSessionComparisonMode.Prior
        );
        expect(
          comparisonReads.length,
          "the Cloud-mode Sessions read never asked for the prior window"
        ).toBeGreaterThanOrEqual(1);
        // The usage route shares the base schema, so a paginated or sorted
        // combined read must not leak the list's own fields into it — those
        // cannot move the aggregate and its prior window.
        expect(
          comparisonReads.flatMap((request) =>
            [...searchParams(request).keys()].filter((key) =>
              USAGE_STRIPPED_KEYS.has(key)
            )
          )
        ).toEqual([]);
        expect(
          comparisonReads
            .filter(
              (request) =>
                request.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
            )
            .map((request) => request.url)
        ).toEqual([]);
        // The list route's schema is `.strict()` and answers 400 for the
        // usage-only opt-in, which would cost the whole page, not just the chips.
        expect(
          listRequests(server.requests).filter((request) =>
            searchParams(request).has("comparison")
          )
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

/**
 * `USAGE_STRIPPED_FILTER_KEYS` (`@repo/app/agents/data-source/
 * agent-sessions-data-source`), minus the two the desktop shell never puts on a
 * cloud URL in the first place (`countOnly`, `search`). Restated as literals for
 * the same loader reason as the constants above; the unit twin
 * (`usage-query-contract.test.ts`) imports the real set.
 */
const USAGE_STRIPPED_KEYS = new Set(["limit", "offset", "sortBy", "sortDir"]);

function strip(page: Page): Locator {
  return page.locator(STRIP_SELECTOR).locator("visible=true").first();
}

/**
 * The Sessions card inside the visible strip. Addressed through the label's own
 * slot rather than by text: "Sessions" is also the sidebar destination and the
 * breadcrumb, and the keep-alive views render a second hidden copy of the strip.
 */
function sessionsCard(page: Page): Locator {
  return strip(page)
    .locator(CARD_SELECTOR)
    .filter({
      has: page.locator(LABEL_TEXT_SLOT, {
        hasText: new RegExp(`^${SESSIONS_CARD_LABEL}$`),
      }),
    });
}

function sessionsCardDeltaChip(page: Page): Locator {
  return sessionsCard(page).getByTestId(DELTA_CHIP_TEST_ID);
}

function searchParams(request: RecordedRequest): URLSearchParams {
  return new URL(request.url, REQUEST_ORIGIN).searchParams;
}

function usageRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter(
    (request) =>
      new URL(request.url, REQUEST_ORIGIN).pathname === "/agent-sessions/usage"
  );
}

function listRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter(
    (request) =>
      new URL(request.url, REQUEST_ORIGIN).pathname === "/agent-sessions"
  );
}

/**
 * A bounded stand-in for the authenticated cloud Sessions routes.
 *
 * Deliberately NOT folded into `startAuthenticatedBranchCloudServer`: that
 * fixture owns the Branch payloads, and the ONE thing both need — minting the
 * first-party session — is delegated to its exported
 * {@link routeDesktopSessionRefresh} rather than copied.
 */
async function startSessionsCloudServer(): Promise<SessionsCloudServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization ?? null,
      method: request.method ?? "GET",
      url: request.url ?? "/",
    });
    routeSessionsRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The Sessions cloud stand-in did not bind.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function routeSessionsRequest(
  request: IncomingMessage,
  response: ServerResponse
): void {
  if (routeDesktopSessionRefresh(request, response)) {
    return;
  }
  const requestUrl = new URL(request.url ?? "/", REQUEST_ORIGIN);
  if (request.method !== "GET") {
    writeNotFound(response);
    return;
  }
  if (requestUrl.pathname === "/agent-sessions/usage") {
    writeApiResult(
      response,
      usageFixture(
        requestUrl.searchParams.get("comparison") ===
          AgentSessionComparisonMode.Prior
      )
    );
    return;
  }
  if (requestUrl.pathname === "/agent-sessions") {
    writeApiResult(response, listFixture());
    return;
  }
  if (requestUrl.pathname === "/compute-targets/has-connected-agent") {
    writeApiResult(response, { hasConnectedAgent: true });
    return;
  }
  writeNotFound(response);
}

/**
 * The usage aggregate, carrying the producer's comparison ONLY when it was asked
 * for — see the file docstring for why that conditional is what makes the chip
 * assertion a read of the REQUEST.
 */
function usageFixture(compared: boolean): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 412,
    byHarness: [],
    byModel: [],
    // One entry so the Repository facet needs no analytics fallback read, which
    // this stand-in deliberately does not serve.
    byRepository: [
      {
        errorCount: 0,
        estimatedCost: 412,
        inputTokens: 480_000,
        outputTokens: 120_000,
        repositoryFullName: "acme/web",
        sessionCount: SESSION_COUNT,
      },
    ],
    byUser: [],
    ...(compared
      ? {
          comparison: {
            deltas: {
              [AgentSessionComparisonMetric.Sessions]: SESSIONS_DELTA_PCT,
            },
            priorEndDate: "2026-07-13T23:59:59.999Z",
            priorStartDate: "2026-06-14T00:00:00.000Z",
          },
        }
      : {}),
    earliestSessionAt: null,
    lastSyncTargets: [],
    latestSessionAt: null,
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 412,
    totalInputTokens: 480_000,
    totalOutputTokens: 120_000,
    totalSessions: SESSION_COUNT,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

/**
 * An empty page. The rows are not this spec's subject and an empty list still
 * SETTLES the combined read, which is what the summary cards gate their loading
 * state on.
 */
function listFixture(): AgentSessionListResponse {
  return {
    items: [],
    total: SESSION_COUNT,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

function writeApiResult(response: ServerResponse, data: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ data, success: true }));
}

function writeNotFound(response: ServerResponse): void {
  response.statusCode = 404;
  writeApiResult(response, { error: "not found" });
}
