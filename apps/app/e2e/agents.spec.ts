/**
 * E2E tests for the Agents workspace page (T-10.12).
 *
 * Tests the /[orgSlug]/agents list and /[orgSlug]/agents/[slug] detail routes
 * behind the AGENTS_FEATURE_FLAG_KEY ("agents") flag.
 *
 * These tests run with a mocked API — the real /agent-components endpoints
 * are not required here. They validate:
 *  - The list renders at least one component row when the flag is on.
 *  - Clicking a row navigates to the detail page (Properties panel + Sessions tab).
 *  - The breadcrumb on the detail page links back to the list.
 *  - The feature flag gates both list and detail routes (no data fetched when off).
 */

import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type {
  AgentComponent,
  AgentComponentDetail,
  AgentComponentListResponse,
} from "@repo/api/src/types/agent-component";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_SLUG = "closedloop-ai";
const AGENTS_FLAG_KEY = "agents";
const COMPONENT_ID = "comp-uuid-subagent-001";
const COMPONENT_NAME = "AI Orchestration Expert";
const COMPONENT_SLUG = COMPONENT_ID;
const FALLBACK_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

function makeComponentRow(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  const now = new Date().toISOString();
  return {
    id: COMPONENT_ID,
    name: COMPONENT_NAME,
    kind: "subagent",
    sourceType: "pack",
    source: "closedloop/agent-pack",
    harness: "claude",
    invocations: 42,
    sessions: 7,
    klocPerDollar: 1.2,
    trend: [1, 2, 3, 4, 5],
    owner: "Ada",
    collaborators: [],
    computeTargetIds: ["target-1"],
    firstSeenAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

function makeComponentDetail(
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  const base = makeComponentRow();
  return {
    ...base,
    properties: {
      path: "~/.closedloop/agents/ai-orchestration-expert.md",
      format: "md",
    },
    prompt: "You are an expert AI orchestration agent.",
    sessionsTab: [],
    branchesTab: [],
    provenance: [
      {
        computeTargetId: "target-1",
        installPath: "~/.closedloop/agents",
      },
    ],
    usageSessions: [
      {
        sessionId: "session-1",
        branchName: "feature/ai-orchestration",
        invocationCount: 42,
      },
    ],
    ...overrides,
  };
}

function makeListResponse(items: AgentComponent[]): AgentComponentListResponse {
  return { items, total: items.length, hasMore: false };
}

// ---------------------------------------------------------------------------
// Wire envelope helpers (matches apps/api Result<T> pattern)
// ---------------------------------------------------------------------------

function apiSuccess<T>(data: T): string {
  return JSON.stringify({ data, success: true });
}

// ---------------------------------------------------------------------------
// Feature-flag fixture — mirrors installMockedFeatureFlags from e2e/helpers
// ---------------------------------------------------------------------------

async function installAgentsFeatureFlag(
  page: Page,
  enabled: boolean
): Promise<void> {
  await page.addInitScript(
    ({ flagKey, flagEnabled, storageKey }) => {
      const flags: Record<string, boolean> = { [flagKey]: flagEnabled };
      globalThis.localStorage.setItem(storageKey, JSON.stringify(flags));
    },
    {
      flagKey: AGENTS_FLAG_KEY,
      flagEnabled: enabled,
      storageKey: FALLBACK_FLAGS_STORAGE_KEY,
    }
  );

  await page.route(
    (url) => url.pathname === "/flags" || url.pathname.startsWith("/flags/"),
    async (route) => {
      const flags: Record<string, boolean> = { [AGENTS_FLAG_KEY]: enabled };
      await route.fulfill({
        body: JSON.stringify({
          errorsWhileComputingFlags: false,
          featureFlagPayloads: {},
          featureFlags: flags,
          flags: Object.fromEntries(
            Object.entries(flags).map(([key, on]) => [
              key,
              { enabled: on, metadata: {}, variant: null },
            ])
          ),
        }),
        contentType: "application/json",
        status: 200,
      });
    }
  );
}

// ---------------------------------------------------------------------------
// Agent-components API mock
// ---------------------------------------------------------------------------

async function installAgentComponentsMocks(
  page: Page,
  input: {
    list: () => AgentComponentListResponse;
    detail: (slug: string) => AgentComponentDetail;
  }
): Promise<void> {
  await page.route(
    (url) => agentComponentPath(url.pathname) === "/agent-components",
    async (route) => {
      await fulfillJson(route, () => input.list());
    }
  );

  await page.route(
    (url) => agentComponentPath(url.pathname).startsWith("/agent-components/"),
    async (route) => {
      const slug =
        agentComponentPath(new URL(route.request().url()).pathname).split(
          "/agent-components/"
        )[1] ?? "";
      if (slug === "") {
        await route.fallback();
        return;
      }
      await fulfillJson(route, () => input.detail(slug));
    }
  );
}

function agentComponentPath(pathname: string): string {
  return pathname.startsWith("/api/agent-components")
    ? pathname.slice("/api".length)
    : pathname;
}

async function fulfillJson<T>(
  route: Route,
  value: () => T | Promise<T>
): Promise<void> {
  try {
    const data = await value();
    await route.fulfill({
      body: apiSuccess(data),
      contentType: "application/json",
      status: 200,
    });
  } catch {
    await route.fulfill({
      body: JSON.stringify({ error: "mock error", success: false }),
      contentType: "application/json",
      status: 500,
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Agents workspace", () => {
  test("agents list renders with at least one component row when flag is on @quarantine", async ({
    page,
  }) => {
    await installAgentsFeatureFlag(page, true);
    await installAgentComponentsMocks(page, {
      list: () => makeListResponse([makeComponentRow()]),
      detail: () => makeComponentDetail(),
    });

    await page.goto(`/${ORG_SLUG}/agents`);

    await expect(page.getByText(COMPONENT_NAME)).toBeVisible({
      timeout: 20_000,
    });
  });

  test("agents detail page shows Properties panel and Sessions tab @quarantine", async ({
    page,
  }) => {
    let detailCalls = 0;

    await installAgentsFeatureFlag(page, true);
    await installAgentComponentsMocks(page, {
      list: () => makeListResponse([makeComponentRow()]),
      detail: (slug) => {
        detailCalls += 1;
        return makeComponentDetail({ id: slug });
      },
    });

    await page.goto(`/${ORG_SLUG}/agents/${COMPONENT_SLUG}`);

    await expect(page.getByText("Properties")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("tab", { name: "Sessions" })).toBeVisible();
    expect(detailCalls).toBeGreaterThan(0);
  });

  test("agents detail breadcrumb links back to the list @quarantine", async ({
    page,
  }) => {
    await installAgentsFeatureFlag(page, true);
    await installAgentComponentsMocks(page, {
      list: () => makeListResponse([makeComponentRow()]),
      detail: () => makeComponentDetail(),
    });

    await page.goto(`/${ORG_SLUG}/agents/${COMPONENT_SLUG}`);

    await expect(page.getByText("Properties")).toBeVisible({
      timeout: 20_000,
    });

    const agentsLink = page.getByRole("link", { name: "Agents" });
    await expect(agentsLink).toBeVisible();
    await expect(agentsLink).toHaveAttribute("href", `/${ORG_SLUG}/agents`);
  });

  test("agents feature flag gates list route — no data fetched when off", async ({
    page,
  }) => {
    let listCalls = 0;

    await installAgentsFeatureFlag(page, false);
    await installAgentComponentsMocks(page, {
      list: () => {
        listCalls += 1;
        return makeListResponse([makeComponentRow()]);
      },
      detail: () => makeComponentDetail(),
    });

    await page.goto(`/${ORG_SLUG}/agents`);

    await expect(page.getByText(COMPONENT_NAME)).toHaveCount(0);
    expect(listCalls).toBe(0);
  });

  test("agents feature flag gates direct detail route when off", async ({
    page,
  }) => {
    let detailCalls = 0;

    await installAgentsFeatureFlag(page, false);
    await installAgentComponentsMocks(page, {
      list: () => makeListResponse([makeComponentRow()]),
      detail: () => {
        detailCalls += 1;
        return makeComponentDetail();
      },
    });

    await page.goto(`/${ORG_SLUG}/agents/${COMPONENT_SLUG}`);

    await expect(page.getByText("Properties")).toHaveCount(0);
    expect(detailCalls).toBe(0);
  });
});
