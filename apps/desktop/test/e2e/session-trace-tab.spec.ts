/**
 * ISS-10737 (desktop adapter): the session Trace tab, through a LAUNCHED
 * Electron app reading cloud-mode session detail.
 *
 * The Electron twin of `e2e/session-trace-tab.spec.ts`. Both shells mount ONE
 * `SessionDetailWorkspace` from `packages/app`, and `packages/app/AGENTS.md`
 * requires both adapters be covered for exactly the divergence this closes: the
 * web spec resolves `?tab=` out of Next.js `useSearchParams` and reaches the
 * tree over browser `fetch`, while this shell resolves the same param out of
 * `location.hash` through `createDesktopNavigation` and reaches the tree through
 * its own cloud source. A regression in either would leave the other spec and
 * every mounted component test green.
 *
 * TWO ARMS, AND THE GATE IS THE VARIABLE. Flag ON serves a tree and asserts the
 * chart; flag OFF serves the SAME tree and asserts today's document, which is
 * what proves the gate is wired rather than the tab being unconditional
 * (ISS-4779 closed-by-default). ONE PostHog key covers both shells — the desktop
 * renderer resolves the signed-in account's assignment from the same key space
 * `apps/app` reads — so the key seeded here is the key the web spec pins.
 *
 * EVERY ABSENCE IS PAIRED WITH A PRESENCE, on the same navigation: "no chart"
 * alone is satisfied by a locator that matches nothing.
 *
 * Build before running: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
// `.ts` is load-bearing on VALUE imports: extensionless specifiers do not
// resolve under the spec loader, and a spec-level import failure aborts the
// WHOLE desktop-e2e suite at load.
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadRow,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation.ts";
import type { AgentComponentInvocationSessionTreePage } from "@repo/api/src/types/agent-component-invocation-session-tree";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
} from "./helpers/branch-details-authenticated-cloud";
import { drainedCloudReadReadiness, gotoHash } from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  CLOUD_SESSION_DETAIL_ID,
  seedCloudSessionDetailProfile,
  startAuthenticatedSessionDetailCloudServer,
} from "./helpers/session-detail-authenticated-cloud";

/**
 * The ISS-10737 gate, spelled as a LITERAL for the loader reason above. Pinned
 * against the exported constant by the web twin, which imports it, so a rename
 * reddens there rather than leaving this spec seeding a key nothing reads.
 */
const SESSION_TRACE_TAB_FLAG_KEY = "session-trace-tab";

/**
 * A SECOND flag, seeded ON in BOTH arms as the barrier rather than as a
 * variable. `DesktopFeatureFlagProvider` starts every key CLOSED and replaces
 * the whole set when its own assignment settles, so flag-unresolved and
 * flag-resolved-OFF both render today's document — no assertion on the document
 * can tell them apart, and the gate-OFF arm's `toHaveCount(0)` would resolve on
 * its first poll. This key rides the SAME payload and is applied by the SAME
 * provider update, so its rendered badge proves the payload landed.
 */
const READ_SOURCE_BADGE_FLAG_KEY = "session-detail-read-source";

/** Component keys that appear nowhere else, so finding one proves the CHART rendered. */
const ROOT_COMPONENT_KEY = "iss-10737-desktop-root-command";
const CHILD_COMPONENT_KEY = "iss-10737-desktop-child-tool";

const CHART_NAME = "Session spans, outermost first";
/** The overview document's own `h2`, and the one thing Trace must replace. */
const OVERVIEW_HEADING = /^Session Trace$/;

const MOUNT_TIMEOUT_MS = 30_000;
/** Two Electron launches per arm, on a machine that may be under load. */
const ARM_TIMEOUT_MS = 240_000;

