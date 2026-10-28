/**
 * ISS-7207: launched Desktop coverage for Branch Details Sessions & timeline.
 *
 * NO STICKY-SHELL CHECK HERE. It asserted that a 560px desktop window left
 * `.sd3-scroll.bq-page-scroll` room for the 253px timeline rail plus 96px of
 * scroll. ISS-4715 made `StartupReadinessPanel` an unconditional in-flow band
 * above that scroller, which left the 560px fixture 238px and made the claim
 * unmakeable on this shell. ISS-10492 deleted that panel — the one progress
 * surface is now a FIXED-position bar whose height the shell offsets — so the
 * band is gone, but the assertion stays deleted: it was a pre-panel layout
 * expectation that no longer describes this shell's chrome either way, and
 * restoring it would pin a measurement nobody has re-derived. The rail itself is shared CSS
 * (`packages/app/branches/branch-timeline.css`) and `expectTimelineStickyShell`
 * in `e2e/branch-details-comprehensive.spec.ts` still asserts it, unchanged, on
 * the web shell.
 *
 * Prerequisite: `pnpm -C apps/desktop build`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import axe from "axe-core";
import {
  DENSE_TIMELINE_EVENT_LABELS,
  denseEventTraceResponse,
  partiallyLoadedMixedCostTraceResponse,
  traceResponse,
} from "../../../../e2e/helpers/branch-details-comprehensive-comments-trace";
import {
  BRANCH_ID,
  denseTimelineDetailFor,
  detailFor,
} from "../../../../e2e/helpers/branch-details-comprehensive-data";
import { expectWcagAaClean } from "../../../../e2e/helpers/critical-wcag-aa";
// ISS-10599: the canonical constant, reached by RELATIVE path. The literal
// above is re-typed because `@repo/…` workspace specifiers do not resolve under
// Playwright's ESM loader; a relative `.ts` path does — this spec already
// imports the repo-root `e2e/helpers` that way — so the one key this spec seeds
// is the real constant and cannot drift from it.
import { TIMELINE_SCALE_VISIBLE_LABEL_FLAG_KEY } from "../../../../packages/api/src/types/timeline-scale-visible-label-flag";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  type AuthenticatedCloudRequest,
  createAuthenticatedDesktopSessionRecord,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { mergeE2eFeatureFlagAssignment } from "./helpers/e2e-feature-flag-assignment-seed";

const GROUP_BY_NAME_PATTERN = /group by/i;
const JUMP_TO_EVENT_PATTERN = /Jump to /;
const NARROW_VIEWPORT = { height: 844, width: 390 };
const SCALE_GROUP_NAME = "Timeline scale";
const SCALE_OPTION_1H_NAME = "1h timeline scale";
const SCALE_OPTION_12H_NAME = "12h timeline scale";
const SCRUBBER_NAME = "Branch timeline position";
const TIMELINE_AXE_SCOPE = "section.bq-act";
const TIMELINE_CLUSTER_PATTERN = /more timeline events near/i;
const UNATTRIBUTED_BAR_LABEL_PATTERN = /Unattributed/;
const MIXED_TIMELINE_LABEL_PATTERN =
  /\$15\.00.*Cosimo \$10\.00.*Tamsin \$5\.00/;
const LEGACY_MIXED_TIMELINE_LABEL_PATTERN = /\$17\.50|Tamsin \$7\.50/;
const PARTIAL_TIMELINE_LABEL_PATTERN = /\$5\.00.*Tamsin \$5\.00/;
const LEGACY_PARTIAL_TIMELINE_LABEL_PATTERN =
  /\$10\.00|Cosimo \$10\.00|Tamsin \$10\.00/;
/**
 * Desktop E2E cannot import the shared flag registry directly because its
 * extension-less workspace specifiers do not resolve under Playwright's ESM
 * loader. `apps/desktop/test/feature-flags-cross-surface.test.ts` pins this
 * literal against the Desktop Labs alias.
 */
const BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY =
  "branch-timeline-cost-fallback-marker";

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged; a type alias cannot augment it.
  interface Window {
    desktopApi: {
      getDesktopAuthState: () => Promise<DesktopAuthState>;
    };
  }
}

