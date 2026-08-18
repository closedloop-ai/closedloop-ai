/**
 * ISS-5534: cross-adapter E2E for the `agents-invocations-dedupe` gate at the
 * DESKTOP host. The web twin is `e2e/agents-invocations-dedupe.spec.ts`.
 *
 * The Agents workspace (`AgentsGroupedList` → `AgentsSummaryCards`) is a SHARED
 * `packages/app` surface the Electron renderer mounts alongside the web app, so
 * this fix needs coverage on both adapters. They differ in the two dimensions
 * that could break it independently:
 *
 *  - The PRODUCER of the plugin rollup. Web reads the cloud DTO, whose plugin
 *    totals come from `apps/api/app/agent-components/plugin-child-usage.ts`.
 *    Desktop reads the LOCAL IPC `AgentComponentsDataSource`, whose plugin
 *    totals are a SECOND implementation — `pluginUsageSql` / `resolvePluginUsage`
 *    in `src/main/dashboard/shared-agent-components-api.ts`, summing
 *    `agent_component_session_usage` over the child rows whose `pack_id` matches
 *    the plugin's key. A web-only spec proves nothing about that path, and the
 *    double-count is a property of the rollup, not of the wire.
 *  - The FLAG. The packaged renderer has no PostHog wiring, so it resolves the
 *    byte-equal key from its own Labs registry
 *    (`DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY`). A split key would
 *    land the fix on web and leave desktop dark forever.
 *
 * The corpus is the production shape: a plugin that seeds NO usage of its own,
 * two children under its pack that between them carry 30 + 20 invocations, and a
 * fourth row — a subagent in no pack at all, carrying 15. The desktop reader
 * therefore projects the plugin at 50 (its children's sum) and emits each row's
 * `packIds`, so on the default "All" tab the card's flat sum is 115 while only 65
 * invocations really happened. The pack-less subagent is wongk's review case made
 * executable: it is a plugin-CHILD kind that is nobody's child, so a reducer that
 * dropped every plugin the moment any child-kind row appeared would still be
 * wrong here in the general case. A childless plugin, or children with no usage,
 * would render the same number with and without the fix.
 *
 * Both cases assert BOTH sides of the gate. The toggle-OFF half is the
 * load-bearing one: this ships dark under the ISS-4779 closed-by-default policy,
 * so "no perceivable change with the toggle off" is the contract — and it is
 * also what proves the card locator can actually fail.
 *
 * ISS-6182 adds the card's EXPLAINER to both arms. The number was never the whole
 * rendered state: the card carried its own literal describing a flat
 * per-component sum, so with the toggle ON it stated a derivation it had stopped
 * running. `packages/app/AGENTS.md` requires a UI bug fix in a shared component to
 * carry a regression e2e on each shell that MOUNTS it, and the Agents workspace
 * mounts here (`src/renderer/components/agents/agents-view.tsx`) as well as on web
 * (wongk review on #5038) — so this arm is not a courtesy copy of the web spec.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
// Explicit `.ts`, as the sibling `@repo/…` imports in
// `activity-phase-label-parity.spec.ts` do: this Electron Playwright spec
// resolves workspace packages through the pnpm symlink and neither `@repo/api`
// nor `@repo/app` ships an `exports` map. Extension-less `@repo/api/src/…`
// specifiers INSIDE an imported module still resolve fine — that sibling spec
// imports `session-activity-phases.ts`, which reaches
// `@repo/api/src/activity-phase-labels` and `@repo/api/src/utils/string` that
// way — so this module's own extension-less
// `@repo/api/src/types/agent-component` import is on the established shape. The
// explainer is therefore read from the gate that renders it rather than copied,
// and a reworded sentence cannot leave this arm asserting a string the card
// stopped saying.
import { invocationsDerivation } from "@repo/app/agents/lib/agents-summary-aggregate.ts";
import {
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  type AgentComponentUsageCorpus,
  seedAgentComponentUsage,
} from "./helpers/seed-agent-component-usage-db";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

/**
 * The desktop Labs key gating this pass. Spelled as a LITERAL rather than
 * imported from `../../src/shared/feature-flags`: that module's extension-less
 * `@repo/api/src/types/...` specifiers do not resolve under Playwright's ESM
 * loader, and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load time (see the same note in `agents-source-provenance.spec.ts`). The copy
 * is pinned by the ISS-5534 case in
 * `apps/desktop/test/feature-flags-shared-ui.test.ts`, which asserts this exact
 * string against `AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY`, so a rename fails there
 * rather than silently leaving this spec seeding a key nothing reads.
 */
const INVOCATIONS_DEDUPE_FLAG_KEY = "agents-invocations-dedupe";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 30_000;

// The Agents toolbar's search box. Asserted before every card check so an Agents
// workspace that failed to mount cannot make an assertion pass vacuously, and
// used to narrow the population the summary cards aggregate over to the seeded
// four — the search string is part of the same facet filter the cards read
// (`filterAgentComponentRows` → `filteredRows` → `allFilteredComponents`), so
// anything the boot collectors happened to discover cannot enter the total.
const AGENTS_SEARCH_LABEL = "Search components";

