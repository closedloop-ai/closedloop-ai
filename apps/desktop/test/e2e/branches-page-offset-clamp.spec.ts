/**
 * E2E regression (ISS-10434): a hand-edited `?page=` far past what the server
 * can page through must not strand the desktop cloud Branches list in error.
 *
 * `buildBranchServerPageFilters` (`packages/app/branches/lib/branch-server-page-query.ts`)
 * clamps `page` to `resolveMaxPageIndex(BRANCH_LIST_MAX_OFFSET, pageSize)`
 * before multiplying by `pageSize`. Before that clamp, a safe-integer page
 * index past `MAX_SAFE_INTEGER / pageSize` produced an offset past
 * `Number.MAX_SAFE_INTEGER`, which the real `/branches` route rejects
 * (`branchListQuerySchema`'s `offset: z.coerce.number().int().min(0).max(BRANCH_LIST_MAX_OFFSET)`).
 * A rejected list read is a stuck "Couldn't load branches" — this spec proves
 * the clamp keeps every offset the desktop cloud host sends inside that bound,
 * and that the surface still renders the served page and repairs its `page`
 * state instead of clinging to the huge deep-linked index
 * (`apps/desktop/src/renderer/components/branches/branches-view.tsx`'s
 * `data.pageInfo.offset / data.pageInfo.limit` repair effect).
 *
 * The fake cloud server below mirrors the real route's offset bound (reject
 * unsafe/out-of-range offsets with the same 400 the route would send) and
 * reuses the REAL `repairOffset` the route's own page builder calls
 * (`packages/lib/branches/branch-list-page.ts`), so a served `pageInfo.offset`
 * here is the same value production would serve for a 3-row corpus.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
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
  type BranchAnalytics,
  BranchKpiState,
  type BranchListResponse,
  type BranchRow,
  BranchStatus,
  BranchViewerScope,
} from "../../../../packages/api/src/types/branch";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "../../../../packages/api/src/types/branch-identity";
import {
  BRANCH_LIST_MAX_OFFSET,
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS,
  BranchListCapability,
  type BranchListServerPageSize,
  isBranchListServerPageSize,
} from "../../../../packages/api/src/types/branch-list-contract";
import { ReadSource } from "../../../../packages/api/src/types/read-source";
import {
  repairOffset,
  resolveMaxPageIndex,
} from "../../../../packages/api/src/utils/math";
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
  closeServer,
  emptyBranchListFacets,
  unavailableKpi,
  writeJson,
} from "./helpers/branches-cloud-fixture";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const PROFILE_ID = "branches-page-offset-clamp-e2e-profile";
/**
 * A 1-based `?page=` whose unclamped offset overflows `Number.MAX_SAFE_INTEGER`
 * at EVERY server page size. Derived from the smallest allowed size, so the
 * spec stays load-bearing whichever size the desktop host resolves.
 */
const OVER_CAP_PAGE_INDEX =
  resolveMaxPageIndex(
    BRANCH_LIST_MAX_OFFSET,
    Math.min(...BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS)
  ) + 1_000_000;
const HAND_EDITED_PAGE_PARAM = String(OVER_CAP_PAGE_INDEX + 1);
const NOW_ISO = new Date().toISOString();

const FIXTURE_BRANCHES: BranchRow[] = [0, 1, 2].map((index) =>
  makeOffsetClampBranch(index)
);

