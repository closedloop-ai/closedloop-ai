/**
 * ISS-8933: a component that lives on a LATER PAGE of the local inventory
 * reaches the rendered Agents workspace on DESKTOP, through the real adapter
 * chain. Web twin: `e2e/agents-inventory-later-page.spec.ts`.
 *
 * WHY THIS EXISTS. ISS-6891 (#6483) changed visible inventory totals, facet
 * counts and summary aggregates by reading the component population to
 * COMPLETION instead of keeping the first page, and every suite that landed with
 * it stops at a mocked boundary —
 * `agent-components-page-data-local-paging.test.ts` doubles the local page
 * reader by its own admission ("Reproducing the boundary with a real store would
 * mean seeding past 5,000 rows"), and the renderer suites double
 * `window.desktopApi.db.listAgentComponents` outright. So a regression in the
 * desktop IPC handler — the `limit`/`offset` slice, the `total` it reports, or
 * the `hasMore` derived from them — restores first-page truncation with every
 * unit suite green.
 *
 * This spec pays that seeding cost once, and it is the only place the cost buys
 * anything: the real preload channel, `coerceAgentComponentFilters`,
 * `listAgentComponentsLocal` over a real migrated SQLite store, the shared
 * `collectComponentPopulation` follower, and the summary reduction all run
 * against a population that genuinely exceeds one page.
 *
 * WHAT MAKES IT ABLE TO FAIL. The corpus is one page PLUS eleven rows, and the
 * last of them is the only `subagent` in it, named to sort last by the reader's
 * own `name.localeCompare` ordering. It is therefore absent from the first page,
 * absent from the first RENDERED page, and present only if the reader followed
 * the continuation — so the Components card's count and the row itself both go
 * red under a first-page-only read, and the card's count cannot be satisfied by
 * the rows on screen.
 *
 * The time window is left at its default ("All"), which sends no `startDate`:
 * with no window there is no zero-in-window drop, so usage-less seed rows are a
 * legitimate inventory rather than a population the reader would filter away.
 *
 * `AGENT_COMPONENT_INVENTORY_CAP` comes from its canonical module rather than
 * being restated — `@repo/api/src/types/*.ts` resolves under Playwright's ESM
 * loader (eighteen sibling specs import from it), unlike a `@repo/app/...`
 * subpath, whose failure aborts the whole desktop-e2e suite at load.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run with a fresh CODEX_HOME:
 *     `CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e -- agents-inventory-later-page.spec.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component.ts";
import {
  gotoNavSettled,
  launchDesktopApp,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  type AgentComponentProvenanceSeed,
  seedAgentComponents,
  waitForAgentComponentsSchema,
} from "./helpers/seed-agent-components-db";

/** Wide enough that `GridTable` renders the grid, not the sub-`md` card list. */
const WIDE_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 60_000;
const AGENTS_NAV_ID = "agents";
const AGENTS_SEARCH_LABEL = "Search components";
const COMPONENTS_CARD_LABEL = "Components";
const CARD_SELECTOR = '[data-slot="card"]';
const CARD_VALUE_SELECTOR = '[data-slot="card-title"]';

/**
 * One page PLUS a remainder, derived from the shared bound rather than a literal
 * so the corpus keeps crossing the boundary if that value is retuned. Eleven,
 * not one: a remainder of one is equally consistent with an off-by-one, and this
 * reads as a second page.
 */
const POPULATION_SIZE = AGENT_COMPONENT_INVENTORY_CAP + 11;

/** How many rows go into one seed batch, rather than all of them in one. */
const SEED_CHUNK_SIZE = 500;

/**
 * The later-page row. `zz-` so it sorts last under the reader's own
 * `collapsed.sort((a, b) => a.name.localeCompare(b.name))`, and `subagent` so it
 * is the only component of its kind — a kind facet counted over the first page
 * alone reports zero of them.
 */
const MARKER_NAME = "zz-iss-8933-late-page-marker";
const SOURCE_URL = "https://github.com/acme/iss-8933-pack";

/** The count the card must print once the whole population has been read. */
const POPULATION_TEXT = POPULATION_SIZE.toLocaleString("en-US");