test.describe("Session Trace tab, desktop cloud read (ISS-10737)", () => {
  test("a cold ?tab=trace hash opens the chart, and Overview returns to the document", async () => {
    test.setTimeout(ARM_TIMEOUT_MS);

    await withCloudSessionDetail(true, async (page) => {
      const chart = page
        .getByRole("list", { name: CHART_NAME })
        .locator("visible=true");
      await expect(chart).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      // Count BEFORE visibility on each row: a row locator that matched nothing
      // would leave `toBeVisible` the only assertion, and the mirror of the bug
      // this replaced (too many matches) is a selector that matches none and
      // passes forever. `toHaveCount(1)` fails on 0 and on a duplicate alike.
      const rootRow = spanRow(chart, ROOT_COMPONENT_KEY);
      const childRow = spanRow(chart, CHILD_COMPONENT_KEY);
      await expect(rootRow).toHaveCount(1);
      await expect(rootRow).toBeVisible();
      await expect(childRow).toHaveCount(1);
      await expect(childRow).toBeVisible();
      await expect(overviewHeading(page)).toHaveCount(0);

      await page
        .getByRole("tab", { name: "Overview" })
        .locator("visible=true")
        .first()
        .click();

      await expect(overviewHeading(page)).toBeVisible();
      await expect(chart).toHaveCount(0);
    });
  });

  test("with the gate shut there is no tab bar, ?tab=trace lands on the document", async () => {
    test.setTimeout(ARM_TIMEOUT_MS);

    await withCloudSessionDetail(false, async (page) => {
      // The presence that makes the absences below mean something.
      await expect(overviewHeading(page)).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
      await expect(page.getByRole("tab", { name: "Trace" })).toHaveCount(0);
      await expect(page.getByRole("list", { name: CHART_NAME })).toHaveCount(0);
    });
  });
});

function overviewHeading(page: Page): Locator {
  return page
    .getByRole("heading", { level: 2, name: OVERVIEW_HEADING })
    .locator("visible=true");
}

/** The read-source badge: proof the renderer APPLIED the seeded flag payload. */
function readSourceBadge(page: Page): Locator {
  return page.getByTestId("read-source-badge");
}

function invocationRow(
  index: number,
  componentKey: string,
  kind: AgentComponentInvocationKind,
  parentExternalInvocationId?: string
): AgentComponentInvocationReadRow {
  return {
    id: `row-${index}`,
    externalInvocationId: `inv-${index}`,
    sessionId: CLOUD_SESSION_DETAIL_ID,
    externalSessionId: CLOUD_SESSION_DETAIL_ID,
    sourceSessionId: CLOUD_SESSION_DETAIL_ID,
    ...(parentExternalInvocationId === undefined
      ? {}
      : { parentExternalInvocationId }),
    kind,
    componentKey,
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: new Date(Date.UTC(2026, 8, 20, 9, index)).toISOString(),
    sequence: index,
    anchor: { kind: AgentComponentInvocationAnchorKind.Session },
    status: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
  };
}

function treePage(): AgentComponentInvocationSessionTreePage {
  return {
    items: [
      invocationRow(
        0,
        ROOT_COMPONENT_KEY,
        AgentComponentInvocationKind.Command
      ),
      invocationRow(
        1,
        CHILD_COMPONENT_KEY,
        AgentComponentInvocationKind.Tool,
        "inv-0"
      ),
    ],
    total: 2,
  };
}

/**
 * Runs one arm. Two launches are structural, not wasteful:
 * `seedAuthenticatedDesktopSession` encrypts through Electron's own
 * `safeStorage` so it needs a live app, and the production restore lane reads
 * that file only at boot.
 */
async function withCloudSessionDetail(
  traceTabEnabled: boolean,
  assertOn: (page: Page) => Promise<void>
): Promise<void> {
  // Server first: it is the only step here that can throw before the `try`.
  const server = await startAuthenticatedSessionDetailCloudServer({
    // Served in BOTH arms, so the gate-OFF arm is asserting a shut gate rather
    // than an absent tree.
    invocationTree: treePage(),
  });
  // Empty harness homes: a local row for this session id would let the LOCAL
  // read answer, and this arm would then grade a path it never came for.
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-10737-claude-")
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-10737-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-10737-udd-"));

  try {
    await initializeDesktopProfileSchema(userDataDir);
    await waitForBranchesSchema(userDataDir);

    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (launchUserDataDir) => {
        seedCloudSessionDetailProfile(launchUserDataDir, server.origin, {
          [READ_SOURCE_BADGE_FLAG_KEY]: true,
          [SESSION_TRACE_TAB_FLAG_KEY]: traceTabEnabled,
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

      await gotoHash(page, `/sessions/${CLOUD_SESSION_DETAIL_ID}?tab=trace`);

      // The gate as the RENDERER APPLIED it — see the constant's docstring.
      await expect(readSourceBadge(page)).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });

      await assertOn(page);

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
}

/**
 * ONE span row, addressed by the row's own button instead of by a bare text
 * node. A row states its component key TWICE — once in the truncated visible
 * label and once in the `sr-only` accessible name assembled by
 * `sessionTraceRowAccessibleName` — so `getByText(key)` inside the list resolves
 * to two nodes within a SINGLE row and trips strict mode. The button is the row,
 * and its accessible name carries only its own key, so one key names one row.
 */
function spanRow(chart: Locator, componentKey: string): Locator {
  return chart.getByRole("button", { name: componentKey });
}