test.describe("Branch Details timeline", () => {
  test("packs sparse and dense markers through the authenticated cloud renderer", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-markers-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-markers-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-markers-udd-")
    );
    let useDenseTrace = false;
    const server = await startAuthenticatedBranchCloudServer({
      detailFactory: (pullRequestNumber) =>
        useDenseTrace
          ? denseTimelineDetailFor(pullRequestNumber)
          : detailFor(pullRequestNumber),
      traceFactory: () =>
        useDenseTrace ? denseEventTraceResponse() : traceResponse(),
    });

    try {
      const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp(
        {
          sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
          cloudReadReadiness: drainedCloudReadReadiness(),
          beforeLaunch: (launchUserDataDir) => {
            seedDesktopSettings(launchUserDataDir, {
              activeConfigId: "branch-details-marker-profile",
              apiOrigin: server.origin,
              cloudConnectionEnabled: true,
              savedConfigs: [
                {
                  apiOrigin: server.origin,
                  gatewayId: AUTHENTICATED_GATEWAY_ID,
                  id: "branch-details-marker-profile",
                  name: "Branch Details Markers E2E",
                  relayOrigin: "http://127.0.0.1:9",
                  webAppOrigin: "http://127.0.0.1:3000",
                },
              ],
            });
            // ISS-10599: the PostHog-assignment side ONLY. Per root AGENTS.md a
            // shared key gets no desktop Labs registry entry, so this must not
            // go through `seedDesktopFeatureFlags`, which also writes a settings
            // flag — that would seed a registry shadow the renderer no longer
            // reads and this spec would then claim a gate that is not the gate.
            mergeE2eFeatureFlagAssignment(launchUserDataDir, {
              [TIMELINE_SCALE_VISIBLE_LABEL_FLAG_KEY]: true,
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
        await gotoHash(page, `/branches/${BRANCH_ID}`);
        await page.getByRole("tab", { name: "Sessions & timeline" }).click();
        await expectSparseTimelineMarkerRail(page);
        await expectTimelineGroupBy(page);
        expectCompleteTraceRequests(server.requests, 1);

        const oneHour = page.getByRole("radio", {
          exact: true,
          name: SCALE_OPTION_1H_NAME,
        });
        await oneHour.click();
        await expect(oneHour).toHaveAttribute("data-state", "on");
        useDenseTrace = true;
        await page.reload();
        await gotoHash(page, `/branches/${BRANCH_ID}`);
        await page.getByRole("tab", { name: "Sessions & timeline" }).click();
        await expectDenseTimelineMarkerRail(page);
        expectCompleteTraceRequests(server.requests, 2);
        await expectWcagAaClean(page, axe.source, {
          scope: TIMELINE_AXE_SCOPE,
        });

        await page.setViewportSize(NARROW_VIEWPORT);
        await expectDenseTimelineMarkerRail(page);
        await expectNoHorizontalOverflow(page);
        await expectWcagAaClean(page, axe.source, {
          scope: TIMELINE_AXE_SCOPE,
        });
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await server.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("reconciles mixed session costs and keeps unpriced loaded cost unavailable", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-mixed-cost-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-mixed-cost-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-mixed-cost-udd-")
    );
    let detailFactory = mixedTimelineDetailFor;
    let traceFactory = mixedTimelineTraceResponse;
    const server = await startAuthenticatedBranchCloudServer({
      detailFactory: (pullRequestNumber) => detailFactory(pullRequestNumber),
      traceFactory: () => traceFactory(),
    });

    try {
      const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp(
        {
          sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
          cloudReadReadiness: drainedCloudReadReadiness(),
          beforeLaunch: (launchUserDataDir) => {
            seedDesktopSettings(launchUserDataDir, {
              activeConfigId: "branch-details-mixed-cost-profile",
              apiOrigin: server.origin,
              cloudConnectionEnabled: true,
              savedConfigs: [
                {
                  apiOrigin: server.origin,
                  gatewayId: AUTHENTICATED_GATEWAY_ID,
                  id: "branch-details-mixed-cost-profile",
                  name: "Branch Details Mixed Cost E2E",
                  relayOrigin: "http://127.0.0.1:9",
                  webAppOrigin: "http://127.0.0.1:3000",
                },
              ],
            });
            seedDesktopFeatureFlags(launchUserDataDir, {
              [BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY]: true,
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
        await gotoHash(page, `/branches/${BRANCH_ID}`);
        await page.getByRole("tab", { name: "Sessions & timeline" }).click();
        const timeline = page.locator("section.bq-act", {
          hasText: "PR timeline",
        });
        await expect(
          timeline.getByText("$15.00", { exact: true }).first()
        ).toBeVisible();
        await expect(activeTimelineBars(timeline).first()).toHaveAttribute(
          "aria-label",
          MIXED_TIMELINE_LABEL_PATTERN
        );
        await expect(activeTimelineBars(timeline).first()).not.toHaveAttribute(
          "aria-label",
          LEGACY_MIXED_TIMELINE_LABEL_PATTERN
        );
        expectCompleteTraceRequests(server.requests, 1);

        traceFactory = partiallyLoadedMixedTimelineTraceResponse;
        await page.reload();
        await gotoHash(page, `/branches/${BRANCH_ID}`);
        await page.getByRole("tab", { name: "Sessions & timeline" }).click();
        await expect(
          timeline.getByText("$5.00*", { exact: true }).first()
        ).toBeVisible();
        await expect(activeTimelineBars(timeline).first()).toHaveAttribute(
          "aria-label",
          PARTIAL_TIMELINE_LABEL_PATTERN
        );
        await expect(activeTimelineBars(timeline).first()).not.toHaveAttribute(
          "aria-label",
          LEGACY_PARTIAL_TIMELINE_LABEL_PATTERN
        );
        expectCompleteTraceRequests(server.requests, 2);

        detailFactory = unpricedTimelineDetailFor;
        traceFactory = unpricedTimelineTraceResponse;
        await page.reload();
        await gotoHash(page, `/branches/${BRANCH_ID}`);
        await page.getByRole("tab", { name: "Sessions & timeline" }).click();
        await expectTimelineCostUnavailable(timeline);
        expectCompleteTraceRequests(server.requests, 3);

        detailFactory = mixedZeroAndUnpricedTimelineDetailFor;
        traceFactory = mixedZeroAndUnpricedTimelineTraceResponse;
        await page.reload();
        await gotoHash(page, `/branches/${BRANCH_ID}`);
        await page.getByRole("tab", { name: "Sessions & timeline" }).click();
        await expectTimelineCostUnavailable(timeline);
        expectCompleteTraceRequests(server.requests, 4);
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await server.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

function mixedTimelineDetailFor(
  prNumber: number
): ReturnType<typeof detailFor> {
  const detail = detailFor(prNumber);
  return {
    ...detail,
    attributedCostUsd: 15,
    estimatedCostUsd: 20,
    sessionIds: ["session-stamped", "session-unstamped"],
    sessions: [
      mixedTimelineSession("session-stamped", "Cosimo", 10, 10),
      mixedTimelineSession("session-unstamped", "Tamsin", 10),
    ],
  };
}

function unpricedTimelineDetailFor(
  prNumber: number
): ReturnType<typeof detailFor> {
  const { attributedCostUsd: _attributedCostUsd, ...detail } =
    detailFor(prNumber);
  return {
    ...detail,
    additions: 100,
    deletions: 0,
    estimatedCostUsd: null,
    sessionIds: ["session-unpriced"],
    sessions: [mixedTimelineSession("session-unpriced", "Cosimo", null)],
  };
}

function mixedZeroAndUnpricedTimelineDetailFor(
  prNumber: number
): ReturnType<typeof detailFor> {
  const { attributedCostUsd: _attributedCostUsd, ...detail } =
    detailFor(prNumber);
  return {
    ...detail,
    additions: 100,
    deletions: 0,
    estimatedCostUsd: null,
    sessionIds: ["session-zero-cost", "session-unpriced"],
    sessions: [
      mixedTimelineSession("session-zero-cost", "Cosimo", 0),
      mixedTimelineSession("session-unpriced", "Tamsin", null),
    ],
  };
}

function mixedTimelineSession(
  sessionId: string,
  ownerUserName: string,
  estimatedCostUsd: number | null,
  evenSplitCostUsd?: number
): ReturnType<typeof detailFor>["sessions"][number] {
  const startedAt = "2026-08-01T10:00:00.000Z";
  const endedAt = "2026-08-01T10:20:00.000Z";
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    endedAt,
    estimatedCostUsd,
    harness: "codex",
    inputTokens: 100,
    isPrimary: sessionId === "session-stamped",
    name: `${ownerUserName} session`,
    outputTokens: 200,
    ownerUserName,
    sessionId,
    slug: sessionId,
    startedAt,
    ...(evenSplitCostUsd === undefined ? {} : { evenSplitCostUsd }),
  };
}

function mixedTimelineTraceResponse(): ReturnType<typeof traceResponse> {
  return loadedTimelineTraceResponse(["session-stamped", "session-unstamped"]);
}

function unpricedTimelineTraceResponse(): ReturnType<typeof traceResponse> {
  return loadedTimelineTraceResponse(["session-unpriced"]);
}

function mixedZeroAndUnpricedTimelineTraceResponse(): ReturnType<
  typeof traceResponse
> {
  return loadedTimelineTraceResponse(["session-zero-cost", "session-unpriced"]);
}

function loadedTimelineTraceResponse(
  sessionIds: readonly string[]
): ReturnType<typeof traceResponse> {
  const response = traceResponse();
  const traceState = response.traceState;
  if (!traceState) {
    throw new Error("Branch trace fixture must include traceState");
  }
  const loaded = traceState.sessions[0];
  if (!loaded) {
    throw new Error("Branch trace fixture must include a loaded session");
  }
  return {
    ...response,
    items: [],
    traceState: {
      ...traceState,
      qualifyingSessionCount: sessionIds.length,
      sessions: sessionIds.map((sessionId) => ({
        ...loaded,
        identity: {
          ...loaded.identity,
          artifactId: sessionId,
          name: sessionId,
          navigableRef: sessionId,
          slug: sessionId,
        },
      })),
    },
  };
}

async function expectTimelineCostUnavailable(timeline: Locator): Promise<void> {
  const costStat = timeline.locator(".bq-stat", { hasText: "cost" }).first();
  await expect(
    costStat.getByText("Unavailable", { exact: true })
  ).toBeVisible();
  await expect(costStat.getByText("$0.00", { exact: true })).toHaveCount(0);

  const locPerDollarStat = timeline.locator(".bq-stat-loc").first();
  await expect(locPerDollarStat.getByText("—", { exact: true })).toBeVisible();
  // ISS-12207: no "LOC/$" unit follows an absent ratio.
  await expect(locPerDollarStat).not.toContainText("LOC/$");
}

function partiallyLoadedMixedTimelineTraceResponse(): ReturnType<
  typeof traceResponse
> {
  return partiallyLoadedMixedCostTraceResponse();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const maxScrollWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth
          );
          return maxScrollWidth - document.documentElement.clientWidth;
        }),
      { message: "Branch Details should not overflow horizontally at 390px" }
    )
    .toBeLessThanOrEqual(1);
}

async function expectTimelineGroupBy(page: Page): Promise<void> {
  const timeline = page.locator("section.bq-act", { hasText: "PR timeline" });
  const groupBy = timeline.getByRole("combobox", {
    name: GROUP_BY_NAME_PATTERN,
  });
  await expect(groupBy).toBeVisible();
  await expect(groupBy).toContainText("Session owner");
  await expect(timeline.getByText("$8.00", { exact: true })).toBeVisible();
  await groupBy.click();
  await page.getByRole("option", { name: "Activity phase" }).click();
  await expect(groupBy).toContainText("Activity phase");
  await expect(timeline.getByText("$8.00", { exact: true })).toBeVisible();
  await expect(activeTimelineBars(timeline).first()).toHaveAttribute(
    "aria-label",
    UNATTRIBUTED_BAR_LABEL_PATTERN
  );
  await expectTimelineScaleAndScrubber(page);
}

async function expectTimelineScaleAndScrubber(page: Page): Promise<void> {
  const timeline = page.locator("section.bq-act", { hasText: "PR timeline" });
  const scaleGroup = timeline.getByRole("radiogroup", {
    exact: true,
    name: SCALE_GROUP_NAME,
  });
  const groupBy = timeline.getByRole("combobox", {
    name: GROUP_BY_NAME_PATTERN,
  });
  await expect(scaleGroup).toBeVisible();
  /*
   * ISS-10599 regression, desktop shell (#7592 review, whitlockk). The locator
   * above resolves the group by its ACCESSIBLE NAME, which the pre-fix control
   * already had through `aria-label` — so it was green against the very defect.
   * What only the fix makes true is that the name is PAINTED and that the group
   * is named FROM the painted element. The launch that reaches this helper
   * seeds the visible-label assignment; see `beforeLaunch` above.
   */
  const scaleLabelId = await scaleGroup.getAttribute("aria-labelledby");
  expect(scaleLabelId).toBeTruthy();
  const scaleLabel = page.locator(`#${scaleLabelId}`);
  await expect(scaleLabel).toBeVisible();
  await expect(scaleLabel).toHaveText(SCALE_GROUP_NAME);
  await expect(scaleGroup).not.toHaveAttribute("aria-label");
  await expect(
    scaleGroup.getByRole("radio", {
      exact: true,
      name: SCALE_OPTION_12H_NAME,
    })
  ).toBeVisible();
  await expect(groupBy).toBeVisible();
  const [scaleBox, groupByBox] = await Promise.all([
    scaleGroup.boundingBox(),
    groupBy.boundingBox(),
  ]);
  expect(scaleBox).not.toBeNull();
  expect(groupByBox).not.toBeNull();
  expect(scaleBox?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(
    groupByBox?.x ?? 0
  );

  const scrubber = page.getByRole("slider", {
    exact: true,
    name: SCRUBBER_NAME,
  });
  await expect(scrubber).toBeVisible();
  const axis = timeline.locator(".bq-axis");
  const beforeScrub = await axis.innerText();
  await scrubber.focus();
  await page.keyboard.press("ArrowRight");
  await expect(axis).not.toHaveText(beforeScrub);
  await page.keyboard.press("End");
  const scrubberMax = await scrubber.getAttribute("max");
  expect(scrubberMax).not.toBeNull();
  await expect.poll(() => scrubber.inputValue()).toBe(scrubberMax);
  await expect(timeline.getByText("100%", { exact: true })).toBeVisible();

  const twelveHours = scaleGroup.getByRole("radio", {
    exact: true,
    name: SCALE_OPTION_12H_NAME,
  });
  await twelveHours.click();
  await expect(twelveHours).toHaveAttribute("data-state", "on");
}

function activeTimelineBars(timeline: Locator): Locator {
  return timeline.locator('.bq-bar:not([data-gap="true"])');
}

async function expectDenseTimelineMarkerRail(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const timeline = page.locator("section.bq-act", { hasText: "PR timeline" });
  const rail = timeline.locator("[data-timeline-marker-rail]");
  await expect(rail).toBeVisible();
  await expect(rail).toHaveCSS("height", "72px");
  await expect
    .poll(() => rail.getByRole("button").count(), {
      message: "dense marker rail should stay within semantic rows",
    })
    .toBeLessThanOrEqual(6);
  const steeringTarget = await markerTargetForEvent(
    page,
    timeline,
    DENSE_TIMELINE_EVENT_LABELS[0]
  );
  const commitTarget = await markerTargetForEvent(
    page,
    timeline,
    DENSE_TIMELINE_EVENT_LABELS[2]
  );
  const failureMarker = timeline.getByRole("button", {
    name: DENSE_TIMELINE_EVENT_LABELS[3],
  });
  await expect(failureMarker).toBeVisible();
  await expectMarkersShareColumn([steeringTarget, commitTarget, failureMarker]);
  const steeringCluster = await markerTargetForEvent(
    page,
    timeline,
    DENSE_TIMELINE_EVENT_LABELS[0]
  );
  await steeringCluster.focus();
  await expect(steeringCluster).toBeFocused();
  const steeringClick: Promise<void> = steeringCluster.click();
  await steeringClick;
  for (const label of DENSE_TIMELINE_EVENT_LABELS.slice(0, 2)) {
    await expect(
      page.getByRole("button", { name: `Jump to ${label}` })
    ).toBeVisible();
  }
  await expect(page.getByText("Trace row 3", { exact: true })).toBeVisible();
  await expect(page.getByText("Trace row 4", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await failureMarker.focus();
  await expect(failureMarker).toBeFocused();
  await failureMarker.hover();
  await expect(
    page.locator('[data-slot="tooltip-content"]', {
      hasText: DENSE_TIMELINE_EVENT_LABELS[3],
    })
  ).toContainText("Failures & limits");
  await failureMarker.click();
  await expect(
    page.locator('.st [data-row="5"][data-active="true"]')
  ).toBeVisible();
  await page.keyboard.press("Escape");
}

async function markerTargetForEvent(
  page: Page,
  timeline: Locator,
  label: string
): Promise<Locator> {
  const direct = timeline.getByRole("button", { name: label });
  if (await direct.isVisible().catch(() => false)) {
    return direct;
  }
  const clusters = timeline.getByRole("button", {
    name: TIMELINE_CLUSTER_PATTERN,
  });
  const count = await clusters.count();
  for (let index = 0; index < count; index += 1) {
    const cluster = clusters.nth(index);
    await cluster.click();
    const member = page.getByRole("button", { name: `Jump to ${label}` });
    if (await member.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      return cluster;
    }
    await page.keyboard.press("Escape");
  }
  throw new Error(`No marker or cluster exposes ${label}`);
}

async function expectMarkersShareColumn(markers: readonly Locator[]) {
  const centers = await Promise.all(markers.map(markerCenter));
  const lefts = centers.map((center) => center.x);
  expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(1);
  const tops = centers.map((center) => Math.round(center.y));
  expect(new Set(tops).size).toBe(markers.length);
}

async function markerCenter(
  marker: Locator
): Promise<{ x: number; y: number }> {
  const box = await marker.boundingBox();
  expect(box).not.toBeNull();
  return {
    x: Math.round((box?.x ?? 0) + (box?.width ?? 0) / 2),
    y: Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2),
  };
}

function expectCompleteTraceRequests(
  requests: readonly AuthenticatedCloudRequest[],
  expectedCount: number
): void {
  const traceRequests = requests.filter(
    (request) =>
      request.pathname === `/branches/${BRANCH_ID}/trace` &&
      request.authorization === `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  );
  expect(traceRequests.map((request) => request.search)).toEqual(
    Array.from({ length: expectedCount }, () => [
      "?pageMode=cursor&limit=100",
      "?complete=true",
    ]).flat()
  );
}

async function expectSparseTimelineMarkerRail(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const timeline = page.locator("section.bq-act", { hasText: "PR timeline" });
  const rail = timeline.locator("[data-timeline-marker-rail]");
  await expect(rail).toBeVisible();
  await expect(rail).toHaveCSS("height", "24px");
  await expect
    .poll(() => rail.getByRole("button").count(), {
      message: "sparse marker rail should stay in one visible row",
    })
    .toBeLessThanOrEqual(2);
  const cluster = timeline.getByRole("button", {
    name: TIMELINE_CLUSTER_PATTERN,
  });
  await expect(cluster).toBeVisible();
  await cluster.focus();
  await expect(cluster).toBeFocused();
  await cluster.click();
  await expect(
    page.getByRole("button", { name: JUMP_TO_EVENT_PATTERN }).first()
  ).toBeVisible();
  await expect(page.getByText("Commits & PRs").first()).toBeVisible();
  await page.keyboard.press("Escape");
}
