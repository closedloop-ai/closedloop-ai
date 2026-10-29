import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { DocumentType } from "@repo/api/src/types/document.ts";
import type { DocumentCostsRequest } from "@repo/api/src/types/document-costs.ts";
import { formatCostPreciseOrDash } from "@repo/app/shared/lib/format-utils.ts";
import {
  answerCosts,
  answerList,
  answerSummary,
  CARD_LABELS,
  expectedCards,
  FACET_SCOPES,
  FAVORITE_IDS,
  FIELD_NAME,
  favoriteArtifact,
  LANE_ALPHA,
  LANE_FIELD,
  LIST_PAGE_SIZE,
  OWNER_A_NAME,
  OWNER_B_NAME,
  OWNERS,
  POPULATION_SIZE,
  parseCostsRequest,
  ScopeFacet,
  TAG_BLUE_NAME,
} from "../../../../e2e/helpers/documents-summary-scope-population.ts";
import {
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  closeServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { gotoHash } from "./helpers/desktop-app";
import {
  currentHashRoute,
  launchShellSidebarApp,
  seedShellSidebarSession,
  startNavigationCloudServer,
} from "./helpers/shell-navigation-cloud";

/**
 * ISS-12600 — the Documents index cards over the FULL filtered population,
 * through the launched Electron app (`DocumentsIndexSurface` on the desktop
 * host and the real renderer-to-cloud read path).
 *
 * The stand-in cloud computes every `/documents`, `/documents/summary` and
 * `/documents/costs` answer from the scope the request carries
 * (`e2e/helpers/documents-summary-scope-population.ts`), so a card fed loaded
 * row ids, or a scope the cloud does not honor, reads a different figure than
 * the population's. Each facet matches more rows than one list page. The web
 * twin is `e2e/documents-summary-scope.spec.ts`.
 */

// Canonical PostHog keys; Electron specs cannot load extensionless workspace subpaths.
const FLAGS = {
  labsNav: true,
  "documents-nav": true,
  "shell-sidebar-v2": true,
  "documents-universal-list": true,
  "artifact-list-summary": true,
};
const FILTERS_BUTTON_LABEL = "Filters";
const CLEAR_FILTERS_LABEL = "Clear filters";
const NEXT_PAGE_LABEL = "Go to next page";
const ROW_TITLE_PATTERN = /Scope population document \d{3}/;
const CARD_TIMEOUT_MS = 30_000;
const FAVORITES_MENU_ITEM = "Favorites";
const OWNER_MENU_ITEM = "Owner";
const TAGS_MENU_ITEM = "Tags";

type CardRequests = {
  summaries: URL[];
  costs: DocumentCostsRequest[];
};

test("the five Documents cards stay on the full population through filter and page changes", async () => {
  test.setTimeout(240_000);
  const requests: CardRequests = { summaries: [], costs: [] };
  const server = await startNavigationCloudServer({
    featureFlags: FLAGS,
    extraRoutes: (request, response) =>
      routePopulation(request, response, requests),
  });
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-documents-scope-")
  );
  try {
    await seedShellSidebarSession(userDataDir);
    const { page, pageErrors, cleanup } = await launchShellSidebarApp({
      apiOrigin: server.origin,
      flags: FLAGS,
      profileId: "documents-scope",
      profileName: "Documents scope E2E",
      userDataDir,
    });
    try {
      await gotoHash(page, "/dashboard");
      await page.getByRole("link", { name: "Documents", exact: true }).click();
      await expect.poll(() => currentHashRoute(page)).toBe("/documents");
      await expectCards(page, expectedCards({}));

      for (const facet of Object.values(ScopeFacet)) {
        const summaryMark = requests.summaries.length;
        const costMark = requests.costs.length;
        await applyFacet(page, facet);

        const expected = expectedCards(FACET_SCOPES[facet]);
        expect(expected.count).toBeGreaterThan(LIST_PAGE_SIZE);
        expect(expected.count).toBeLessThan(POPULATION_SIZE);
        await expectCards(page, expected);

        // Reading row ids instead of a scope is the defect, so no filtered
        // read may name `artifactIds` and each carries the facet as a scope.
        const summaries = requests.summaries.slice(summaryMark);
        const costs = requests.costs.slice(costMark);
        expect(summaries.length).toBeGreaterThan(0);
        expect(costs.length).toBeGreaterThan(0);
        for (const url of summaries) {
          expect(url.searchParams.has("artifactIds")).toBe(false);
        }
        for (const body of costs) {
          expect(body.artifactIds).toEqual([]);
          expect(body.scope?.artifactIds).toBeUndefined();
        }
        expectScopeOnTheWire(facet, summaries.at(-1), costs.at(-1));

        if (facet === ScopeFacet.Tags) {
          const firstPageRows = await rowTitles(page);
          await page.getByLabel(NEXT_PAGE_LABEL).click();
          await expect.poll(() => rowTitles(page)).not.toEqual(firstPageRows);
          await expectCards(page, expected);
        }

        await page.getByRole("button", { name: CLEAR_FILTERS_LABEL }).click();
        await expectCards(page, expectedCards({}));
      }
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await closeServer(server.server);
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
});

function routePopulation(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CardRequests
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  switch (url.pathname) {
    case "/desktop/identity":
      writeApiResult(response, {
        userId: AUTHENTICATED_USER_ID,
        organizationId: AUTHENTICATED_ORGANIZATION_ID,
        email: "ada@closedloop.ai",
        firstName: "Ada",
        lastName: "Lovelace",
        organizationName: "Closedloop",
        organizationSlug: "closedloop-ai",
      });
      return true;
    case "/documents":
      writeApiResult(response, answerList(url));
      return true;
    case "/documents/summary":
      requests.summaries.push(url);
      writeApiResult(response, answerSummary(url));
      return true;
    case "/documents/costs":
      readJsonBody(request, (raw) => {
        const body = parseCostsRequest(raw);
        requests.costs.push(body);
        writeApiResult(response, answerCosts(body));
      });
      return true;
    case "/custom-fields":
      writeApiResult(response, [LANE_FIELD]);
      return true;
    case "/artifacts/favorites":
      writeApiResult(response, FAVORITE_IDS.map(favoriteArtifact));
      return true;
    case "/artifacts/related-sessions":
      writeApiResult(response, { results: {} });
      return true;
    case "/users":
      writeApiResult(response, OWNERS);
      return true;
    case "/projects":
      writeApiResult(response, []);
      return true;
    default:
      return false;
  }
}

function readJsonBody(
  request: IncomingMessage,
  onBody: (raw: unknown) => void
): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () =>
    onBody(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  );
}

async function applyFacet(page: Page, facet: ScopeFacet): Promise<void> {
  await page.getByRole("button", { name: FILTERS_BUTTON_LABEL }).click();
  const menu = page.getByRole("menu").first();
  switch (facet) {
    case ScopeFacet.Favorites:
      await menu.getByRole("menuitem", { name: FAVORITES_MENU_ITEM }).click();
      break;
    case ScopeFacet.Tags:
      await menu.getByRole("menuitem", { name: TAGS_MENU_ITEM }).click();
      await submenuOption(page, TAG_BLUE_NAME).click();
      break;
    case ScopeFacet.Owners:
      await menu.getByRole("menuitem", { name: OWNER_MENU_ITEM }).click();
      await submenuOption(page, OWNER_A_NAME).click();
      await submenuOption(page, OWNER_B_NAME).click();
      break;
    case ScopeFacet.CustomField:
      await menu.getByRole("menuitem", { name: FIELD_NAME }).click();
      await submenuOption(page, LANE_ALPHA).click();
      break;
    default:
      throw new Error(`Unhandled facet ${String(facet satisfies never)}`);
  }
  await page.keyboard.press("Escape");
}

function submenuOption(page: Page, label: string) {
  return page.getByRole("menu").last().getByText(label, { exact: true });
}

async function rowTitles(page: Page): Promise<string[]> {
  return (await page.getByText(ROW_TITLE_PATTERN).allInnerTexts()).sort();
}

async function expectCards(
  page: Page,
  expected: ReturnType<typeof expectedCards>
): Promise<void> {
  const readings: [string, string][] = [
    [CARD_LABELS.documents, String(expected.count)],
    [CARD_LABELS.updatedThisWeek, String(expected.updatedThisWeek)],
    [CARD_LABELS.producedBySessions, String(expected.producedBySessions)],
    [CARD_LABELS.totalCost, formatCostPreciseOrDash(expected.totalCost)],
    [CARD_LABELS.medianCost, formatCostPreciseOrDash(expected.medianCost)],
  ];
  for (const [label, value] of readings) {
    await expect(cardValue(page, label)).toHaveText(value, {
      timeout: CARD_TIMEOUT_MS,
    });
  }
}

function cardValue(page: Page, label: string) {
  return page
    .locator('[data-slot="card"]')
    .filter({
      has: page.locator('[data-slot="card-description"]', { hasText: label }),
    })
    .locator('[data-slot="card-title"]');
}

function expectScopeOnTheWire(
  facet: ScopeFacet,
  summary: URL | undefined,
  costs: DocumentCostsRequest | undefined
): void {
  const scope = FACET_SCOPES[facet];
  expect(summary).toBeDefined();
  expect(costs?.scope).toMatchObject(scope);
  expect(summary?.searchParams.getAll("tagIds")).toEqual(scope.tagIds ?? []);
  expect(summary?.searchParams.getAll("assigneeIds")).toEqual(
    scope.assigneeIds ?? []
  );
  expect(summary?.searchParams.get("favoritesOnly")).toBe(
    scope.favoritesOnly ? "true" : null
  );
  expect(summary?.searchParams.get("customFieldFilters")).toBe(
    scope.customFieldFilters ? JSON.stringify(scope.customFieldFilters) : null
  );
  expect(summary?.searchParams.getAll("types")).toContain(DocumentType.Doc);
}
