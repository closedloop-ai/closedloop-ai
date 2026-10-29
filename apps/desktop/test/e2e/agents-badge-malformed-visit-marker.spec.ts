/**
 * ISS-8533: an unusable "last visited Agents" marker hides the sidebar badge on
 * the DESKTOP shell instead of counting the entire local inactive corpus behind
 * the word "recently". The web twin of the surface lives in `apps/app`; this is
 * the shell the defect actually mis-rendered on.
 *
 * WHY THIS ADAPTER, SPECIFICALLY
 * ------------------------------
 * `useAgentsNavActivity` is shared through `@repo/app`, but its malformed-marker
 * behaviour DIVERGED at the two adapters, and only one of them produced a number.
 * Web template-interpolates `completedAfter` into a query string, `isoDateQuerySchema`
 * rejects it, the request 400s and the badge hides — a wrong-looking but silent
 * outcome. Desktop hands the same filters across IPC by structured clone, where
 * `parseOptionalDate` -> `coerceOptionalString`
 * (`src/main/session/shared-agent-sessions-query.ts`) DROPS a non-string bound and
 * answers `COUNT(*)` over every local inactive session. That is the confident wrong
 * number, and it exists only here. A jsdom test of the hook asserts the filters
 * object; it cannot assert what this main process does with one.
 *
 * THE FALSE GREEN THIS SPEC IS SHAPED AROUND
 * ------------------------------------------
 * "The badge is absent" is satisfied by a harness that renders no sidebar, seeds no
 * sessions, or boots into the Agents route (where the badge is hidden BY DESIGN and
 * the marker is being drained). The CONTROL case is the guard: same profile shape,
 * same seeded corpus, same route, a CANONICAL marker — and the badge must be there
 * announcing all three seeded sessions. Every absence assertion below leans on it.
 *
 * Marker instants are derived from the run clock, never written as literals: a
 * frozen seed date reds the whole lane once it drifts out of a window.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.ts";
import { agentsLastVisitedKey } from "@repo/app/agents/lib/agents-activity-storage-key.ts";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
} from "../../src/renderer/components/dashboard/dashboard-storage-keys";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/** Wide enough that the sidebar renders expanded with its trailing badge slot. */
const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

const BADGE_TIMEOUT_MS = 30_000;

/** The activity badge's accessible name, whatever count it carries. */
const ANY_BADGE_NAME = /recently finished session/;

const AGENTS_NAV_LINK_NAME =
  /^Agents(?:\s+\d+\s+recently finished sessions?)?$/;

/**
 * The desktop renderer's profile is SIGNED OUT, so `useAuthSnapshot().orgId` is
 * null and the marker takes the un-namespaced arm of the key.
 */
const MARKER_KEY = agentsLastVisitedKey(null);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Three finished sessions, all ended two days ago. Terminal and `inactive`, so the
 * badge's `statuses: [INACTIVE]` + `countOnly` read finds exactly these — and every
 * marker case below is bounded strictly earlier than this instant, so a bound that
 * is APPLIED and a bound that is DROPPED both admit all three. That is deliberate:
 * it means the badge's presence can only turn on whether the marker was usable, not
 * on how many rows the window happened to catch.
 */
const SEEDED_SESSION_COUNT = 3;

/** The row name asserted on the Dashboard to prove the local read answered. */
const SETTLE_SESSION_NAME = "ISS-8533 finished session 1";

function sessionSeeds(endedAt: string): SessionListSeed[] {
  return Array.from({ length: SEEDED_SESSION_COUNT }, (_, index) => ({
    sessionId: `iss-8533-session-${index + 1}`,
    name: `ISS-8533 finished session ${index + 1}`,
    status: SESSION_STATUS.INACTIVE,
    at: endedAt,
    endedAt,
  }));
}

/**
 * Boot once to create the schema and write the pre-mount localStorage (onboarding
 * flags plus the marker under test), close so the DB seed writes without
 * cross-process WAL contention, seed, then boot again into the Dashboard and hand
 * back the live page. Agents is deliberately NOT the landing route: the badge is
 * hidden while it is active and `markVisited` would overwrite the seeded marker.
 */
