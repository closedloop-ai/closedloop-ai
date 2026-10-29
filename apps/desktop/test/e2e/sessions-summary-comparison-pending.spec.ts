/**
 * The Sessions summary delta slot, through a LAUNCHED Electron app: the two
 * states that must not borrow "No prior period" — ISS-7422's read still in
 * flight, and ISS-7525's read that landed and declined to grade.
 *
 * ISS-7422, below first — a Sessions summary whose comparison is still being
 * read must say so, not print the settled verdict "No prior period".
 *
 * whitlockk review on #5592. The renderer suites this PR ships call
 * `useSessionComparisonSuppressed` and `isSessionComparisonPending` directly and
 * mock the read state they grade, so they pin the DECISION but cannot fail for
 * the two ways the shipped renderer actually breaks: a flag verdict that never
 * reaches `useFeatureFlagEnabled` in the renderer (which resolves every key
 * from the signed-in account's PostHog assignment over the IPC bridge and fails
 * closed on one that is missing), and a host that resolves the gate but never
 * threads it into the suppression hook. `apps/desktop/AGENTS.md` ("UI bug fix ⇒
 * regression e2e") wants the regression driven through the launched app, so
 * this drives it through the shipped auth restore, the shipped cloud IPC
 * transport, the shipped HTTP data source, the real react-query cache with its
 * `keepPreviousData`, and the real mounted `SessionsSummaryCards`.
 *
 * THE STATE UNDER TEST is a genuine summary-SCOPE change with the response held:
 * switching the range from the default window to `Last 30 days` churns the
 * combined `pageData` key, `keepPreviousData` leaves the PREVIOUS window's
 * figures and its comparison on screen, and
 * `useSessionComparisonSuppressed` correctly refuses to keep chipping them
 * against a window they no longer describe. What the slot says during that
 * window is the whole ticket: flag-off it claims the prior period does not
 * exist; flag-on it says the comparison is still loading.
 *
 * WHAT MAKES THE COUNTERFACTUAL STRUCTURAL. Both arms run the SAME stand-in
 * producer, the SAME range change and the SAME held response, and differ in ONE
 * input: the seeded flag verdict. The OFF arm therefore executes the pre-fix
 * predicate and asserts the defect verbatim, so the fix cannot be reverted
 * without turning the ON arm red — there is no separate reverted run to keep in
 * step with this file.
 *
 * WHAT MAKES THE ASSERTIONS NON-VACUOUS. The stand-in emits `comparison` ONLY
 * when the request carried `comparison=prior`, so a build that dropped the
 * opt-in renders no chip at all rather than the same chip from a fixture that
 * always answered. And every absence asserted mid-flight is asserted on a
 * locator that matches in the same arm before the hold and again after the
 * release, so a selector that quietly stopped matching cannot make it pass.
 */

import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
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
import { SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/sessions-summary-honest-loading-flag.ts";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
  routeDesktopSessionRefresh,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoNav,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  CARD_SELECTOR,
  MOUNT_TIMEOUT_MS,
  STRIP_SELECTOR,
} from "./helpers/summary-strip";

/**
 * Spelled as literals rather than imported. An extension-less `@repo/*` subpath
 * does not resolve under Playwright's ESM loader and a spec-level import failure
 * aborts the WHOLE desktop-e2e suite at load time, which rules out
 * `@repo/app/agents/...` and `@closedloop-ai/design-system/...`. The `@repo/api` imports
 * above are fine because they carry an explicit `.ts` extension — which is also
 * why the honest-loading flag key is the REAL constant here rather than a fourth
 * copy of its string.
 *
 * `SESSIONS_CARD_LABEL` — `SESSIONS_METRIC_CARD_LABEL`.
 * `DELTA_CHIP_TEST_ID` / `LABEL_TEXT_SLOT` — `MetricCard`'s two handles.
 * `NO_PRIOR_PERIOD` — `SUMMARY_NO_PRIOR_PERIOD`'s sentence.
 * `COMPARISON_PENDING_LABEL` — `SUMMARY_COMPARISON_PENDING_LABEL`, the
 * accessible name ISS-7422 gives the pending slot. Drift in any of these is
 * caught first by `apps/desktop/test/feature-flags.test.ts` and the renderer
 * delta suites.
 */
