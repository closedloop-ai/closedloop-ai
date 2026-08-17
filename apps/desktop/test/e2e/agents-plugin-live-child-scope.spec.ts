/**
 * ISS-6180: launched-app regression for the desktop plugin child-usage rollup's
 * LIVE-inventory scope.
 *
 * The main-process reader is covered by
 * `test/agent-components-plugin-live-child-scope.test.ts`. That suite stops at
 * `listAgentComponentsLocal`, so it cannot prove the corrected number reaches
 * the screen — the production path could keep rendering the double-count while
 * the reader test passes (wongk review). This drives the built Electron app.
 *
 * Deliberately a SIBLING of `agents-invocations-dedupe.spec.ts` rather than an
 * extension of it: that spec's `DEDUPED_TOTAL` / `DOUBLE_COUNTED_TOTAL` are
 * arithmetic over its own corpus, and adding a tombstoned child with usage would
 * silently re-base both constants — entangling the ISS-5534 contract with this
 * one. A separate corpus keeps each spec's numbers derivable from its own seed.
 *
 * The rendered contract, on the default (unflagged) Agents workspace:
 *  - the plugin's Invocations cell is its LIVE child's total alone; the
 *    tombstoned child's invocations are NOT added to it, and
 *  - those invocations are not lost either — they surface exactly once, on the
 *    tombstoned child's OWN row, which has left live inventory and so renders
 *    through the unresolved (usage-only) lane.
 *
 * Neither assertion is flag-gated: the plugin row's projection is unchanged by
 * the `agents-invocations-dedupe` Labs toggle in both of its states (see that
 * spec's toggle-OFF arm), so this spec seeds no feature flags and exercises the
 * shipped default.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  gotoNav,
  launchDesktopApp,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  type AgentComponentUsageCorpus,
  seedAgentComponentUsage,
} from "./helpers/seed-agent-component-usage-db";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 30_000;

const AGENTS_SEARCH_LABEL = "Search components";

/**
 * The pack the plugin IS (a plugin's pack id equals its `component_key`), kept
 * DISTINCT from every display name below: a child row's Source cell renders its
 * `pack_id`, so a pack id that is a substring of a row name would make the
 * `hasText` row filters below match more than one row.
 */
const PACK_KEY = "iss-6180-pack";

const PLUGIN_COMPONENT_NAME = "iss-6180-review-toolkit";
const LIVE_CHILD_NAME = "iss-6180-live-skill";

/**
 * The TOMBSTONED child. Its `name` equals its `component_key` because, once
 * `uninstalled_at` is stamped, the row leaves live inventory and the list
 * synthesizes its row from the USAGE side — where the only identity available is
 * `(kind, key)`. Keeping the two equal makes the row locator hold on both sides
 * of the fix, so a failure reports the wrong NUMBER rather than a missing row.
 */
const DEAD_CHILD_NAME = "iss-6180-dead-mcp";

/** Substring shared by all three seeded names; narrows the list to just them. */
const SEEDED_SEARCH_NEEDLE = "iss-6180-";

const LIVE_CHILD_INVOCATIONS = 30;
const DEAD_CHILD_INVOCATIONS = 7;

/**
 * What the plugin must render: its LIVE child's total, alone.
 *
 * The defect this guards is the other value the same cell can hold — an
 * unscoped join adds the tombstoned child's invocations too
 * (`LIVE_CHILD_INVOCATIONS + DEAD_CHILD_INVOCATIONS`), while those same
 * invocations ALSO render on the child's own unresolved row, so one invocation
 * is shown twice in one view. Verified by removing the
 * `AND ac.uninstalled_at IS NULL` predicate from `pluginUsageSql`: this
 * assertion then reads 37 and fails.
 */
const PLUGIN_LIVE_ROLLUP_TOTAL = String(LIVE_CHILD_INVOCATIONS);

