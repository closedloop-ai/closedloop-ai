/**
 * FEA-4032: launched-Electron regression for the shared Agents Type treatment.
 *
 * The desktop renderer mounts the same `AgentsTable` as the web app, but its
 * responsive boundary is a real Electron window: the wide layout renders Type
 * in the grid, while a narrow window promotes the same Type renderer into each
 * card header. This spec covers both paths against the app's real local SQLite
 * inventory rather than mounting either component in isolation.
 *
 * Skill and Memory & config are deliberately different legacy cases. Skill was
 * a colored `ToneLabel` (`info`); Memory & config used the outline/uncolored
 * treatment. FEA-4032 makes both use one muted icon + label presentation while
 * leaving the adjacent Harness value as its filled `HarnessBadge`.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run with a fresh CODEX_HOME:
 *     `CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e -- agents-type-presentation.spec.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component.ts";
import {
  gotoNav,
  launchDesktopApp,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  type AgentComponentProvenanceSeed,
  seedAgentComponents,
  waitForAgentComponentsSchema,
} from "./helpers/seed-agent-components-db";

const WIDE_VIEWPORT = { height: 900, width: 1380 };
const NARROW_VIEWPORT = { height: 900, width: 640 };
const MOUNT_TIMEOUT_MS = 30_000;
const AGENTS_SEARCH_LABEL = "Search components";
const SEEDED_SEARCH_NEEDLE = "fea-4032-";
const TYPE_COLUMN_SELECTOR = '[data-column-id="type"]';
const HARNESS_COLUMN_SELECTOR = '[data-column-id="harness"]';
const BADGE_SELECTOR = '[data-slot="badge"]';
const CARD_SELECTOR = '[data-slot="card"]:visible';
const TRUNCATE_CLASS_PATTERN = /(?:^|\s)truncate(?:\s|$)/;

type PresentationCase = {
  componentName: string;
  harnessLabel: string;
  kindLabel: string;
};

const PRESENTATION_CASES: readonly PresentationCase[] = [
  {
    componentName: "fea-4032-colored-skill",
    harnessLabel: "Claude",
    kindLabel: "Skill",
  },
  {
    componentName: "fea-4032-outline-config",
    harnessLabel: "Codex",
    kindLabel: "Memory & config",
  },
];

const SEEDED_COMPONENTS: AgentComponentProvenanceSeed[] = [
  {
    componentKind: AgentComponentKind.Skill,
    externalId: PRESENTATION_CASES[0].componentName,
    harness: Harness.Claude,
    id: "fea-4032-colored-skill",
  },
  {
    componentKind: AgentComponentKind.Config,
    externalId: PRESENTATION_CASES[1].componentName,
    harness: Harness.Codex,
    id: "fea-4032-outline-config",
  },
];

test.describe("Agents Type presentation (FEA-4032)", () => {
  test("uses the uniform muted icon label beside the unchanged filled Harness badge in the wide grid and narrow cards", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(async (page) => {
      await openSeededAgentsCatalog(page);

      const typeHeader = page.locator(
        `[role="columnheader"]${TYPE_COLUMN_SELECTOR}`
      );
      await expect(typeHeader).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

      for (const presentationCase of PRESENTATION_CASES) {
        const row = gridRow(page, presentationCase.componentName);
        await expect(row).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await assertKindPresentation(
          row.locator(`[role="cell"]${TYPE_COLUMN_SELECTOR}`),
          presentationCase.kindLabel
        );
        await assertFilledHarnessBadge(
          row.locator(`[role="cell"]${HARNESS_COLUMN_SELECTOR}`),
          presentationCase.harnessLabel
        );
      }

      await page.setViewportSize(NARROW_VIEWPORT);

      // The responsive assertion is load-bearing: without it a stale wide grid
      // could satisfy the label checks and this test would never exercise the
      // AgentCard header path the ticket explicitly covers.
      await expect(typeHeader).toHaveCount(0);

      for (const presentationCase of PRESENTATION_CASES) {
        const card = agentCard(page, presentationCase.componentName);
        await expect(card).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await assertKindPresentation(card, presentationCase.kindLabel);

        const harnessTerm = card.locator("dt").filter({ hasText: "Harness" });
        await expect(harnessTerm).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(harnessTerm).toHaveText("Harness");
        const harnessValue = harnessTerm.locator("xpath=following-sibling::dd");
        await assertFilledHarnessBadge(
          harnessValue,
          presentationCase.harnessLabel
        );
      }
    });
  });
});

/** Navigate to the seeded Agents inventory in its expanded desktop layout. */
async function openSeededAgentsCatalog(page: Page): Promise<void> {
  await page.setViewportSize(WIDE_VIEWPORT);
  await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
  await gotoNav(page, "agents");
  const search = page.getByLabel(AGENTS_SEARCH_LABEL);
  await expect(search).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await search.fill(SEEDED_SEARCH_NEEDLE);
}

/** One expanded-grid row, selected by its unique seeded component name. */
function gridRow(page: Page, componentName: string): Locator {
  return page.getByRole("row").filter({ hasText: componentName });
}

/** One responsive AgentCard, excluding unrelated page-level metric cards. */
function agentCard(page: Page, componentName: string): Locator {
  return page.locator(CARD_SELECTOR).filter({ hasText: componentName });
}

/**
 * Assert the exact shared `KindLabel` contract through rendered Electron DOM.
 *
 * The class tokens pin the design-system vocabulary while the computed icon
 * size proves the built stylesheet actually realizes `size-3.5` as 14px. The
 * badge absence distinguishes the new treatment from every former Type path.
 */
async function assertKindPresentation(
  container: Locator,
  kindLabel: string
): Promise<void> {
  const label = container.getByText(kindLabel, { exact: true });
  await expect(label).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await expect(label).toHaveClass(TRUNCATE_CLASS_PATTERN);

  const wrapper = label.locator("xpath=..");
  const wrapperClasses = await wrapper.evaluate((element) => [
    ...element.classList,
  ]);
  expect(wrapperClasses).toEqual(
    expect.arrayContaining([
      "flex",
      "min-w-0",
      "items-center",
      "gap-1.5",
      "text-muted-foreground",
      "text-xs",
      "font-medium",
    ])
  );

  const icon = wrapper.locator('svg[aria-hidden="true"]');
  await expect(icon).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  const iconPresentation = await icon.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      flexShrink: style.flexShrink,
      height: style.height,
      width: style.width,
    };
  });
  expect(iconPresentation).toEqual({
    flexShrink: "0",
    height: "14px",
    width: "14px",
  });

  await expect(wrapper.locator(BADGE_SELECTOR)).toHaveCount(0);
}

/** Prove Harness kept its existing filled pill in the same row/card. */
async function assertFilledHarnessBadge(
  container: Locator,
  harnessLabel: string
): Promise<void> {
  const badge = container
    .locator(BADGE_SELECTOR)
    .filter({ hasText: harnessLabel });
  await expect(badge).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await expect(badge).toHaveText(harnessLabel);
  const backgroundColor = await badge.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  expect(backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(backgroundColor).not.toBe("transparent");
}

/**
 * Launch twice against one isolated profile: migrate, seed while stopped, then
 * relaunch so the production local component source reads the rows at boot.
 */
async function withSeededDesktopProfile(
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fea-4032-claude-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "fea-4032-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fea-4032-udd-"));

  try {
    const first = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForAgentComponentsSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedAgentComponents(userDataDir, SEEDED_COMPONENTS);

    const { page, cleanup } = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await run(page);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
}