const SESSIONS_CARD_LABEL = "Sessions";
const DELTA_CHIP_TEST_ID = "metric-delta-chip";
const LABEL_TEXT_SLOT = '[data-slot="metric-card-label-text"]';
const NO_PRIOR_PERIOD = "No prior period";
const COMPARISON_PENDING_LABEL = "Comparison loading";
/**
 * ISS-7525 — `SUMMARY_COMPARISON_DECLINED`'s sentence, which is
 * `NO_COMPARISON_CHIP_LABEL`. Spelled as a literal for the same reason the rest
 * of this block is, and with the same consequence: a spec states the rendered
 * words it grades rather than importing them from the module that produces them.
 */
const COMPARISON_DECLINED = "No comparison";

/**
 * The one movement the stand-in producer grades. Positive so it is
 * unambiguously a MOVEMENT rather than the fabricated `0%` an absent entry must
 * never become, and emitted for `sessions` alone so the assertions name one
 * card.
 */
const SESSIONS_DELTA_PCT = 25;
/** `formatDeltaPct(25)` — the exact string the chip must read. */
const SESSIONS_DELTA_TEXT = "+25%";

const SESSION_COUNT = 50;
/** The window the arm switches TO, which is what churns the summary scope. */
const THIRTY_DAY_RANGE_LABEL = "Last 30 days";
const REQUEST_ORIGIN = "http://127.0.0.1";
const ARM_TIMEOUT_MS = 240_000;

type SessionsCloudServer = {
  close: () => Promise<void>;
  /** Park every SUBSEQUENT usage response instead of answering it. */
  holdUsage: () => void;
  /** How many usage responses are parked right now. */
  heldUsageCount: () => number;
  origin: string;
  /** Answer everything parked, and stop parking. */
  releaseUsage: () => void;
  /** Did any usage read carry the `comparison=prior` opt-in? */
  sawComparisonOptIn: () => boolean;
  /**
   * ISS-7525: does the comparison this producer emits GRADE the Sessions
   * metric?
   *
   * OFF, every response still carries the `comparison` object — window bounds
   * and all — with an EMPTY `deltas` map. That is the wire shape of a prior
   * window the producer measured and declined to state a ratio over, and it is
   * the only thing that separates it from a response that carried no comparison
   * at all. Toggled rather than fixed per launch so one arm can prove the chip
   * locator is live on the very card it just asserted a chip absent from.
   */
  setComparisonGraded: (graded: boolean) => void;
};

