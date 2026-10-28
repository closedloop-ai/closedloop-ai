/**
 * ISS-7505 — the DESKTOP Sessions list, grouped by Owner, bands on the owner's
 * ID: two different people sharing a display name get two bands, each headed by
 * that name, and collapsing one leaves the other owner's rows on screen.
 *
 * THE MUTATION THAT MUST TURN THIS RED: key the Owner band on the display name
 * again — in `groupBand` (`packages/app/.../sessions-list-surface-rows.tsx`),
 * return `{ key: label, label }` for `SESSIONS_OWNER_COLUMN_ID`. Both owners then
 * fold into ONE "Jane Doe" band, and collapsing it hides both owners' rows.
 *
 * WHY CLOUD MODE. Desktop's local read serves one owner per session, the local
 * creator resolved against the org directory snapshot
 * (`buildLocalSessionPeople`), so a local corpus cannot hold two people at all.
 * The cloud read carries each row's owner on the wire, which is the population
 * where two people can share a name. The web half is
 * `e2e/sessions-v2-owner-same-name-bands.spec.ts`; the band model itself is
 * `sessions-list-group-values.test.ts`.
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
import { expect, type Locator, test } from "@playwright/test";
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
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  closeServer,
  createAuthenticatedDesktopSessionRecord,
  rejectNotFound,
  routeDesktopSessionRefresh,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoNavSettled,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

const PROFILE_ID = "iss-7505-owner-bands-profile";
/** Origin used only to parse a relative request URL; never dialled. */
const REQUEST_ORIGIN = "http://127.0.0.1";
const SESSIONS_LIST_PATH = "/agent-sessions";
const SESSIONS_USAGE_PATH = "/agent-sessions/usage";
const CONNECTED_AGENT_PATH = "/compute-targets/has-connected-agent";
const MOUNT_TIMEOUT_MS = 30_000;

const GROUP_BUTTON = "Group";
const PRIMARY_GROUPING_FIELD = "Primary grouping field";
/** `SESSIONS_COLUMN_SPECS`' Owner label, literal for the import hazard. */
const OWNER_GROUP_OPTION = "Owner";
const SHARED_NAME = "Jane Doe";
/** Bands sort by name and break a tie on the id key, so A renders first. */
const FIRST_OWNER_ID = "user-iss-7505-jane-a";
const SECOND_OWNER_ID = "user-iss-7505-jane-b";
const ROW_INDEXES = [1, 2, 3, 4] as const;
const EXACT = { exact: true } as const;

