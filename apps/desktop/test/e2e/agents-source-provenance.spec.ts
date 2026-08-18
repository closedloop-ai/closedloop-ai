/**
 * ISS-5009: cross-adapter E2E for the `agents-source-provenance-honesty` gate at
 * the DESKTOP host. The web twin is `e2e/agents-source-provenance.spec.ts`.
 *
 * The Agents catalog (`AgentsGroupedList` → `AgentsTable` → `SourceLabel`) is a
 * SHARED `packages/app` surface that the Electron renderer mounts alongside the
 * web app, so ISS-5009 needs coverage on both adapters. The two differ in every
 * dimension that could break this fix independently:
 *
 *  - The PRODUCER. Web reads the cloud DTO; desktop reads the LOCAL IPC
 *    `AgentComponentsDataSource`, whose honest projection is a second
 *    implementation (`src/main/dashboard/agent-component-honest-source.ts`)
 *    resolving over SQLite columns instead of merged cloud rows. A web-only spec
 *    proves nothing about it.
 *  - The FLAG. The packaged renderer has no PostHog wiring, so it resolves the
 *    byte-equal key from its own Labs registry. A split key would land the fix on
 *    web and leave desktop dark forever.
 *
 * The seeded pair is chosen so the honest and legacy values DIVERGE on the
 * desktop chain specifically: the provenance row carries only `source_url`,
 * which the legacy `displaySource` chain does not read (it falls through to
 * `install_path ?? external_id`, i.e. the identity-key echo) while
 * `honestSourceOf` returns the real repository. So the flag flips that cell from
 * the component's own name to its actual origin — a difference no flag-off
 * render can fake.
 *
 * Both cases assert BOTH sides of the gate. The flag-OFF half is the
 * load-bearing one: this ships dark under the ISS-4779 closed-by-default policy,
 * so "no perceivable change with the toggle off" is the contract — and it is
 * also what proves each locator can actually fail.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component.ts";
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
 * load time (see the same note in `agents-loc-per-dollar-display.spec.ts` and
 * `sessions-column-fold.spec.ts`). The copy is pinned by the ISS-5009 case in
 * `apps/desktop/test/feature-flags-shared-ui.test.ts`, which asserts this exact
 * string against `AGENTS_SOURCE_PROVENANCE_FLAG_KEY`, so a rename fails there
 * rather than silently leaving this spec seeding a key nothing reads.
 */
const SOURCE_PROVENANCE_FLAG_KEY = "agents-source-provenance-honesty";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 30_000;

// The Agents toolbar's search box. Asserted before every cell check so an Agents
// workspace that failed to mount cannot make an assertion pass vacuously, and
// used to narrow the inventory to the seeded pair so they cannot be pushed off
// the first page by anything the boot collectors happened to discover.
const AGENTS_SEARCH_LABEL = "Search components";

/**
 * The `GridEmptyValue` glyph (`grid-table.tsx`) and the wrapper title
 * `SourceLabel` attaches to it. Literals for the same reason the flag key is one
 * — `component-meta.tsx` is a React module the Playwright loader should not pull
 * in. The title is pinned against the exported `NO_SOURCE_RECORDED_TITLE` by
 * `packages/app/agents/components/workspace/__tests__/agents-source-provenance.test.tsx`.
 */
const EM_DASH = "—";
const NO_SOURCE_RECORDED_TITLE = "No source recorded";

/**
 * A row WITH real provenance: the repository the scanners record in
 * `source_url`. The LEGACY chain cannot see that column, so today this cell
 * shows the component's own name.
 */
const PROVENANCE_COMPONENT_NAME = "iss-5009-repo-skill";
const PROVENANCE_SOURCE_URL = "https://github.com/acme/iss-5009-agents";

/** A row with NO provenance at all — every provenance column NULL. */
const ECHO_COMPONENT_NAME = "iss-5009-orphan-tool";

/** Substring shared by both seeded names; narrows the list to just them. */
const SEEDED_SEARCH_NEEDLE = "iss-5009-";

const SEEDED_COMPONENTS: AgentComponentProvenanceSeed[] = [
  {
    componentKind: AgentComponentKind.Skill,
    externalId: PROVENANCE_COMPONENT_NAME,
    id: "iss-5009-with-provenance",
    sourceUrl: PROVENANCE_SOURCE_URL,
  },
  {
    componentKind: AgentComponentKind.Tool,
    externalId: ECHO_COMPONENT_NAME,
    id: "iss-5009-without-provenance",
  },
];