async function bootSeededProfile(
  storedMarkerBytes: string,
  run: (page: Page) => Promise<void>
): Promise<void> {
  // Collector-home isolation is `launchDesktopApp`'s default (ISS-7731), so the
  // only rows in this profile are the ones seeded below.
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss8533-udd-")
  );
  const endedAt = new Date(Date.now() - 2 * DAY_MS).toISOString();

  try {
    const first = await launchDesktopApp({
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
      await first.page.evaluate(
        ([onboardedKey, tourSeenKey, markerKey, markerBytes]) => {
          localStorage.setItem(onboardedKey, "1");
          localStorage.setItem(tourSeenKey, "1");
          // The EXACT bytes localStorage holds — `JSON.parse` is what receives
          // them, so a seed that pre-parses would never reach the coercion.
          localStorage.setItem(markerKey, markerBytes);
        },
        [
          dashboardOnboardedStorageKey,
          dashboardTourSeenStorageKey,
          MARKER_KEY,
          storedMarkerBytes,
        ]
      );
    } finally {
      await first.cleanup();
    }

    await seedSessionsList(userDataDir, sessionSeeds(endedAt));

    const second = await launchDesktopApp({
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await second.page.setViewportSize(DESKTOP_VIEWPORT);
      await gotoNav(second.page, "dashboard");
      await expandLabsSection(second.page);
      await run(second.page);
    } finally {
      await second.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}

/**
 * The Agents destination lives in the Labs section, which ships COLLAPSED
 * (ISS-4478) — its items are not in the DOM until it is expanded, and the badge
 * is a `trailing` slot on the Agents item, so nothing mounts `AgentsNavBadge`
 * until this runs. Without it every case here would assert an absence caused by
 * a shut drawer.
 */
async function expandLabsSection(page: Page): Promise<void> {
  const labsToggle = page.getByRole("button", { name: "Labs" });
  await expect(labsToggle).toBeVisible({ timeout: BADGE_TIMEOUT_MS });
  await labsToggle.click();
  await expect(labsToggle).toHaveAttribute("aria-expanded", "true");
  // The item the badge hangs off. Asserted in EVERY case, including the absent
  // ones: it is what makes "no badge" mean the marker was rejected rather than
  // the nav item never having rendered. The trailing badge contributes to the
  // link's accessible name in the CONTROL case.
  await expect(
    page.getByRole("link", { name: AGENTS_NAV_LINK_NAME })
  ).toBeVisible({
    timeout: BADGE_TIMEOUT_MS,
  });
}

/**
 * Wait for the seeded corpus to have been READ before asserting the badge is
 * absent. `toHaveCount(0)` is satisfied by the very first poll, so without this
 * every absence case here would pass at t=0 — before the badge query could have
 * resolved, and therefore equally on a build with no coercion at all. This is
 * the same local session read the badge counts through, so once the Dashboard is
 * rendering a seeded row the badge has had its answer; a bound that was dropped
 * would be on screen by now. Not a fixed sleep: it waits on an observable state,
 * and the CONTROL case proves the badge beats this signal when it is coming.
 */
async function waitForLocalSessionReadSettled(page: Page): Promise<void> {
  await expect(page.getByText(SETTLE_SESSION_NAME).first()).toBeVisible({
    timeout: BADGE_TIMEOUT_MS,
  });
}

/** The badge's own accessible name — the count announced with meaning. */
function badge(page: Page) {
  return page.getByRole("status", {
    name: `${SEEDED_SESSION_COUNT} recently finished sessions`,
  });
}

/**
 * Any activity badge, whatever it counts. Scoped by the badge's own accessible
 * name pattern rather than a bare `role="status"` sweep — the Dashboard carries
 * unrelated live regions (the update prompt, the import progress banner), and a
 * blanket sweep would be asserting those instead.
 */
function anyBadge(page: Page) {
  return page.getByRole("status", { name: ANY_BADGE_NAME });
}

test.describe("Agents sidebar badge — an unusable marker is an absent marker", () => {
  test("CONTROL: a canonical ISO marker counts the seeded finished sessions", async () => {
    test.setTimeout(300_000);
    // Five days ago: earlier than every seeded `ended_at`, so the bound is real
    // and all three rows are inside it.
    const marker = new Date(Date.now() - 5 * DAY_MS).toISOString();

    await bootSeededProfile(JSON.stringify(marker), async (page) => {
      await expect(badge(page)).toBeVisible({ timeout: BADGE_TIMEOUT_MS });
    });
  });

  test("RED: a bare epoch NUMBER hides the badge instead of counting everything", async () => {
    test.setTimeout(300_000);
    // The ticket's own triggering input: an epoch-ms marker where an ISO string
    // belongs. `Boolean(<number>)` is truthy, so before the fix the gate opened,
    // this main process dropped the non-string bound, and the badge announced the
    // whole inactive corpus as "recently finished".
    const marker = String(Date.now() - 5 * DAY_MS);

    await bootSeededProfile(marker, async (page) => {
      await waitForLocalSessionReadSettled(page);
      // Any count at all, not just the seeded three — a bound that was dropped
      // and a bound that was mis-set both surface as SOME badge here.
      await expect(anyBadge(page)).toHaveCount(0);
      await expect(badge(page)).toHaveCount(0);
    });
  });

  test("RED: a DATE-ONLY marker hides the badge instead of bounding on midnight", async () => {
    test.setTimeout(300_000);
    // `Date.parse("2026-01-01")` is finite, so a parses-to-an-instant check alone
    // accepts this and ships an arbitrary UTC-midnight bound. Derived from the run
    // clock rather than written as a literal so it cannot rot out of the window.
    const marker = new Date(Date.now() - 30 * DAY_MS)
      .toISOString()
      .slice(0, "YYYY-MM-DD".length);

    await bootSeededProfile(JSON.stringify(marker), async (page) => {
      await waitForLocalSessionReadSettled(page);
      // Any count at all, not just the seeded three — a bound that was dropped
      // and a bound that was mis-set both surface as SOME badge here.
      await expect(anyBadge(page)).toHaveCount(0);
      await expect(badge(page)).toHaveCount(0);
    });
  });
});
