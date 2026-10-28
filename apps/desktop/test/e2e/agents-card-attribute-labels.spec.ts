/**
 * Native narrow-shell regression: the seeded Desktop assignment crosses the
 * real flag provider and labels the local Agent card's promoted Type value.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  type AgentComponentProvenanceSeed,
  seedAgentComponents,
} from "./helpers/seed-agent-components-db";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

/**
 * The desktop Labs key gating this pass. Spelled as a LITERAL rather than
 * imported from `../../src/shared/feature-flags`: that module's extension-less
 * `@repo/api/src/types/...` specifiers do not resolve under Playwright's ESM
 * loader, and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load time (same note in `agents-source-provenance.spec.ts`). The copy is
 * pinned by the ISS-5532 case in
 * `apps/desktop/test/feature-flags-shared-ui.test.ts`, which asserts this exact
 * string against `AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY`, so a rename fails
 * there rather than silently leaving this spec seeding a key nothing reads.
 */
const CARD_ATTRIBUTE_LABELS_FLAG_KEY = "agents-card-attribute-labels";

/**
 * A narrow desktop window. The Electron window has no `minWidth` and the sidebar
 * eats ~250px, so the catalog's content column lands well under `GridTable`'s
 * card-fallback breakpoint — the card is a consequence of the app's own
 * measurement, not of a mode this spec pinned.
 */
const NARROW_VIEWPORT = { height: 900, width: 620 };

const MOUNT_TIMEOUT_MS = 30_000;

/**
 * The Agents toolbar's search box. Asserted before every card check so a
 * workspace that failed to mount cannot make an assertion pass vacuously, and
 * used to narrow the inventory to the seeded row so it cannot be pushed off the
 * first page by anything the boot collectors happened to discover.
 */
const AGENTS_SEARCH_LABEL = "Search components";

const TOOL_COMPONENT_NAME = "iss-5532-refactor-tool";

/**
 * The Type column's own label and the kind word its cell renders. Literals for
 * the same reason the flag key is one — `component-meta.tsx` is a React module
 * the Playwright loader should not pull in. Both are pinned against the real
 * column spec and `KindLabel` by
 * `packages/app/agents/components/workspace/__tests__/agents-card-attribute-labels.test.tsx`,
 * whose Type case reads the term off the GRID column header rather than a
 * restated string.
 */
const TYPE_COLUMN_LABEL = "Type";
const TOOL_KIND_TEXT = "Tool";

const SEEDED_COMPONENTS: AgentComponentProvenanceSeed[] = [
  {
    componentKind: "tool",
    externalId: TOOL_COMPONENT_NAME,
    id: "iss-5532-card-attribute-labels",
  },
];

test.describe("Agents card attribute labels, Labs gate ON (ISS-5532)", () => {
  test("names the type the narrow card promotes into its header", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(
      { flagOn: true, prefix: "iss-5532-on" },
      async (page) => {
        await openSeededAgentsCatalog(page, NARROW_VIEWPORT);

        // Mount proof first: the row is genuinely on screen AS A CARD, so a
        // workspace that failed to render — or one still showing the grid at
        // this width — fails here rather than making the pair assertion below
        // pass for the wrong reason.
        await expect(cardFor(page, TOOL_COMPONENT_NAME)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // The value sits in its own term's `<dd>`. Reading the PAIR rather than
        // the label text is what makes this non-vacuous: "Type" also names a
        // grid column header, so a page-wide text query would be satisfied by a
        // header this narrow layout does not even render.
        await expect(headerValueFor(page, TYPE_COLUMN_LABEL)).toHaveText(
          TOOL_KIND_TEXT
        );
      }
    );
  });
});

/**
 * Navigate to the Agents workspace at `viewport` and narrow it to the seeded
 * row.
 *
 * The boot-window gate (`waitForLocalAgentComponentList`) comes first — the
 * disabled boot responder's empty list is cached forever by the query client, so
 * navigating early pins a permanently empty workspace.
 *
 * The viewport is set BEFORE navigating so `GridTable`'s own measurement reports
 * the intended width on its first pass rather than adapting afterwards.
 */
async function openSeededAgentsCatalog(
  page: Page,
  viewport: { height: number; width: number }
): Promise<void> {
  await page.setViewportSize(viewport);
  await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
  await gotoNav(page, "agents");
  const search = page.getByLabel(AGENTS_SEARCH_LABEL);
  await expect(search).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await search.fill(TOOL_COMPONENT_NAME);
}

/** The card for one component, located by the name lead it renders. */
function cardFor(page: Page, name: string): Locator {
  return page.locator('[data-slot="card"]').filter({ hasText: name });
}

/**
 * The definition list the CARD HEADER renders for its promoted attributes.
 *
 * Scoped to `[data-slot="card-header"]` rather than to any `dl`: the card BODY
 * renders its own key/value list, so an unscoped locator would be satisfied by
 * the body on both sides of the gate and would assert nothing about the header.
 */
function cardHeaderList(page: Page): Locator {
  return page.locator('[data-slot="card-header"] dl');
}

/** The `<dd>` paired with the card-header term whose text is `term`. */
function headerValueFor(page: Page, term: string): Locator {
  return cardHeaderList(page)
    .locator("div")
    .filter({ has: page.getByRole("term").filter({ hasText: term }) })
    .getByRole("definition");
}

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real Agents IPC source reads
 * the seeded inventory at boot. The Labs flag is seeded on BOTH launches because
 * `seedE2eDesktopSettings` rewrites the settings file each time.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only inventory row is the seeded one (mirrors
 * `agents-source-provenance.spec.ts`).
 */
async function withSeededDesktopProfile(
  { flagOn, prefix }: { flagOn: boolean; prefix: string },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const seedGate = (dir: string) => {
    if (flagOn) {
      seedDesktopFeatureFlags(dir, {
        [CARD_ATTRIBUTE_LABELS_FLAG_KEY]: true,
      });
    }
  };

  try {
    const first = await launchDesktopApp({
      beforeLaunch: seedGate,
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedAgentComponents(userDataDir, SEEDED_COMPONENTS);

    const { page, cleanup } = await launchDesktopApp({
      beforeLaunch: seedGate,
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