test.describe("Sessions summary comparison pending state (ISS-7422)", () => {
  test("flag on, a scope change says the comparison is loading", async () => {
    test.setTimeout(ARM_TIMEOUT_MS);

    await withHeldScopeChange(
      { honestLoadingEnabled: true, slug: "iss-7422-on" },
      async ({ page, server }) => {
        const card = sessionsCard(page);

        // The fix: the slot names the STATE it is in. `role="status"` is the
        // half that carries it to assistive tech — the shimmer beside it is
        // `aria-hidden`, so without this the state would exist in colour alone.
        await expect(card.getByRole("status")).toContainText(
          COMPARISON_PENDING_LABEL,
          { timeout: MOUNT_TIMEOUT_MS }
        );
        // And it does NOT publish the settled verdict it has not received.
        await expect(card).not.toContainText(NO_PRIOR_PERIOD);
        await expect(sessionsCardDeltaChip(page)).toHaveCount(0);

        // Positive control on the same locators: the held read lands, the
        // pending state clears and the chip for the NEW window arrives.
        server.releaseUsage();
        await expect(sessionsCardDeltaChip(page)).toHaveText(
          SESSIONS_DELTA_TEXT,
          { timeout: MOUNT_TIMEOUT_MS }
        );
        await expect(card.getByRole("status")).toHaveCount(0);
      }
    );
  });

  test("flag off, a scope change still claims there is no prior period", async () => {
    test.setTimeout(ARM_TIMEOUT_MS);

    await withHeldScopeChange(
      { honestLoadingEnabled: false, slug: "iss-7422-off" },
      async ({ page, server }) => {
        const card = sessionsCard(page);

        // The pre-fix predicate, executed. This arm is what makes the one above
        // a regression test rather than a screenshot of today's behavior.
        await expect(card).toContainText(NO_PRIOR_PERIOD, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(card.getByRole("status")).toHaveCount(0);
        await expect(sessionsCardDeltaChip(page)).toHaveCount(0);

        server.releaseUsage();
        await expect(sessionsCardDeltaChip(page)).toHaveText(
          SESSIONS_DELTA_TEXT,
          { timeout: MOUNT_TIMEOUT_MS }
        );
      }
    );
  });
});

/**
 * ISS-7525, through the same LAUNCHED Electron app — a comparison the producer
 * MEASURED and declined to grade must not be printed as a prior period that
 * never existed.
 *
 * whitlockk review on #6740. The shared render suite this PR ships
 * (`packages/app/agents/components/sessions/__tests__/
 * sessions-summary-comparison-declined.test.tsx`) mounts `SessionsSummaryCards`
 * directly, calls `buildSessionSummaryDeltas` itself, and answers the flag from
 * `AppCoreStoryProviders`' static adapter. It therefore cannot fail for any of
 * the three ways the shipped desktop renderer actually breaks: a flag verdict
 * that never reaches `useFeatureFlagEnabled` in the renderer (which resolves
 * every key from the signed-in account's PostHog assignment over the IPC
 * bridge), `resolveSessionSummaryDeltas`' own `enabled` gate dropping the delta
 * object before the strip ever sees it, or the HTTP data source not carrying
 * `comparison` through to the component — the one field
 * `priorPeriodMeasured` is derived from.
 *
 * THE STATE UNDER TEST is a SETTLED read, which is what separates it from the
 * pending arms above: the response has landed, it carries the prior window's
 * bounds, and it states no ratio for Sessions. Flag-off the slot claims the
 * prior period does not exist; flag-on it says the comparison was declined.
 *
 * WHAT MAKES THE COUNTERFACTUAL STRUCTURAL. Both arms run the SAME ungraded
 * producer and differ in ONE input, the seeded flag verdict. Reverting either
 * half of the repair — `priorPeriodMeasured` in `buildSessionSummaryDeltas`, or
 * the branch that reads it in `honestSummaryDeltaPlaceholder` — puts the
 * flag-ON arm back on "No prior period" and turns it red.
 *
 * WHAT MAKES THE ASSERTIONS NON-VACUOUS. The card is asserted to CONTAIN its
 * sentence before anything is asserted absent from it, so a selector that
 * stopped matching cannot pass by resolving to nothing. The chip's absence gets
 * its own positive control: the producer is switched to grading, the range is
 * changed, and the chip arrives on the SAME locator. And the comparison opt-in
 * is read off the server, so an arm whose request dropped `comparison=prior`
 * fails naming that rather than quietly grading a payload nobody asked for.
 */
test.describe("Sessions summary comparison declined state (ISS-7525)", () => {
  test("flag on, a measured but ungraded comparison says the comparison was declined", async () => {
    test.setTimeout(ARM_TIMEOUT_MS);

    await withLaunchedSessionsApp(
      { graded: false, honestLoadingEnabled: true, slug: "iss-7525-on" },
      async ({ page, server }) => {
        const card = sessionsCard(page);

        // The fix. A prior window rode this response, carrying the dates it was
        // measured over, so the slot names what actually happened.
        await expect(card).toContainText(COMPARISON_DECLINED, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        // And it does NOT deny a prior period the payload is carrying.
        await expect(card).not.toContainText(NO_PRIOR_PERIOD);
        // Nor fabricate a movement out of a ratio the producer refused to state.
        await expect(sessionsCardDeltaChip(page)).toHaveCount(0);
        expect(
          server.sawComparisonOptIn(),
          "the Cloud-mode Sessions read never asked for the prior window, so the declined slot above proves nothing about the response"
        ).toBe(true);

        // Positive control on the SAME chip locator: let the producer grade the
        // next read and change the window, and the chip arrives — so the
        // absence above is a real state and not a selector matching nothing.
        server.setComparisonGraded(true);
        await page
          .locator(`[aria-label="${THIRTY_DAY_RANGE_LABEL}"]:visible`)
          .click();
        await expect(sessionsCardDeltaChip(page)).toHaveText(
          SESSIONS_DELTA_TEXT,
          { timeout: MOUNT_TIMEOUT_MS }
        );
      }
    );
  });

  test("flag off, the same measured but ungraded comparison still claims there is no prior period", async () => {
    test.setTimeout(ARM_TIMEOUT_MS);

    await withLaunchedSessionsApp(
      { graded: false, honestLoadingEnabled: false, slug: "iss-7525-off" },
      async ({ page, server }) => {
        const card = sessionsCard(page);

        // The pre-fix wording, executed. This arm is what makes the one above a
        // regression test rather than a screenshot of today's behavior, and it
        // is also the shipped closed default this ticket must not have moved.
        await expect(card).toContainText(NO_PRIOR_PERIOD, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(card).not.toContainText(COMPARISON_DECLINED);
        await expect(sessionsCardDeltaChip(page)).toHaveCount(0);
        expect(
          server.sawComparisonOptIn(),
          "the Cloud-mode Sessions read never asked for the prior window, so this arm is not grading the same payload as the one above"
        ).toBe(true);
      }
    );
  });
});

/**
 * Drive one arm to the HELD scope change and hand it to `assert`.
 *
 * Everything up to the callback is identical across arms except the seeded
 * flag verdict — that is what makes the counterfactual structural rather than
 * two specs that happen to resemble each other.
 */
async function withHeldScopeChange(
  {
    honestLoadingEnabled,
    slug,
  }: { honestLoadingEnabled: boolean; slug: string },
  assert: (context: {
    page: Page;
    server: SessionsCloudServer;
  }) => Promise<void>
): Promise<void> {
  await withLaunchedSessionsApp(
    { honestLoadingEnabled, slug },
    async ({ page, server }) => {
      // The settled starting point: a real comparison, on screen, for the
      // window currently selected. Without this the range change below would
      // not be a change FROM a held comparison, and neither arm would be
      // grading what the ticket is about.
      await expect(sessionsCardDeltaChip(page)).toHaveText(
        SESSIONS_DELTA_TEXT,
        { timeout: MOUNT_TIMEOUT_MS }
      );
      expect(
        server.sawComparisonOptIn(),
        "the Cloud-mode Sessions read never asked for the prior window, so the chip above proves nothing about the request"
      ).toBe(true);

      // Now hold the producer and change the summary scope. The combined read
      // for the new window never settles, so the strip sits in exactly the
      // state this ticket is about for as long as the assertions need.
      server.holdUsage();
      // `:visible` scopes to the Sessions toolbar — keep-alive views stay
      // mounted-but-hidden and render the same control.
      await page
        .locator(`[aria-label="${THIRTY_DAY_RANGE_LABEL}"]:visible`)
        .click();
      await expect.poll(() => server.heldUsageCount()).toBeGreaterThan(0);

      await assert({ page, server });
    }
  );
}

/**
 * Launch the shipped app against the stand-in producer, sign it in, open
 * Sessions, and hand the settled page to `body`.
 *
 * Extracted from {@link withHeldScopeChange} when ISS-7525 added a second state
 * to this file rather than copied beside it: every line here is launch
 * boilerplate whose only per-arm inputs are the seeded flag verdict, the
 * temp-dir slug and (ISS-7525) whether the producer grades its comparison. Two
 * copies of it is how the two states come to differ in something nobody chose.
 */
async function withLaunchedSessionsApp(
  {
    graded = true,
    honestLoadingEnabled,
    slug,
  }: { graded?: boolean; honestLoadingEnabled: boolean; slug: string },
  body: (context: { page: Page; server: SessionsCloudServer }) => Promise<void>
): Promise<void> {
  // Empty CLAUDE_HOME/CODEX_HOME so the boot collectors ingest nothing and the
  // local store cannot contribute rows or totals of its own.
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), `${slug}-claude-`));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${slug}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${slug}-udd-`));
  const server = await startSessionsCloudServer();
  server.setComparisonGraded(graded);

  try {
    // Close the production-migrated DB before the unchanged schema barrier.
    await initializeDesktopProfileSchema(userDataDir);
    await waitForBranchesSchema(userDataDir);

    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          activeConfigId: slug,
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: slug,
              name: "Sessions summary comparison E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
        });
        // Grid Parity is what makes this surface compare periods at ALL
        // (`isSessionComparisonEnabled`), so it is on in both arms — the ONE
        // bit that differs between them is the honest-loading toggle beside it.
        seedDesktopFeatureFlags(launchUserDataDir, {
          [SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY]: honestLoadingEnabled,
        });
      },
      env: {
        CLAUDE_HOME: claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: codexHome,
      },
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      userDataDir,
    });

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

      await body({ page, server });
      expect(pageErrors).toEqual([]);
    } finally {
      // Order matters, and it cost a debugging session to find out. The stand-in
      // holds a live socket to the Electron MAIN process; leaving it open across
      // the app teardown let a SIGKILLed app orphan helper processes that still
      // held the launcher's pipes, so the WORKER's event loop never went quiet
      // and Playwright failed the whole run on "Worker teardown timeout" with
      // every test already green. Releasing and closing the producer FIRST means
      // the app is torn down with nothing of the worker's still attached to it.
      server.releaseUsage();
      await server.close();
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}

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

/**
 * A bounded stand-in for the authenticated cloud Sessions routes, with a hold on
 * the usage half.
 *
 * The hold is why this cannot reuse `sessions-cloud-comparison-chips.spec.ts`'s
 * server: that fixture answers every read immediately, which is the one thing
 * this spec must be able to not do. Minting the first-party session is still
 * delegated to the shared {@link routeDesktopSessionRefresh} rather than copied.
 */
async function startSessionsCloudServer(): Promise<SessionsCloudServer> {
  let holding = false;
  let comparisonOptIn = false;
  // ISS-7525: graded by default, so the two ISS-7422 arms above are untouched.
  let graded = true;
  const held: (() => void)[] = [];

  // The handler is incapable of throwing OUT of the server: a rejection here
  // would be an unhandled one that kills the test process with a message about
  // the socket rather than about the assertion that was waiting.
  const server = createServer((request, response) => {
    Promise.resolve(routeSessionsRequest(request, response)).catch(() => {
      response.destroy();
    });
  });

  /**
   * Every live socket, so {@link SessionsCloudServer.close} can end them.
   *
   * `server.close()` alone stops new connections and then waits for the open
   * ones, and the desktop client keeps its HTTP agent's sockets ALIVE — so the
   * close never resolved, the worker's event loop stayed awake, and Playwright
   * failed the whole run on "Worker teardown timeout" AFTER both tests had
   * passed. Observed on the first run of this spec; a spec that leaks its
   * fixture reds the lane just as hard as a failing assertion.
   */
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  function routeSessionsRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> | void {
    if (routeDesktopSessionRefresh(request, response)) {
      return;
    }
    const requestUrl = new URL(request.url ?? "/", REQUEST_ORIGIN);
    if (request.method !== "GET") {
      writeNotFound(response);
      return;
    }
    if (requestUrl.pathname === "/agent-sessions/usage") {
      const compared =
        requestUrl.searchParams.get("comparison") ===
        AgentSessionComparisonMode.Prior;
      comparisonOptIn = comparisonOptIn || compared;
      return answerUsage(response, compared);
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

  async function answerUsage(
    response: ServerResponse,
    compared: boolean
  ): Promise<void> {
    if (holding) {
      await new Promise<void>((resolve) => {
        held.push(resolve);
      });
    }
    writeApiResult(response, usageFixture(compared, graded));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // A listening server is a ref'd handle, so on its own it keeps the Playwright
  // WORKER's event loop awake after the last test and the run dies on "Worker
  // teardown timeout" with every test already green. Unref'd it still serves
  // normally — the worker's own IPC channel is what holds the loop open while
  // tests are running — it just stops being a reason not to exit.
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The Sessions cloud stand-in did not bind.");
  }
  return {
    heldUsageCount: () => held.length,
    holdUsage: () => {
      holding = true;
    },
    origin: `http://127.0.0.1:${address.port}`,
    releaseUsage: () => {
      holding = false;
      for (const resolve of held.splice(0)) {
        resolve();
      }
    },
    sawComparisonOptIn: () => comparisonOptIn,
    setComparisonGraded: (next: boolean) => {
      graded = next;
    },
    // Idempotent: the caller closes once in the inner teardown (so nothing of
    // the worker's is attached to the app when it goes down) and once in the
    // outer one, which is what still runs when the launch itself threw.
    close: () =>
      new Promise<void>((resolve, rejectClose) => {
        for (const socket of sockets.values()) {
          socket.destroy();
        }
        sockets.clear();
        if (!server.listening) {
          resolve();
          return;
        }
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

/**
 * The usage aggregate, carrying the producer's comparison ONLY when it was asked
 * for — see the file docstring for why that conditional is what makes the chip
 * assertion a read of the REQUEST.
 */
function usageFixture(
  compared: boolean,
  graded: boolean
): AgentSessionUsageSummary {
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
    // ISS-7525: the two axes are independent and the pair is the whole point.
    // `compared` decides whether a comparison rode the response AT ALL; `graded`
    // decides whether that comparison stated a ratio. An ungraded one still
    // carries the window it was measured over, which is the evidence a prior
    // period exists — so the empty map below is "we did not compute this", never
    // "there was nothing to compute".
    ...(compared
      ? {
          comparison: {
            deltas: graded
              ? { [AgentSessionComparisonMetric.Sessions]: SESSIONS_DELTA_PCT }
              : {},
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