test.describe("Desktop Sessions Owner bands (ISS-7505)", () => {
  test("two owners sharing a display name get two bands, and collapsing one keeps the other's rows", async () => {
    test.setTimeout(240_000);

    // Empty homes so the boot collectors ingest nothing local.
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-7505-claude-")
    );
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-7505-codex-"));
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-7505-udd-"));
    const server = await startSessionsCloudServer();

    try {
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
                  name: "ISS-7505 Owner Bands E2E",
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
        // Cloud mode first, so a restore that never landed fails naming itself
        // rather than as a local list with no rows.
        await expect
          .poll(() =>
            page.evaluate(() => window.desktopApi.getDesktopAuthState())
          )
          .toMatchObject({
            organizationId: AUTHENTICATED_ORGANIZATION_ID,
            status: DesktopAuthStatus.Authenticated,
            userId: AUTHENTICATED_USER_ID,
          });

        const panel = await gotoNavSettled(page, "sessions");
        for (const index of ROW_INDEXES) {
          await expect(rowLink(panel, index)).toBeVisible({
            timeout: MOUNT_TIMEOUT_MS,
          });
        }
        // Control: no band before grouping, so the headers below are the
        // grouping and not Owner cells carrying the same name.
        await expect(bandHeaders(panel)).toHaveCount(0);

        await panel
          .getByRole("button", { ...EXACT, name: GROUP_BUTTON })
          .click();
        await page
          .getByRole("combobox", { name: PRIMARY_GROUPING_FIELD })
          .click();
        await page
          .getByRole("option", { ...EXACT, name: OWNER_GROUP_OPTION })
          .click();
        await page.keyboard.press("Escape");

        // TWO bands, both headed by the shared name. A name-keyed band is one.
        const sharedNameBands = bandHeaders(panel).getByRole("button", {
          ...EXACT,
          name: SHARED_NAME,
        });
        await expect(sharedNameBands).toHaveCount(2);
        const firstOwnerBand = sharedNameBands.first();
        await expect(firstOwnerBand).toHaveAttribute("aria-expanded", "true");

        await firstOwnerBand.click();

        // The first owner's rows go; the second owner's stay — the half a
        // merged band fails.
        await expect(firstOwnerBand).toHaveAttribute("aria-expanded", "false");
        await expect(rowLink(panel, 1)).toHaveCount(0);
        await expect(rowLink(panel, 3)).toHaveCount(0);
        await expect(rowLink(panel, 2)).toBeVisible();
        await expect(rowLink(panel, 4)).toBeVisible();
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

/** Odd rows belong to the first owner, even rows to the second. */
function rowName(index: number): string {
  return `ISS-7505 owner band row ${index}`;
}

function rowLink(panel: Locator, index: number): Locator {
  return panel.getByRole("link", { ...EXACT, name: rowName(index) });
}

/** The rendered band header rows; an Owner cell also names the owner. */
function bandHeaders(panel: Locator): Locator {
  return panel.locator("[data-grid-group-header]");
}

/**
 * A bounded stand-in for the authenticated cloud Sessions routes, on the
 * shared fixture's envelope writer, refusals and close.
 */
async function startSessionsCloudServer(): Promise<{
  close: () => Promise<void>;
  origin: string;
}> {
  const server = createServer((request, response) => {
    // Concatenated, not `new URL(target, base)`: a `//` target would parse as
    // protocol-relative. `URL.parse` returns null instead of throwing.
    const requestUrl = URL.parse(`${REQUEST_ORIGIN}${request.url ?? "/"}`);
    if (!requestUrl) {
      rejectNotFound(response);
      return;
    }
    routeSessionsRequest(request, requestUrl, response);
  });
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
    throw new Error("The ISS-7505 Sessions cloud stand-in did not bind.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
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
    writeApiResult(response, listFixture());
    return;
  }
  if (requestUrl.pathname === SESSIONS_USAGE_PATH) {
    writeApiResult(response, usageFixture());
    return;
  }
  if (requestUrl.pathname === CONNECTED_AGENT_PATH) {
    writeApiResult(response, { hasConnectedAgent: true });
    return;
  }
  rejectNotFound(response);
}

function listFixture(): AgentSessionListResponse {
  return {
    items: ROW_INDEXES.map((index) => sessionRow(index)),
    total: ROW_INDEXES.length,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

/**
 * One cloud row. Not `sessionListRow` from `e2e/helpers`: that module takes a
 * value off an extension-less `@repo/api` subpath, which aborts the whole
 * desktop-e2e suite at load (`apps/desktop/test/AGENTS.md`).
 */
function sessionRow(index: number): AgentSessionListItem {
  const endedAt = new Date(Date.now() - index * 60_000);
  const ownerId = index % 2 === 1 ? FIRST_OWNER_ID : SECOND_OWNER_ID;
  const rowOwner = {
    avatarUrl: null,
    email: `${ownerId}@example.com`,
    firstName: "Jane",
    id: ownerId,
    lastName: "Doe",
  };
  return {
    agentCount: 1,
    // The Owner rides `assignee`, as the current API serves it; `user` is the
    // deprecated alias the API still fills with the same person (ISS-12613).
    assignee: rowOwner,
    awaitingInputSince: null,
    baseBranch: "main",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    computeTarget: {
      id: "compute-target-iss-7505",
      isOnline: true,
      lastSeenAt: endedAt,
      machineName: "MacBook Pro",
    },
    cwd: "/workspace/closedloop-ai",
    endedAt,
    errorCount: 0,
    estimatedCost: 0,
    externalSessionId: `external-iss-7505-${index}`,
    harness: "claude",
    id: `iss-7505-session-${index}`,
    inputTokens: 0,
    lastActivityAt: endedAt,
    model: "claude-opus-5",
    name: rowName(index),
    outputTokens: 0,
    project: null,
    repositoryFullName: "closedloop-ai/closedloop-ai",
    slug: `SES-7505-${index}`,
    sourceArtifact: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    startedAt: new Date(endedAt.getTime() - 30 * 60_000),
    status: SESSION_STATUS.INACTIVE,
    toolUseCount: 0,
    updatedAt: endedAt,
    user: rowOwner,
    worktreePath: null,
  };
}

/** Flat usage; one `byRepository` entry so no analytics fallback read fires. */
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
        sessionCount: ROW_INDEXES.length,
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
    totalSessions: ROW_INDEXES.length,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}
