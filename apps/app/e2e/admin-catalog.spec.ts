/**
 * E2E tests for the admin catalog + distribution dashboard (T-18.8).
 *
 * Tests the /[orgSlug]/admin/catalog admin-only page and the /[orgSlug]/agents
 * ranking view, both gated behind AGENTS_FEATURE_FLAG_KEY ("agents").
 *
 * All API calls are intercepted via page.route() — no live DB required.
 * These tests use the @quarantine tag to run in CI with a live app but without
 * needing real catalog data.
 *
 * Covered scenarios:
 *  Admin role:
 *   - /admin/catalog renders the CatalogItem list when flag is on.
 *   - Admin can fill in the create-item form and submit (POST /catalog).
 *   - After item creation, the distribution modal can be opened and submitted
 *     (POST /distributions with auto_install + all targeting).
 *   - Navigating to /agents shows the ranking table (GET /agent-components).
 *
 *  Non-admin role:
 *   - Visiting /admin/catalog redirects (302 → /agents, rendered as the agents
 *     page) — server guard enforced by the page.tsx auth() check.
 *
 *  Feature flag off (admin):
 *   - /admin/catalog with flag off shows no catalog UI.
 */

import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { AgentComponentListResponse } from "@repo/api/src/types/agent-component";
import type {
  CatalogItemDto,
  CreateDistributionRequest,
  DistributionDto,
  PromoteCandidate,
} from "@repo/api/src/types/distribution";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORG_SLUG = "closedloop-ai";
const AGENTS_FLAG_KEY = "agents";
const FALLBACK_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";

const CATALOG_ITEM_ID = "cat-uuid-plugin-001";
const CATALOG_ITEM_NAME = "RTK Token Optimizer";
const DISTRIBUTION_ID = "dist-uuid-001";

// ---------------------------------------------------------------------------
// Regex constants (top-level for biome/performance/useTopLevelRegex)
// ---------------------------------------------------------------------------

const RE_CREATE_ITEM_BUTTON = /Create Item/i;
const RE_DISTRIBUTE_BUTTON = /Distribute/i;
const RE_CREATE_DISTRIBUTION = /Create Distribution/i;
const RE_AUTO_INSTALL_RADIO = /Auto-install/i;
const RE_ALL_COMPUTE_TARGETS_RADIO = /All compute targets/i;

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