const SEEDED_CORPUS: AgentComponentUsageCorpus = {
  components: [
    {
      // A plugin is never invoked directly: no `packId`, no `usage`. Its whole
      // total is resolved from the children below.
      id: "iss-6180-plugin",
      key: PACK_KEY,
      kind: "plugin",
      name: PLUGIN_COMPONENT_NAME,
      usage: [],
    },
    {
      id: "iss-6180-live-child",
      key: LIVE_CHILD_NAME,
      kind: "skill",
      name: LIVE_CHILD_NAME,
      packId: PACK_KEY,
      usage: [
        {
          invocations: LIVE_CHILD_INVOCATIONS,
          sessionId: "iss-6180-live-session",
        },
      ],
    },
    {
      // The production shape: `mcp-discovery.ts` stamps `uninstalled_at` and
      // NOTHING clears `pack_id`, so the tombstoned row still points at its
      // plugin. That retained `packId` is what an unscoped rollup joins on.
      id: "iss-6180-dead-child",
      key: DEAD_CHILD_NAME,
      kind: "mcp",
      name: DEAD_CHILD_NAME,
      packId: PACK_KEY,
      uninstalledAt: "2026-07-01T00:00:00.000Z",
      usage: [
        {
          invocations: DEAD_CHILD_INVOCATIONS,
          sessionId: "iss-6180-dead-session",
        },
      ],
    },
  ],
  sessions: [
    {
      costUsd: 4,
      linesAdded: 400,
      linesRemoved: 40,
      name: "ISS-6180 live session",
      sessionId: "iss-6180-live-session",
    },
    {
      costUsd: 2,
      linesAdded: 120,
      linesRemoved: 10,
      name: "ISS-6180 dead session",
      sessionId: "iss-6180-dead-session",
    },
  ],
};

test.describe("Agents plugin rollup, live-inventory child scope (ISS-6180)", () => {
  test("excludes a tombstoned child from the plugin total and renders its usage once", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile("iss-6180", async (page) => {
      await openSeededAgentsCatalog(page);

      // Mount proof: all three rows are genuinely in the population, so a
      // workspace that failed to render cannot make the number assertions pass
      // vacuously. It also proves the DEAD_CHILD_NAME locator matches something
      // — without which the "renders once" assertion below would be trivially
      // satisfiable by an absent row.
      await expectSeededRowsVisible(page);

      // The fix, rendered: the tombstoned child's 7 invocations are NOT in the
      // plugin's total. An unscoped join renders PLUGIN_UNSCOPED_TOTAL here.
      await expect(invocationsCell(page, PLUGIN_COMPONENT_NAME)).toHaveText(
        PLUGIN_LIVE_ROLLUP_TOTAL
      );

      // ...and they are not dropped: they surface exactly once, on the
      // tombstoned child's own unresolved row.
      await expect(invocationsCell(page, DEAD_CHILD_NAME)).toHaveText(
        String(DEAD_CHILD_INVOCATIONS)
      );
      await expect(invocationsCell(page, LIVE_CHILD_NAME)).toHaveText(
        String(LIVE_CHILD_INVOCATIONS)
      );

      // Exactly one row carries the tombstoned child's identity — the live
      // inventory row is gone, so it must not ALSO appear as an inventory row.
      await expect(
        page.getByRole("row").filter({ hasText: DEAD_CHILD_NAME })
      ).toHaveCount(1);
    });
  });
});

/**
 * Navigate to the Agents workspace and narrow it to the seeded rows. The
 * boot-window gate comes first — the disabled boot responder's empty list is
 * cached forever by the query client, so navigating early pins a permanently
 * empty workspace (ISS-5364).
 */
async function openSeededAgentsCatalog(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
  await gotoNav(page, "agents");
  const search = page.getByLabel(AGENTS_SEARCH_LABEL);
  await expect(search).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await search.fill(SEEDED_SEARCH_NEEDLE);
}

async function expectSeededRowsVisible(page: Page): Promise<void> {
  for (const name of [
    PLUGIN_COMPONENT_NAME,
    LIVE_CHILD_NAME,
    DEAD_CHILD_NAME,
  ]) {
    await expect(
      page.getByRole("row").filter({ hasText: name }).first()
    ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  }
}

/**
 * The Invocations BODY cell of the grid row that owns `componentName`. Scoped by
 * `data-column-id` because the Sessions column renders a bare integer too.
 */
function invocationsCell(page: Page, componentName: string): Locator {
  return page
    .getByRole("row")
    .filter({ hasText: componentName })
    .locator('[role="cell"][data-column-id="invocations"]');
}

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real Agents IPC source reads
 * the seeded inventory at boot.
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

  try {
    const first = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedAgentComponentUsage(userDataDir, SEEDED_CORPUS);

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