test("a deep-linked page far past the server offset cap still renders the served page", async () => {
  test.setTimeout(180_000);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-offset-clamp-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-offset-clamp-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-offset-clamp-udd-")
  );
  const server = await startOffsetClampCloudApiServer();

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      cloudReadReadiness: drainedCloudReadReadiness(),
      userDataDir,
      env: {
        CLAUDE_HOME: claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: codexHome,
      },
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
              name: "Branches Offset Clamp E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
        });
      },
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

      await gotoHash(page, `/branches?page=${HAND_EDITED_PAGE_PARAM}`);

      await expect(
        page.locator("header").getByText("Branches", { exact: true })
      ).toBeVisible({ timeout: 30_000 });

      // The rows render — the deep link never lands the surface in the
      // rejected-offset error state.
      for (const row of FIXTURE_BRANCHES) {
        await expect(page.getByText(row.branchName)).toBeVisible({
          timeout: 30_000,
        });
      }
      await expect(
        page.getByText("Couldn't load branches", { exact: true })
      ).toHaveCount(0);

      // The pagination readout reflects the SERVED page (0), not the
      // deep-linked one — this can only render correctly once the host's
      // repair effect has replaced the huge page index in state.
      await expect(
        page.getByText(
          `1–${FIXTURE_BRANCHES.length} of ${FIXTURE_BRANCHES.length}`,
          {
            exact: true,
          }
        )
      ).toBeVisible({ timeout: 30_000 });

      // The repair effect also writes the corrected page back to the URL
      // (`serverControls.setPage` -> `writeBranchPageParam`), which deletes
      // the `page` param entirely for page 0 — the huge deep-linked value
      // does not linger in the address bar once the page has settled.
      await expect
        .poll(() => page.evaluate(() => globalThis.location.hash))
        .not.toContain("page=");

      // Every offset the desktop host actually sent the server stayed inside
      // the bound the real route enforces — proving the CLIENT-side clamp,
      // not just that the mock happened to accept whatever arrived.
      expect(server.rejectedOffsets).toEqual([]);
      expect(server.acceptedOffsets.length).toBeGreaterThan(0);
      for (const offset of server.acceptedOffsets) {
        expect(Number.isSafeInteger(offset)).toBe(true);
        expect(offset).toBeLessThanOrEqual(BRANCH_LIST_MAX_OFFSET);
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(claudeHome, { recursive: true, force: true });
  }
});

type OffsetClampCloudApiServer = {
  origin: string;
  /** Every offset the server accepted, in request order — side effect only. */
  acceptedOffsets: number[];
  /** Every offset the server 400-rejected, in request order — side effect only. */
  rejectedOffsets: number[];
  close: () => Promise<void>;
};

