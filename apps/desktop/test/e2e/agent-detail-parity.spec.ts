import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component.ts";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation.ts";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session.ts";
import { listRequestUrl } from "@repo/api/src/types/list-query-request-params.ts";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.ts";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display.ts";
import { sessionDetailFixture } from "../../../../e2e/helpers/session-detail-fixtures";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  createAuthenticatedDesktopSessionRecord,
  rejectUnauthorized,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { drainedCloudReadReadiness } from "./helpers/desktop-app";
import { E2E_DESKTOP_FEATURE_FLAG_SEED } from "./helpers/e2e-desktop-settings-seed";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import {
  seedCloudSessionDetailProfile,
  startAuthenticatedSessionDetailCloudServer,
} from "./helpers/session-detail-authenticated-cloud";

test("Agent detail preserves Artifact, Details and Sessions with scoped grid and persisted views", async () => {
  test.setTimeout(180_000);
  const fixture = componentCloudRoutes();
  const server = await startAuthenticatedSessionDetailCloudServer({
    extraRoutes: fixture.route,
    detailOverrides: rows[0],
  });
  const dirs = makeSeededSessionsDirs("agent-detail-parity");
  try {
    const { page, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (profile) =>
        seedCloudSessionDetailProfile(
          profile,
          server.origin,
          E2E_DESKTOP_FEATURE_FLAG_SEED
        ),
      userDataDir: dirs.userDataDir,
      harnessHomesRoot: dirs.harnessHomesRoot,
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        CODEX_HOME: dirs.codexHome,
        CL_AUTH_API_ORIGIN: server.origin,
      },
    });
    try {
      await page.setViewportSize({ width: 2048, height: 1170 });
      await page.evaluate((href) => {
        globalThis.location.hash = href;
      }, componentPath);
      await expect(
        page.getByRole("heading", { name: component.name, exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByText(currentDefinition, { exact: true })
      ).toBeVisible();
      const revisions = page
        .getByRole("combobox")
        .filter({ hasText: "Current" });
      await revisions.click();
      await page.getByRole("option", { name: revisionPattern }).click();
      await expect(
        page.getByText(previousDefinition, { exact: true })
      ).toBeVisible();
      await page
        .getByRole("heading", { name: "Usage over time", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("img", { name: "Invocations in the last 30 days" })
      ).toBeVisible();
      await expect(page.locator(".recharts-bar-rectangle")).toHaveCount(
        new Set(rows.map((row) => row.startedAt.toISOString().slice(0, 10)))
          .size
      );
      await page.screenshot({
        path: test.info().outputPath("agent-artifact-wide.png"),
      });

      await page.getByRole("tab", { name: "Details", exact: true }).click();
      await expect(page).toHaveURL(detailsPattern);
      expect(page.url()).toContain(referenceMetrics);
      await expect(
        page.getByRole("heading", { name: optimizationPattern })
      ).toBeVisible();
      await expect(
        page.getByText("All versions of this component", { exact: true })
      ).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath("agent-details-wide.png"),
      });
      await page.goBack();
      await expect(
        page.getByRole("heading", { name: "Definition", exact: true })
      ).toBeVisible();

      await page
        .getByRole("tab", { name: "Sessions", exact: true })
        .first()
        .click();
      await expect(page).toHaveURL(sessionsPattern);
      await expect(
        page.getByRole("link", { name: "Review session 1", exact: true })
      ).toBeVisible();
      await page.getByLabel("Go to next page").click();
      await expect(
        page.getByRole("link", { name: "Review session 51", exact: true })
      ).toBeVisible();
      expect(fixture.reads.some((read) => read.offset === 50)).toBe(true);
      await page
        .getByRole("radio", { name: "Last 7 days", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "Review session 1", exact: true })
      ).toBeVisible();
      await expect
        .poll(() =>
          fixture.reads.some(
            (read) => read.offset === 0 && Boolean(read.startDate)
          )
        )
        .toBe(true);
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      await page.getByRole("menuitem", { name: "Status", exact: true }).hover();
      await page
        .getByRole("menuitem", {
          name: SESSION_STATUS_LABELS[SESSION_STATUS.ERROR],
          exact: true,
        })
        .click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect
        .poll(() =>
          fixture.reads.some((read) =>
            read.statuses.includes(SESSION_STATUS.ERROR)
          )
        )
        .toBe(true);
      await expect(
        page.getByRole("link", { name: "Review session 2", exact: true })
      ).toHaveCount(0);
      await page.getByRole("button", { name: "Views", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Save current view", exact: true })
        .click();
      await page
        .getByLabel("View name", { exact: true })
        .fill("Recent reviews");
      await page
        .getByRole("button", { name: "Save view", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Recent reviews", exact: true })
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Recent reviews", exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("radio", { name: "Last 7 days", exact: true })
      ).toHaveAttribute("aria-checked", "true");
      await expect(
        page.getByRole("link", { name: "Review session 1", exact: true })
      ).toHaveAttribute("href", sessionHrefPattern);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: test.info().outputPath("agent-sessions-narrow.png"),
      });
      await page.setViewportSize({ width: 2048, height: 1170 });
      await page.evaluate((href) => {
        globalThis.location.hash = href;
      }, `${agentRoute}?tab=evidence`);
      const traceLink = page.getByRole("link", {
        name: baseSession.externalSessionId,
        exact: true,
      });
      await expect(traceLink).toBeVisible();
      await expect(traceLink).toHaveAttribute("href", traceHrefPattern);
      await traceLink.click();
      await expect(page).toHaveURL(sessionHrefPattern);
      await page.goBack();
      await expect(page).toHaveURL(evidencePattern);
      await page.evaluate((href) => {
        globalThis.location.hash = href;
      }, `${agentRoute}?tab=branches`);
      // An in-panel EmptyState title is not a heading (empty-state.tsx), so
      // the state is read as text inside the Branches panel.
      await expect(
        page
          .getByRole("tabpanel", { name: "Branches", exact: true })
          .getByText("Branch details unavailable", { exact: true })
      ).toBeVisible();
      expect(fixture.reads.length).toBeGreaterThan(0);
      expect(
        fixture.reads.every((read) => read.componentSlug === component.slug)
      ).toBe(true);
      expect(fixture.unauthorized()).toBe(0);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupSeededSessionsDirs(dirs);
  }
});