test.describe("Agents inventory, later-page component (ISS-8933)", () => {
  test("counts a later-page component in the inventory total", async () => {
    test.setTimeout(600_000);

    await withSeededDesktopProfile("iss-8933-total", async (page) => {
      const panel = await openSeededAgentsCatalog(page);

      // The card states the whole local population, not the page it rendered.
      await expect(componentsCardValue(panel)).toHaveText(POPULATION_TEXT, {
        timeout: MOUNT_TIMEOUT_MS,
      });

      // And the marker really is a LATER-page row: it is not among the rows on
      // screen, so the count above cannot have come from the rendered set.
      await expect(catalogRow(panel, MARKER_NAME)).toHaveCount(0);
    });
  });

  test("finds a later-page component in the rendered inventory", async () => {
    test.setTimeout(600_000);

    await withSeededDesktopProfile("iss-8933-marker", async (page) => {
      const panel = await openSeededAgentsCatalog(page);

      // Anchor on the settled population first, so the narrowing below runs
      // against a list that finished loading rather than an empty one.
      await expect(componentsCardValue(panel)).toHaveText(POPULATION_TEXT, {
        timeout: MOUNT_TIMEOUT_MS,
      });

      const search = panel.getByLabel(AGENTS_SEARCH_LABEL);
      await expect(search).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await search.fill(MARKER_NAME);

      // The narrowing runs over the population the reader holds, so the row can
      // only render if the later page was read — and the card re-counts the same
      // narrowed set, which is the summary aggregate half of the same claim.
      await expect(catalogRow(panel, MARKER_NAME)).toHaveCount(1, {
        timeout: MOUNT_TIMEOUT_MS,
      });
      await expect(componentsCardValue(panel)).toHaveText("1");
    });
  });
});

// ---------------------------------------------------------------------------
// Surface helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to the Agents workspace and return the panel the shell COMMITTED to.
 *
 * The boot-window gate (`waitForLocalAgentComponentList`) comes first — the
 * disabled boot responder's empty list is cached by the query client, so
 * navigating early pins a permanently empty workspace. The viewport is set
 * BEFORE navigating so `GridTable`'s own measurement reports the intended width
 * on its first pass. Every locator below is scoped to the returned panel,
 * because keep-alive leaves sibling views mounted and Dashboard also renders
 * summary cards.
 */
async function openSeededAgentsCatalog(page: Page): Promise<Locator> {
  await page.setViewportSize(WIDE_VIEWPORT);
  await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
  return await gotoNavSettled(page, AGENTS_NAV_ID, MOUNT_TIMEOUT_MS);
}

/** The Components summary card's own value, never a count rendered elsewhere. */
function componentsCardValue(panel: Locator): Locator {
  return panel
    .locator(CARD_SELECTOR)
    .filter({ hasText: COMPONENTS_CARD_LABEL })
    .first()
    .locator(CARD_VALUE_SELECTOR);
}

/** The catalog grid row that owns `componentName`. */
function catalogRow(panel: Locator, componentName: string): Locator {
  return panel.getByRole("row").filter({ hasText: componentName });
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** The filler rows, then the single later-page marker that sorts after them. */
function seededComponents(): AgentComponentProvenanceSeed[] {
  const fillers = Array.from(
    { length: POPULATION_SIZE - 1 },
    (_unused, index) =>
      seedRow(
        `iss-8933-filler-${String(index).padStart(5, "0")}`,
        AgentComponentKind.Skill
      )
  );
  return [...fillers, seedRow(MARKER_NAME, AgentComponentKind.Subagent)];
}

function seedRow(name: string, kind: string): AgentComponentProvenanceSeed {
  return {
    componentKind: kind,
    externalId: name,
    harness: Harness.Claude,
    id: name,
    sourceUrl: SOURCE_URL,
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Launch twice against one isolated profile: migrate, seed while stopped, then
 * relaunch so the production local component source reads the rows at boot.
 *
 * The corpus is written in chunks rather than as one batch of five thousand
 * statements — the substrate contract is per-batch, and a batch that large is a
 * single transaction whose failure mode is the whole corpus rather than one
 * chunk.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only inventory rows are the seeded ones.
 */
async function withSeededDesktopProfile(
  prefix: string,
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

  try {
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForAgentComponentsSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    const components = seededComponents();
    for (let at = 0; at < components.length; at += SEED_CHUNK_SIZE) {
      await seedAgentComponents(
        userDataDir,
        components.slice(at, at + SEED_CHUNK_SIZE)
      );
    }

    const { page, cleanup } = await launchDesktopApp({
      env,
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