test.describe("Agents Source provenance honesty, Labs gate ON (ISS-5009)", () => {
  test("keeps real provenance and replaces the identity-key echo with an explained em dash", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(
      { flagOn: true, prefix: "iss-5009-on" },
      async (page) => {
        await openSeededAgentsCatalog(page);

        const provenanceCell = sourceCell(page, PROVENANCE_COMPONENT_NAME);
        const echoCell = sourceCell(page, ECHO_COMPONENT_NAME);
        await expect(provenanceCell).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(echoCell).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // (1) The column is NOT dropped: the desktop honest chain reads the
        // `source_url` the legacy chain cannot, so the row that genuinely knows
        // its origin now prints it instead of its own name.
        await expect(provenanceCell).toHaveText(PROVENANCE_SOURCE_URL);

        // (2) The row with nothing to say renders the shared empty glyph.
        // Asserted on the cell's WHOLE text, and scoped by `data-column-id`
        // because the Metric and Versions cells render the same em dash.
        await expect(echoCell).toHaveText(EM_DASH);
        await expect(
          echoCell.getByText(ECHO_COMPONENT_NAME, { exact: true })
        ).toHaveCount(0);

        // (3) …and the em dash is EXPLAINED. `GridEmptyValue` takes no props, so
        // the wrapper carries the hover/assistive text.
        await expect(
          echoCell.getByTitle(NO_SOURCE_RECORDED_TITLE)
        ).toBeVisible();
      }
    );
  });
});

test.describe("Agents Source provenance honesty, Labs gate OFF (ISS-5009 dark-launch no-op)", () => {
  test("keeps today's identity-key echo in both Source cells", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(
      { flagOn: false, prefix: "iss-5009-off" },
      async (page) => {
        await openSeededAgentsCatalog(page);

        const provenanceCell = sourceCell(page, PROVENANCE_COMPONENT_NAME);
        const echoCell = sourceCell(page, ECHO_COMPONENT_NAME);
        await expect(provenanceCell).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(echoCell).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The defect, rendered: BOTH Source cells repeat their own row's
        // Component name. This is what proves the gate-on assertions above are
        // real changes and not locators that never match.
        await expect(provenanceCell).toHaveText(PROVENANCE_COMPONENT_NAME);
        await expect(echoCell).toHaveText(ECHO_COMPONENT_NAME);

        // The honest projection rides on the IPC payload in BOTH states (it is
        // additive, not gated at the producer). Nothing from it may reach the
        // render while the toggle is closed — not the corrected value, not the
        // empty glyph's explanation.
        await expect(
          page.getByText(PROVENANCE_SOURCE_URL, { exact: true })
        ).toHaveCount(0);
        await expect(page.getByTitle(NO_SOURCE_RECORDED_TITLE)).toHaveCount(0);
      }
    );
  });
});

/**
 * Navigate to the Agents workspace and narrow it to the two seeded rows.
 *
 * The boot-window gate (`waitForLocalAgentComponentList`) comes first — the
 * disabled boot responder's empty list is cached forever by the query client, so
 * navigating early pins a permanently empty workspace. ISS-5364 moved that gate
 * into `helpers/desktop-app.ts` when a second spec needed it; the race belongs
 * to the boot sequence, not to this spec.
 *
 * The search box doubles as the mount proof: the Agents view lazy-loads its own
 * chunk, so asserting on it before touching a cell keeps a failed mount from
 * being mistaken for a passing "the name is absent" assertion.
 */
async function openSeededAgentsCatalog(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
  await gotoNav(page, "agents");
  const search = page.getByLabel(AGENTS_SEARCH_LABEL);
  await expect(search).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await search.fill(SEEDED_SEARCH_NEEDLE);
}

/**
 * The Source BODY cell of the grid row that owns `componentName`.
 *
 * Scoped twice on purpose: to the row, because the Component column renders the
 * same string the flag-off Source cell does; and to
 * `[role="cell"][data-column-id="source"]`, because the column HEADER carries
 * the same `data-column-id` (`table-grid-header.tsx`).
 */
function sourceCell(page: Page, componentName: string) {
  return page
    .getByRole("row")
    .filter({ hasText: componentName })
    .locator('[role="cell"][data-column-id="source"]');
}

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real Agents IPC source reads
 * the seeded inventory at boot. The Labs flag is seeded on BOTH launches because
 * `seedE2eDesktopSettings` rewrites the settings file each time.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only inventory rows are the seeded ones (mirrors
 * `agents-loc-per-dollar-display.spec.ts`).
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
        [SOURCE_PROVENANCE_FLAG_KEY]: true,
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