test("Agent detail distinguishes unavailable invocation frequency from a measured chart", async () => {
  test.setTimeout(120_000);
  const fixture = componentCloudRoutes(true);
  const server = await startAuthenticatedSessionDetailCloudServer({
    extraRoutes: fixture.route,
  });
  const dirs = makeSeededSessionsDirs("agent-detail-frequency-unavailable");
  try {
    const { page, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (profile) =>
        seedCloudSessionDetailProfile(
          profile,
          server.origin,
          E2E_DESKTOP_FEATURE_FLAG_SEED
        ),
      userDataDir: dirs.userDataDir,
      harnessHomesRoot: dirs.harnessHomesRoot,
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        CODEX_HOME: dirs.codexHome,
        CL_AUTH_API_ORIGIN: server.origin,
      },
    });
    try {
      await page.setViewportSize({ width: 2048, height: 1170 });
      await page.evaluate((href) => {
        globalThis.location.hash = href;
      }, componentPath);
      await expect(
        page.getByText("Usage for this component isn't available here", {
          exact: true,
        })
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("img", { name: "Invocations in the last 30 days" })
      ).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath("agent-frequency-unavailable.png"),
      });
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupSeededSessionsDirs(dirs);
  }
});

function componentCloudRoutes(unavailableFrequency = false) {
  const reads: {
    componentSlug: string | null;
    offset: number;
    startDate: string | null;
    statuses: string[];
  }[] = [];
  let unauthorized = 0;
  const route = (request: IncomingMessage, response: ServerResponse) => {
    const url = URL.parse(`http://127.0.0.1${request.url ?? "/"}`);
    if (!url || request.method !== "GET") {
      return false;
    }
    const pathname = decodeURIComponent(url.pathname);
    const basePath = `/agent-components/${component.slug}`;
    const supported =
      pathname === basePath ||
      pathname === `${basePath}/frequency` ||
      pathname === "/agent-sessions" ||
      pathname === "/agent-sessions/usage" ||
      pathname === "/agent-components" ||
      pathname === "/artifacts/favorites" ||
      pathname === "/teams" ||
      pathname === "/projects/favorites" ||
      pathname === "/users" ||
      pathname === "/me";
    if (!supported) {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      unauthorized++;
      rejectUnauthorized(response);
      return true;
    }
    if (pathname === basePath) {
      writeApiResult(response, component);
    } else if (pathname === `${basePath}/frequency`) {
      if (unavailableFrequency) {
        response
          .writeHead(503, { "content-type": "application/json" })
          .end(
            JSON.stringify({ success: false, error: "Frequency unavailable" })
          );
      } else {
        writeApiResult(response, {
          windowDays: 30,
          points: [
            ...new Set(
              rows.map((row) => row.startedAt.toISOString().slice(0, 10))
            ),
          ]
            .sort()
            .map((day) => ({
              day,
              invocations: rows.filter((row) =>
                row.startedAt.toISOString().startsWith(day)
              ).length,
            })),
        });
      }
    } else if (pathname === "/agent-sessions") {
      const listUrl = listRequestUrl(url);
      const offset = Number(listUrl.searchParams.get("offset") ?? 0);
      if (listUrl.searchParams.has("componentSlug")) {
        reads.push({
          componentSlug: listUrl.searchParams.get("componentSlug"),
          offset,
          startDate: listUrl.searchParams.get("startDate"),
          statuses: listUrl.searchParams.getAll("statuses"),
        });
      }
      const cohort = filteredRows(listUrl);
      writeApiResult(response, {
        componentScope: component.slug,
        items: cohort.slice(offset, offset + 50),
        total: cohort.length,
        viewerScope: AgentSessionViewerScope.Organization,
      });
    } else if (pathname === "/agent-sessions/usage") {
      writeApiResult(response, {
        componentScope: component.slug,
        totalSessions: filteredRows(url).length,
        viewerScope: AgentSessionViewerScope.Organization,
      });
    } else if (pathname === "/agent-components") {
      writeApiResult(response, {
        items: [component],
        total: 1,
        hasMore: false,
      });
    } else if (pathname === "/users") {
      writeApiResult(response, [baseSession.user]);
    } else if (pathname === "/me") {
      writeApiResult(response, baseSession.user);
    } else {
      writeApiResult(response, []);
    }
    return true;
  };
  return { route, reads, unauthorized: () => unauthorized };
}