/**
 * The pack the plugin IS. Deliberately DIFFERENT from the plugin's display name
 * below: a child row's Source cell renders its `pack_id` (`displaySource`), so a
 * pack id equal to the plugin's name makes a `hasText` row filter match the two
 * child rows as well as the plugin's — a strict-mode violation, not a silent
 * mismatch, but a spec that cannot address one row is a spec that proves nothing.
 */
const PACK_KEY = "iss-5534-pack";

/** The plugin, and the two children its rollup is summed FROM. */
const PLUGIN_COMPONENT_NAME = "iss-5534-review-toolkit";
const SKILL_COMPONENT_NAME = "iss-5534-review-skill";
const COMMAND_COMPONENT_NAME = "iss-5534-commit-command";

/**
 * A subagent in NO pack — a plugin-CHILD kind that is nobody's child (wongk
 * review on #4902). Its presence must not cause the plugin's rollup to be
 * dropped, so its invocations are added on BOTH sides of the gate.
 */
const UNRELATED_COMPONENT_NAME = "iss-5534-standalone-orchestrator";

/** Substring shared by all four seeded names; narrows the list to just them. */
const SEEDED_SEARCH_NEEDLE = "iss-5534-";

const SKILL_INVOCATIONS = 30;
const COMMAND_INVOCATIONS = 20;
const UNRELATED_SUBAGENT_INVOCATIONS = 15;

/** What the desktop rollup projects onto the plugin row: its children's sum. */
const PLUGIN_ROLLUP_TOTAL = String(SKILL_INVOCATIONS + COMMAND_INVOCATIONS);

/** Each invocation counted once: the plugin's leaves, plus the pack-less row. */
const DEDUPED_TOTAL = String(
  SKILL_INVOCATIONS + COMMAND_INVOCATIONS + UNRELATED_SUBAGENT_INVOCATIONS
);

/**
 * The defect: the plugin's rollup (which the desktop reader projects as
 * `SKILL_INVOCATIONS + COMMAND_INVOCATIONS`) added to the very rows it was
 * rolled up from.
 */
const DOUBLE_COUNTED_TOTAL = String(
  2 * (SKILL_INVOCATIONS + COMMAND_INVOCATIONS) + UNRELATED_SUBAGENT_INVOCATIONS
);

const SEEDED_CORPUS: AgentComponentUsageCorpus = {
  sessions: [
    {
      costUsd: 4,
      linesAdded: 400,
      linesRemoved: 40,
      name: "ISS-5534 review session",
      sessionId: "iss-5534-review-session",
    },
    {
      costUsd: 2,
      linesAdded: 120,
      linesRemoved: 10,
      name: "ISS-5534 commit session",
      sessionId: "iss-5534-commit-session",
    },
    {
      costUsd: 1,
      linesAdded: 60,
      linesRemoved: 5,
      name: "ISS-5534 standalone session",
      sessionId: "iss-5534-standalone-session",
    },
  ],
  components: [
    {
      // No `packId` and no `usage`: a plugin is never invoked directly, and its
      // pack id IS its `component_key` (`pluginPackCandidates`) — which is why
      // this row's `key` is `PACK_KEY` while its display `name` is something
      // else. Its whole total is resolved from the two children below.
      id: "iss-5534-plugin",
      key: PACK_KEY,
      kind: "plugin",
      name: PLUGIN_COMPONENT_NAME,
      usage: [],
    },
    {
      id: "iss-5534-skill",
      key: SKILL_COMPONENT_NAME,
      kind: "skill",
      name: SKILL_COMPONENT_NAME,
      packId: PACK_KEY,
      usage: [
        {
          invocations: SKILL_INVOCATIONS,
          sessionId: "iss-5534-review-session",
        },
      ],
    },
    {
      id: "iss-5534-command",
      key: COMMAND_COMPONENT_NAME,
      kind: "command",
      name: COMMAND_COMPONENT_NAME,
      packId: PACK_KEY,
      usage: [
        {
          invocations: COMMAND_INVOCATIONS,
          sessionId: "iss-5534-commit-session",
        },
      ],
    },
    {
      // No `packId`: belongs to no plugin, so no plugin's rollup covers it and
      // no plugin may be dropped on its account.
      id: "iss-5534-standalone",
      key: UNRELATED_COMPONENT_NAME,
      kind: "subagent",
      name: UNRELATED_COMPONENT_NAME,
      usage: [
        {
          invocations: UNRELATED_SUBAGENT_INVOCATIONS,
          sessionId: "iss-5534-standalone-session",
        },
      ],
    },
  ],
};