async function startOffsetClampCloudApiServer(): Promise<OffsetClampCloudApiServer> {
  const acceptedOffsets: number[] = [];
  const rejectedOffsets: number[] = [];
  const server = createServer((request, response) => {
    try {
      routeOffsetClampRequest(
        request,
        response,
        acceptedOffsets,
        rejectedOffsets
      );
    } catch (error) {
      response.statusCode = 500;
      writeErrorJson(response, {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(
      "Offset clamp cloud API server did not bind to a TCP port."
    );
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    acceptedOffsets,
    rejectedOffsets,
    close: () => closeServer(server),
  };
}

function routeOffsetClampRequest(
  request: IncomingMessage,
  response: ServerResponse,
  acceptedOffsets: number[],
  rejectedOffsets: number[]
): void {
  if (routeDesktopSessionRefresh(request, response)) {
    return;
  }
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && requestUrl.pathname === "/branches") {
    routeOffsetClampListRequest(
      requestUrl,
      response,
      acceptedOffsets,
      rejectedOffsets
    );
    return;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/branches/analytics"
  ) {
    writeJson(response, offsetClampAnalyticsResponse());
    return;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/integrations/github/repositories"
  ) {
    writeJson(response, []);
    return;
  }
  response.statusCode = 404;
  writeErrorJson(response, { error: "not found" });
}

/**
 * Mirrors the real route's rejection: `branchListQuerySchema` bounds `offset`
 * at `BRANCH_LIST_MAX_OFFSET` via `z.coerce.number().int().min(0).max(...)`
 * (`apps/api/app/branches/branch-list-query.ts`), so an offset that overflowed
 * past a safe integer on its way here 400s before any row is read.
 */
function routeOffsetClampListRequest(
  requestUrl: URL,
  response: ServerResponse,
  acceptedOffsets: number[],
  rejectedOffsets: number[]
): void {
  const requestedOffset = Number(requestUrl.searchParams.get("offset") ?? "0");
  const requestedLimit = Number(
    requestUrl.searchParams.get("limit") ?? String(BRANCH_LIST_SERVER_PAGE_SIZE)
  );
  const offsetInBounds =
    Number.isSafeInteger(requestedOffset) &&
    requestedOffset >= 0 &&
    requestedOffset <= BRANCH_LIST_MAX_OFFSET;
  if (!offsetInBounds) {
    rejectedOffsets.push(requestedOffset);
    response.statusCode = 400;
    writeErrorJson(response, {
      error: `offset: Number must be less than or equal to ${BRANCH_LIST_MAX_OFFSET}`,
    });
    return;
  }
  acceptedOffsets.push(requestedOffset);
  const limit = isBranchListServerPageSize(requestedLimit)
    ? requestedLimit
    : BRANCH_LIST_SERVER_PAGE_SIZE;
  writeJson(response, offsetClampListResponse(requestedOffset, limit));
}

/**
 * Repairs the requested offset against the fixture's own population with the
 * SAME `repairOffset` the production route's page builder calls
 * (`buildBranchServerPageSnapshot` in `packages/lib/branches/branch-list-page.ts`),
 * so the served `pageInfo.offset` is the real last-servable page for a 3-row
 * corpus — not a value this spec invented.
 */
function offsetClampListResponse(
  requestedOffset: number,
  limit: BranchListServerPageSize
): BranchListResponse {
  const offset = repairOffset(requestedOffset, FIXTURE_BRANCHES.length, limit);
  const items = FIXTURE_BRANCHES.slice(offset, offset + limit);
  const total = FIXTURE_BRANCHES.length;
  return {
    facets: emptyBranchListFacets(),
    hasMore: offset + items.length < total,
    items,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit,
      now: NOW_ISO,
      offset,
      requestedOffset,
    },
    readSource: ReadSource.Cloud,
    total,
    viewerScope: BranchViewerScope.Organization,
  };
}

function offsetClampAnalyticsResponse(): BranchAnalytics {
  const unavailable = unavailableKpi();
  return {
    activeBranchCount: unavailable,
    activePrCount: unavailable,
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
    leadTimeForChangeMs: unavailable,
    locPerDollar: unavailable,
    medianPrSize: unavailable,
    medianTimeToMergeMs: unavailable,
    mergeRate: unavailable,
    mergedCount: unavailable,
    totalSpendUsd: unavailable,
    viewerScope: BranchViewerScope.Organization,
  };
}

function makeOffsetClampBranch(index: number): BranchRow {
  const suffix = String(index).padStart(2, "0");
  const id = `10000000-0000-4000-8000-0000000000${suffix}`;
  return {
    additions: 10 + index,
    ahead: 1,
    artifactId: id,
    baseBranch: "main",
    behind: 0,
    branchName: `iss-10434-offset-clamp-${suffix}`,
    checksPassed: null,
    checksStatus: null,
    checksTotal: null,
    deletions: 2,
    estimatedCostUsd: 1,
    filesChanged: 1,
    id,
    lastActivityAt: NOW_ISO,
    multiPrWarning: false,
    owner: "Offset Clamp Agent",
    ownerIdentity: {
      availability: BranchIdentityAvailability.Complete,
      person: {
        displayName: "Offset Clamp Agent",
        id: "offset-clamp-agent",
        login: "offset-clamp-agent",
        provider: BranchPersonProvider.GitHub,
      },
    },
    prNumber: null,
    prState: null,
    prTitle: null,
    prUrl: null,
    repoFullName: "acme/offset-clamp",
    reviewDecision: null,
    sessionIds: [`${id}-session`],
    status: BranchStatus.Open,
  };
}

function writeErrorJson(
  response: ServerResponse,
  data: Record<string, unknown>
): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ success: false, ...data }));
}