const baseSession = sessionDetailFixture();
const rows = Array.from({ length: 51 }, (_, index) => {
  const id =
    index === 0
      ? baseSession.id
      : `019ecbbf-691a-76ca-ba72-${String(index).padStart(12, "0")}`;
  return {
    ...baseSession,
    id,
    // Each session carries its own harness id, as real sessions do; inheriting
    // the base row's would make 50 rows claim session 1's identity.
    externalSessionId: index === 0 ? baseSession.externalSessionId : id,
    name: `Review session ${index + 1}`,
    status: index === 0 ? SESSION_STATUS.ERROR : SESSION_STATUS.INACTIVE,
    startedAt: new Date(
      Date.now() -
        Math.floor(index / 17) * 86_400_000 -
        3_600_000 -
        index * 60_000
    ),
    lastActivityAt: new Date(
      Date.now() -
        Math.floor(index / 17) * 86_400_000 -
        1_200_000 -
        index * 60_000
    ),
    updatedAt: new Date(
      Date.now() - Math.floor(index / 17) * 86_400_000 - index * 60_000
    ),
  };
});
const currentDefinition =
  "Review the implementation against the approved design and report concrete findings.";
const previousDefinition = "Review the approved design and report findings.";
const component: AgentComponentDetail = {
  id: "019ecbbf-691a-76ca-ba72-aa554ed9b152",
  slug: "subagent::design-critic",
  name: "Design Critic",
  kind: AgentComponentKind.Subagent,
  harness: Harness.Claude,
  sourceType: SourceType.Repo,
  source: "closedloop-ai/closedloop-ai",
  invocations: 51,
  sessions: 51,
  locPerDollar: null,
  trend: [],
  collaborators: [],
  computeTargetIds: [],
  firstSeenAt: "2026-10-01T00:00:00Z",
  lastSeenAt: "2026-10-19T00:00:00Z",
  properties: { path: ".claude/agents/design-critic.md", format: "md" },
  prompt: currentDefinition,
  versions: [
    {
      hash: "a".repeat(64),
      source: "closedloop-ai/closedloop-ai",
      format: "md",
      createdAt: "2026-10-19T00:00:00Z",
      isCurrent: true,
      content: currentDefinition,
    },
    {
      hash: "b".repeat(64),
      source: "closedloop-ai/closedloop-ai",
      format: "md",
      createdAt: "2026-10-01T00:00:00Z",
      isCurrent: false,
      content: previousDefinition,
    },
  ],
  resolvedState: ComponentResolvedState.Resolved,
  sessionsTab: rows.slice(0, 50),
  sessionsTabTruncated: true,
  branchesTab: [],
  branchesTabTruncated: false,
  provenance: [],
  // Branch-attributed usage with no hydrated branch rows: the state the
  // legacy ?tab=branches assertion reads ("Branch details unavailable").
  usageSessions: rows.map((row) => ({
    sessionId: row.id,
    branchName: "feat/design-review",
    invocationCount: 1,
  })),
  invocationRows: {
    items: [
      {
        id: "019ecbbf-691a-76ca-ba72-aa554ed9b153",
        externalInvocationId: "review-invocation",
        sessionId: baseSession.id,
        externalSessionId: baseSession.externalSessionId,
        sourceSessionId: baseSession.externalSessionId,
        kind: AgentComponentInvocationKind.Subagent,
        componentKey: "design-critic",
        relationship: AgentComponentInvocationRelationship.Associated,
        invokedAt: rows[0]?.startedAt.toISOString() ?? null,
        sequence: 1,
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Event,
          eventId: "event-review",
        },
        status: AgentComponentInvocationAttributionStatus.Matched,
        evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      },
    ],
    total: 1,
    hasMore: false,
    unmatchedCount: 0,
    ambiguousCount: 0,
  },
  locDelta: null,
  successRate: null,
  successDelta: null,
  tokenEfficiencyDelta: null,
  efficiencyTrend: [],
  mergedPrs: null,
  qualityScore: null,
  qualityDelta: null,
};
const agentRoute = `/agents/${encodeURIComponent(component.slug)}`;
const referenceMetrics =
  "metrics=components%2Cinvocations%2Cloc-dollar%2Cauthors";