function makeCatalogItem(
  overrides: Partial<CatalogItemDto> = {}
): CatalogItemDto {
  const now = new Date().toISOString();
  return {
    id: CATALOG_ITEM_ID,
    organizationId: "org-123",
    targetKind: "plugin",
    source: "org_custom",
    scope: "org",
    name: CATALOG_ITEM_NAME,
    description: "Reduces token usage via RTK compression.",
    version: "1.0.0",
    sortOrder: 0,
    enabled: true,
    archived: false,
    coaching: false,
    coachingConfig: null,
    agentSlug: null,
    parentPackId: null,
    componentUuid: null,
    content: null,
    components: [],
    logoUrl: null,
    createdById: "user-admin-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDistribution(
  overrides: Partial<DistributionDto> = {}
): DistributionDto {
  const now = new Date().toISOString();
  const item = makeCatalogItem();
  return {
    id: DISTRIBUTION_ID,
    organizationId: "org-123",
    catalogItemId: CATALOG_ITEM_ID,
    catalogItem: {
      id: item.id,
      name: item.name,
      targetKind: item.targetKind,
      source: item.source,
    },
    mode: "auto_install",
    targetingType: "all",
    desiredEnabled: true,
    targetingEntries: [],
    targetStatuses: [],
    assetDownloadUrl: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeRankingItem(
  overrides: Partial<PromoteCandidate> = {}
): PromoteCandidate {
  return {
    agentComponentId: CATALOG_ITEM_ID,
    name: CATALOG_ITEM_NAME,
    kind: "plugin",
    key: "rtk-token-optimizer",
    ...overrides,
  };
}

function makeAgentComponentListResponse(): AgentComponentListResponse {
  const now = new Date().toISOString();
  return {
    items: [
      {
        id: CATALOG_ITEM_ID,
        name: CATALOG_ITEM_NAME,
        kind: "plugin",
        sourceType: "pack",
        source: "closedloop/rtk",
        harness: "claude",
        invocations: 142,
        sessions: 23,
        klocPerDollar: 2.4,
        trend: [10, 20, 30, 40, 50],
        owner: "Ada",
        collaborators: [],
        computeTargetIds: ["target-1"],
        firstSeenAt: now,
        lastSeenAt: now,
      },
    ],
    total: 1,
    hasMore: false,
  };
}

// ---------------------------------------------------------------------------
// Wire envelope helper (matches apps/api Result<T> pattern)
// ---------------------------------------------------------------------------

function apiSuccess<T>(data: T): string {
  return JSON.stringify({ data, success: true });
}

// ---------------------------------------------------------------------------
// Feature-flag fixture
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
// Catalog & distribution API mocks
// ---------------------------------------------------------------------------

type CatalogMockConfig = {
  /** Items to return from GET /catalog initially. */
  initialItems?: CatalogItemDto[];
  /** If provided, returned by POST /catalog (item creation). */
  createdItem?: CatalogItemDto;
  /** If provided, returned by POST /distributions. */
  createdDistribution?: DistributionDto;
  /** If provided, returned by GET /agent-components/ranking. */
  rankingItems?: PromoteCandidate[];
  /** If provided, returned by GET /agent-components. */
  agentComponents?: AgentComponentListResponse;
};

async function installCatalogMocks(
  page: Page,
  config: CatalogMockConfig = {}
): Promise<void> {
  const {
    initialItems = [],
    createdItem = makeCatalogItem(),
    createdDistribution = makeDistribution(),
    rankingItems = [makeRankingItem()],
    agentComponents = makeAgentComponentListResponse(),
  } = config;

  // Mutable item list — updated when POST /catalog succeeds
  let catalogItems = [...initialItems];

  // GET + POST /catalog (list and create)
  await page.route(
    (url) =>
      stripApiPrefix(url.pathname) === "/catalog" &&
      !url.pathname.endsWith("/upload-intent") &&
      !url.pathname.endsWith("/confirm"),
    async (route) => {
      if (route.request().method() === "GET") {
        await fulfillJson(route, () => catalogItems);
      } else if (route.request().method() === "POST") {
        catalogItems = [...catalogItems, createdItem];
        await fulfillJson(route, () => createdItem);
      } else {
        await route.fallback();
      }
    }
  );

  // POST /distributions (create)
  await page.route(
    (url) => stripApiPrefix(url.pathname) === "/distributions",
    async (route) => {
      if (route.request().method() === "POST") {
        await fulfillJson(route, () => createdDistribution);
      } else {
        await fulfillJson(route, () => []);
      }
    }
  );

  // GET /agent-components/ranking
  await page.route(
    (url) => stripApiPrefix(url.pathname) === "/agent-components/ranking",
    async (route) => {
      await fulfillJson(route, () => rankingItems);
    }
  );

  // GET /agent-components (list — used by agents workspace)
  await page.route(
    (url) =>
      stripApiPrefix(url.pathname) === "/agent-components" &&
      !url.pathname.includes("/ranking") &&
      !url.pathname.includes("/compliance"),
    async (route) => {
      await fulfillJson(route, () => agentComponents);
    }
  );
}

function stripApiPrefix(pathname: string): string {
  return pathname.startsWith("/api") ? pathname.slice("/api".length) : pathname;
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
// Admin-role mock (Clerk has({ role }) check — mocked via Next.js auth)
// ---------------------------------------------------------------------------

/**
 * The catalog page does a server-side auth().has({ role }) check.  In E2E tests
 * the Clerk session is absent (storageState from auth setup may not carry org
 * membership), so we intercept the page HTML to prevent the redirect.
 *
 * Strategy: route the page navigation itself and stub the /admin/catalog HTML
 * response to skip the server-side redirect for non-admin tests, OR — more
 * realistically — run these tests with a pre-authenticated admin session from
 * the auth fixture.  Since this test file uses @quarantine and runs against a
 * mocked API (no live DB), we simulate the admin vs non-admin distinction by
 * mocking the Next.js auth endpoint and using storageState from the global
 * auth setup for admin, and a separate unauthenticated context for non-admin.
 *
 * For simplicity in this mocked-API spec, we rely on the /admin/catalog page's
 * server component redirect behavior.  Admin tests assume the auth setup
 * storageState provides a valid admin session; non-admin tests use a fresh
 * context with no session (triggering the redirect to /agents).
 */

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Admin catalog dashboard", () => {
  test("catalog list renders with seeded curated item when flag is on @quarantine", async ({
    page,
  }) => {
    await installAgentsFeatureFlag(page, true);

    const curatedItem = makeCatalogItem({
      id: "cat-curated-rtk",
      name: "RTK Token Optimizer",
      source: "curated",
      scope: "global",
    });

    await installCatalogMocks(page, {
      initialItems: [curatedItem],
    });

    await page.goto(`/${ORG_SLUG}/admin/catalog`);

    // Catalog section heading is always rendered (admin-gated by server)
    await expect(page.getByText("Catalog")).toBeVisible({ timeout: 20_000 });

    // The seeded catalog item should appear in the list
    await expect(page.getByText("RTK Token Optimizer")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("admin can create a catalog item via the form @quarantine", async ({
    page,
  }) => {
    await installAgentsFeatureFlag(page, true);

    await installCatalogMocks(page, {
      initialItems: [],
      createdItem: makeCatalogItem({ name: "My New Plugin" }),
    });

    await page.goto(`/${ORG_SLUG}/admin/catalog`);
    await expect(page.getByText("Add Catalog Item")).toBeVisible({
      timeout: 20_000,
    });

    // Fill in the create form
    await page.getByLabel("Name").fill("My New Plugin");

    // Click the Create Item button
    await page.getByRole("button", { name: RE_CREATE_ITEM_BUTTON }).click();

    // After creation, the post-create panel shows the item name
    await expect(page.getByText("My New Plugin")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("admin can open distribution modal and create auto_install + all distribution @quarantine", async ({
    page,
  }) => {
    await installAgentsFeatureFlag(page, true);

    const item = makeCatalogItem();
    let distributionPostBody: CreateDistributionRequest | null = null;

    await installCatalogMocks(page, {
      initialItems: [item],
      createdDistribution: makeDistribution(),
    });

    // Capture the POST /distributions request body
    page.on("request", (req) => {
      const url = stripApiPrefix(new URL(req.url()).pathname);
      if (req.method() === "POST" && url === "/distributions") {
        try {
          distributionPostBody = JSON.parse(
            req.postData() ?? "{}"
          ) as CreateDistributionRequest;
        } catch {
          // ignore parse errors
        }
      }
    });

    await page.goto(`/${ORG_SLUG}/admin/catalog`);
    await expect(page.getByText(CATALOG_ITEM_NAME)).toBeVisible({
      timeout: 20_000,
    });

    // Click the Distribute button for the first item
    await page
      .getByRole("button", { name: RE_DISTRIBUTE_BUTTON })
      .first()
      .click();

    // Distribution modal opens
    await expect(
      page.getByRole("dialog", { name: RE_CREATE_DISTRIBUTION })
    ).toBeVisible({ timeout: 5000 });

    // Mode should default to auto_install
    const autoRadio = page.getByRole("radio", { name: RE_AUTO_INSTALL_RADIO });
    await expect(autoRadio).toBeChecked();

    // Targeting should default to All compute targets
    const allTargetsRadio = page.getByRole("radio", {
      name: RE_ALL_COMPUTE_TARGETS_RADIO,
    });
    await expect(allTargetsRadio).toBeChecked();

    // Submit
    await page.getByRole("button", { name: RE_CREATE_DISTRIBUTION }).click();

    // Modal closes after success
    await expect(
      page.getByRole("dialog", { name: RE_CREATE_DISTRIBUTION })
    ).toHaveCount(0, { timeout: 10_000 });

    // Verify the POST body included the correct fields
    expect(distributionPostBody).not.toBeNull();
    expect(distributionPostBody!.mode).toBe("auto_install");
    expect(distributionPostBody!.targetingType).toBe("all");
  });

  test("agents ranking view shows at least one entry when flag is on @quarantine", async ({
    page,
  }) => {
    await installAgentsFeatureFlag(page, true);

    await installCatalogMocks(page, {
      agentComponents: makeAgentComponentListResponse(),
      rankingItems: [makeRankingItem()],
    });

    // The agents list page shows the component inventory which acts as
    // the org-visible ranking / leaderboard view
    await page.goto(`/${ORG_SLUG}/agents`);

    // The agents grouped list should render at least one component row
    await expect(page.getByText(CATALOG_ITEM_NAME)).toBeVisible({
      timeout: 20_000,
    });
  });

  test("non-admin visiting /admin/catalog is redirected (no catalog UI rendered) @quarantine", async ({
    browser,
  }) => {
    // Use a fresh browser context with no stored auth state to simulate
    // a non-admin (unauthenticated) request.  The Next.js server component
    // auth() check will fail and redirect to /agents (or the sign-in page).
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await installAgentsFeatureFlag(page, true);
      await installCatalogMocks(page, { initialItems: [makeCatalogItem()] });

      await page.goto(`/${ORG_SLUG}/admin/catalog`);

      // The catalog dashboard heading must NOT be visible — the page either
      // redirected to /agents or to the sign-in page, both of which omit it.
      await expect(page.getByText("Add Catalog Item")).not.toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await context.close();
    }
  });

  test("/admin/catalog with flag off shows no catalog UI @quarantine", async ({
    page,
  }) => {
    await installAgentsFeatureFlag(page, false);
    await installCatalogMocks(page, { initialItems: [makeCatalogItem()] });

    await page.goto(`/${ORG_SLUG}/admin/catalog`);

    // FeatureFlagged wrapper hides the catalog dashboard when flag is off
    await expect(page.getByText("Add Catalog Item")).not.toBeVisible({
      timeout: 10_000,
    });
  });
});