test.describe("Agents Invocations de-duplication, Labs gate ON (ISS-5534)", () => {
  test("counts each invocation once when a plugin and its child rows share the view", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(
      { flagOn: true, prefix: "iss-5534-on" },
      async (page) => {
        await openSeededAgentsCatalog(page);

        // Mount proof: the plugin, both its children and the pack-less subagent
        // are genuinely rows in the population the card aggregates, so a
        // workspace that failed to render — or a rollup that resolved to
        // nothing — fails here rather than letting the total assertion below
        // pass for the wrong reason.
        await expectSeededRowsVisible(page);
        await expect(invocationsCell(page, PLUGIN_COMPONENT_NAME)).toHaveText(
          PLUGIN_ROLLUP_TOTAL
        );

        await expect(invocationsCardValue(page)).toHaveText(DEDUPED_TOTAL);

        // ISS-6182: the card must EXPLAIN the reduction it ran. Before that fix
        // its explainer was a literal describing the flat sum on BOTH sides of
        // the gate, so this popover promised a plain per-component sum beside
        // the deduped 65.
        await expect(await openInvocationsInfo(page)).toContainText(
          invocationsDerivation(true).how
        );
      }
    );
  });
});

test.describe("Agents Invocations de-duplication, Labs gate OFF (ISS-5534 dark-launch no-op)", () => {
  test("keeps today's double-counted total", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(
      { flagOn: false, prefix: "iss-5534-off" },
      async (page) => {
        await openSeededAgentsCatalog(page);

        await expectSeededRowsVisible(page);
        // The plugin row itself is unchanged by the gate in BOTH states — the
        // fix is to the CARD's reduction, not to the row projection — so this
        // also pins that the toggle-off arm is running against the same rollup.
        await expect(invocationsCell(page, PLUGIN_COMPONENT_NAME)).toHaveText(
          PLUGIN_ROLLUP_TOTAL
        );

        // The defect, rendered. This is what proves the gate-on assertion is a
        // real change and not a locator that never matches.
        await expect(invocationsCardValue(page)).toHaveText(
          DOUBLE_COUNTED_TOTAL
        );

        // The positive control for the gate-ON explainer assertion: the SAME
        // popover locator resolves with the toggle closed and carries the OTHER
        // sentence. Without this arm a `toContainText` against a popover that
        // never opened would look identical to one that opened correctly.
        const info = await openInvocationsInfo(page);
        await expect(info).toContainText(invocationsDerivation(false).how);
        await expect(info).not.toContainText(invocationsDerivation(true).how);
      }
    );
  });
});

/**
 * Navigate to the Agents workspace and narrow it to the three seeded rows.
 *
 * The boot-window gate (`waitForLocalAgentComponentList`) comes first — the
 * disabled boot responder's empty list is cached forever by the query client, so
 * navigating early pins a permanently empty workspace (ISS-5364).
 *
 * The search box doubles as the mount proof and as the narrowing: the Agents
 * view lazy-loads its own chunk, and the search string feeds the SAME facet
 * filter the summary cards aggregate over, so filling it makes the Invocations
 * total a function of the seeded corpus alone.
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
    SKILL_COMPONENT_NAME,
    COMMAND_COMPONENT_NAME,
    UNRELATED_COMPONENT_NAME,
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
 * The Invocations summary card's VALUE slot.
 *
 * Anchored on the card's own info trigger (`About Invocations`, the accessible
 * name `MetricCard` gives its `InfoHint`) rather than on the visible label:
 * "Invocations" also names the table's column header, and Playwright's
 * accessible-name matching is substring + case-insensitive by default, so the
 * name is matched exactly. The value is read from `[data-slot="card-title"]` —
 * the same handle `helpers/summary-strip.ts` uses — so the assertion reads the
 * metric and not the label, the detail caption, or the delta chip. `visible=true`
 * because the renderer keeps other nav views mounted-but-hidden.
 */
function invocationsCardValue(page: Page): Locator {
  return invocationsCard(page).locator('[data-slot="card-title"]');
}

/** The visible Invocations summary card, identified by its own info trigger. */
function invocationsCard(page: Page): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({
      has: page.getByRole("button", { exact: true, name: "About Invocations" }),
    })
    .locator("visible=true")
    .first();
}

/**
 * Pin the Invocations card's info popover open and return it.
 *
 * `InfoHint` reveals on hover and PINS on click; the click is used because a
 * pinned popover survives the pointer moving on, so the assertion cannot race a
 * hover-out. The trigger is reached THROUGH the visible card rather than from the
 * page: the renderer keeps other nav views mounted-but-hidden, so a bare
 * `About Invocations` button lookup can match more than one.
 */
async function openInvocationsInfo(page: Page): Promise<Locator> {
  await invocationsCard(page)
    .getByRole("button", { exact: true, name: "About Invocations" })
    .click();
  return page.getByRole("dialog", { exact: true, name: "About Invocations" });
}

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real Agents IPC source reads
 * the seeded inventory at boot. The Labs flag is seeded on BOTH launches because
 * `seedE2eDesktopSettings` rewrites the settings file each time; the OFF arm
 * seeds nothing, so it exercises the registry's own closed default rather than a
 * value this spec wrote.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only inventory rows are the seeded ones (mirrors
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
        [INVOCATIONS_DEDUPE_FLAG_KEY]: true,
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

    await seedAgentComponentUsage(userDataDir, SEEDED_CORPUS);

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