const componentPath = `${agentRoute}?columns=owner%2Ccollaborators%2Cstatus%2CrelatedSessions%2Ccomments%2Cupdated%2CcurrentVersion%2Ctags%2Ccomponent-type%2Charness%2Cinvocations&${referenceMetrics}&tab=artifact`;
const revisionPattern = /Rev 1/;
const detailsPattern = /[?&]tab=details(?:&|$)/;
const sessionsPattern = /[?&]tab=sessions(?:&|$)/;
const optimizationPattern = /^Optimization/;
const sessionHrefPattern = /sessions\/019ecbbf-691a-76ca-ba72-aa554ed9b151/;
const traceHrefPattern =
  /sessions\/019ecbbf-691a-76ca-ba72-aa554ed9b151.*invocationAnchor=/;
const evidencePattern = /[?&]tab=evidence(?:&|$)/;

function filteredRows(url: URL) {
  const start = url.searchParams.get("startDate");
  const end = url.searchParams.get("endDate");
  const statuses = url.searchParams.getAll("statuses");
  return rows.filter(
    (row) =>
      (!start || row.lastActivityAt >= new Date(start)) &&
      (!end || row.lastActivityAt <= new Date(end)) &&
      (statuses.length === 0 || statuses.includes(row.status))
  );
}
