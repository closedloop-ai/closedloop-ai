/**
 * ISS-10467: cross-adapter E2E for the per-CONTENT-VERSION usage drill-down at
 * the DESKTOP host. The web twin is `e2e/agent-detail-version-usage.spec.ts`.
 *
 * The panel is the SHARED
 * `packages/app/agents/components/workspace/version-usage-panel.tsx`, mounted by
 * the shared `agent-detail.tsx` which the Electron renderer renders through
 * `src/renderer/components/agents/agent-detail-view.tsx` — so
 * `packages/app/AGENTS.md` ("E2E Coverage for UI Surfaces") owes this adapter
 * its own spec, and the jsdom suite injects both the payload and the data
 * source as props and therefore touches neither real boundary.
 *
 * WHAT ONLY A LAUNCHED APP CAN PROVE HERE
 * ---------------------------------------
 *  1. THE GATE. The renderer runs no PostHog SDK of its own; it resolves this
 *     ONE key from the signed-in account's assignment over the IPC bridge. An
 *     unknown key resolves CLOSED in every build, so a split or renamed key
 *     leaves desktop dark forever and no jsdom test can see it.
 *  2. THE IPC READ. The desktop panel's figures come from
 *     `readAgentComponentVersionUsageLocal` over the local SQLite store, through
 *     the `desktop:agent-dashboard:component-version-usage` channel and the
 *     preload method. A break anywhere on that chain renders the "not available
 *     on this surface" state, which is indistinguishable from a closed gate
 *     unless something drives the whole chain.
 *  3. THE DIGEST TRANSLATION, end to end. The seeded usage rows carry ONLY the
 *     `computeDefinitionHash` digest, never the selector's `content_hash`, which
 *     is the production shape. A read that scoped by the selector's own hash
 *     would render a measured-looking `0` here.
 *
 * Both sides of the gate are asserted. The OFF half is the ISS-4779 contract
 * (this ships dark) and is also what proves the detail page mounts at all,
 * without which the ON-side locators could pass vacuously.
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
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics.ts";
// THE key, imported rather than re-spelled as a literal. Sibling desktop specs
// carry the string because their flag modules pull in extension-less
// `@repo/api/src/types/...` specifiers Playwright's ESM loader cannot resolve;
// this one has NO imports at all, so the canonical constant travels here and a
// rename cannot leave the spec seeding a key nothing reads.
import { AGENTS_VERSION_USAGE_FLAG_KEY } from "@repo/api/src/types/agents-version-usage-flag.ts";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import { seedAgentComponentVersionUsage } from "./helpers/seed-agent-component-version-usage-db";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };
const MOUNT_TIMEOUT_MS = 30_000;

/** SUBAGENT: a kind with a revision-history affordance and a verifiable LOC/$. */
const COMPONENT_KIND = AgentComponentKind.Subagent;
const COMPONENT_KEY = "iss-10467-desktop-version-usage";
const COMPONENT_NAME = "ISS-10467 Desktop Version Usage";
const COMPONENT_SLUG = encodeComponentSlug(COMPONENT_KIND, COMPONENT_KEY);

const PANEL_HEADING = "Version usage";
const DEFINITION_HEADING = "Definition";
const SELECTOR_LABEL = "Content version to break usage down by";
const COMPARE_TOGGLE = "Compare the selected revision with another";
const CHANGE_COLUMN = "Change";
const INVOCATIONS_ROW = /Invocations/;
/** 23 against 9, written out so the spec cannot agree with the panel's own arithmetic. */
const INVOCATIONS_CHANGE = "14";

/**
 * Deliberately NOT a content digest of the bodies below — see the seeder's
 * header. If the read matched on this value the current revision would report
 * the OLDER revision's usage and vice versa, which is precisely what the
 * distinct per-revision counts below make visible.
 */
// SHAPED LIKE A REAL DIGEST — 64 lowercase hex — because the detail read
// publishes the FEA-4335 routable key `${kind}::${content_hash}` as its own
// `slug`, and that is the slug the panel then hands to the version-usage read.
// `decodeComponentHashKey` only recognises a fingerprint segment matching
// `/^[0-9a-f]{64}$/`, so a readable non-hex fixture hash produced a detail slug
// that resolved back to no component at all: the drill-down answered NOT FOUND
// on a page whose own figures had just loaded. Production `content_hash` is a
// sha256, so only the fixture was ever unrealistic.
//
// Distinct in their first 7 characters as well: the selector labels an option
// `<name> · #<hash.slice(0, 7)>`, so a shared prefix renders two options a
// prefix regex cannot tell apart.
const OLDER_CONTENT_HASH =
  "0dde111111111111111111111111111111111111111111111111111111111111";
const CURRENT_CONTENT_HASH =
  "c0ffee2222222222222222222222222222222222222222222222222222222222";
const OLDER_BODY = "ISS-10467 desktop older revision body.";
const CURRENT_BODY = "ISS-10467 desktop current revision body.";

/** One revision's invocations must not be reachable by summing the other's. */
const OLDER_INVOCATIONS = 9;
const CURRENT_INVOCATIONS = 23;

test.describe("Agent detail version usage, desktop gate ON (ISS-10467)", () => {
  test("reports the selected revision's own invocations from the local store", async () => {
    test.setTimeout(180_000);

    await withSeededDesktop(
      { flagOn: true, prefix: "iss-10467-on" },
      async (page) => {
        await openSeededComponentDetail(page);

        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 2,
            name: PANEL_HEADING,
          })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The CURRENT revision is selected by default, and the figure is ITS
        // OWN — the family total is 32, which this must never print.
        await expect(
          page.getByText(String(CURRENT_INVOCATIONS), { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // Selecting the older revision repaints with THAT revision's usage,
        // which proves the IPC read carried the selection rather than the panel
        // reusing one cached entry.
        await page.getByRole("combobox", { name: SELECTOR_LABEL }).click();
        await page
          .getByRole("option", {
            name: new RegExp(OLDER_CONTENT_HASH.slice(0, 7)),
          })
          .click();

        await expect(
          page.getByText(String(OLDER_INVOCATIONS), { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          page.getByText(String(CURRENT_INVOCATIONS), { exact: true })
        ).toHaveCount(0);
      }
    );
  });
});

test.describe("Agent detail version compare, desktop gate ON (ISS-10468)", () => {
  test("puts both revisions' local figures side by side with the change", async () => {
    test.setTimeout(180_000);

    await withSeededDesktop(
      { flagOn: true, prefix: "iss-10468-compare" },
      async (page) => {
        await openSeededComponentDetail(page);
        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 2,
            name: PANEL_HEADING,
          })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // Only a launched app proves this half: the compare asks the
        // `desktop:agent-dashboard:component-version-usage` channel for TWO
        // hashes on one call, and the local reader has to answer both from
        // SQLite. A reader that dropped the second would render the baseline
        // column empty, which the jsdom suite cannot see because it injects the
        // data source.
        await page.getByRole("button", { name: COMPARE_TOGGLE }).click();

        await expect(
          page.getByRole("columnheader", { name: CHANGE_COLUMN })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        // Scoped to the Invocations ROW, not the page: in compare mode the
        // table carries three numeric cells per row across six rows, and an
        // unscoped exact-text match on a bare integer is a strict-mode
        // violation waiting on whichever seeded figure collides first.
        const invocations = page.getByRole("row", { name: INVOCATIONS_ROW });
        await expect(
          invocations.getByText(String(CURRENT_INVOCATIONS), { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          invocations.getByText(String(OLDER_INVOCATIONS), { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(
          invocations.getByText(INVOCATIONS_CHANGE, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      }
    );
  });
});

test.describe("Agent detail version usage, desktop gate OFF (ISS-4779 dark launch)", () => {
  test("renders today's detail page with no drill-down affordance", async () => {
    test.setTimeout(180_000);

    await withSeededDesktop(
      { flagOn: false, prefix: "iss-10467-off" },
      async (page) => {
        await openSeededComponentDetail(page);

        // Positive control: the detail page itself mounted, so the two absence
        // assertions below are a closed gate and not a dead route.
        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 2,
            name: DEFINITION_HEADING,
          })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 2,
            name: PANEL_HEADING,
          })
        ).toHaveCount(0);
        await expect(
          page.getByRole("combobox", { name: SELECTOR_LABEL })
        ).toHaveCount(0);
      }
    );
  });
});

/**
 * Navigate to the seeded component's detail route and wait for it to resolve.
 *
 * The Definition heading is the gate: during the boot window the renderer is
 * served by a DISABLED db responder whose empty answer the query client caches
 * FOREVER, so a detail hash opened too early pins a permanent "Component not
 * found" — an empty page on which every absence assertion passes vacuously.
 */
async function openSeededComponentDetail(page: Page): Promise<void> {
  await gotoHash(page, `#/agents/${COMPONENT_SLUG}`);
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 2,
      name: DEFINITION_HEADING,
    })
  ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
}

/**
 * Initialize through the production migration adapter and close its writer,
 * seed with the app DOWN, then launch the real subject and run. Mirrors `agent-detail-honesty.spec.ts` — a running app does not reliably
 * observe a test-process write, while reading the committed schema across
 * processes is fine.
 */
async function withSeededDesktop(
  { flagOn, prefix }: { flagOn: boolean; prefix: string },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  // Layered on the real subject after the standard settings seed. An omitted
  // key resolves CLOSED, which is the OFF case.
  const seedGate = (dir: string) => {
    if (flagOn) {
      seedDesktopFeatureFlags(dir, {
        [AGENTS_VERSION_USAGE_FLAG_KEY]: true,
      });
    }
  };

  try {
    await initializeDesktopProfileSchema(userDataDir);

    await seedAgentComponentVersionUsage(userDataDir, {
      harness: "claude",
      id: "iss-10467-desktop-component",
      key: COMPONENT_KEY,
      kind: COMPONENT_KIND,
      name: COMPONENT_NAME,
      // Ordered oldest-first: the seeder treats the LAST as current, so the
      // inventory row's own `content_hash` is the current revision's.
      revisions: [
        {
          content: OLDER_BODY,
          contentHash: OLDER_CONTENT_HASH,
          usage: [
            { invocations: 4, sessionId: "iss-10467-desktop-session-0" },
            { invocations: 5, sessionId: "iss-10467-desktop-session-1" },
          ],
        },
        {
          content: CURRENT_BODY,
          contentHash: CURRENT_CONTENT_HASH,
          usage: [
            { invocations: 20, sessionId: "iss-10467-desktop-session-2" },
            { invocations: 3, sessionId: "iss-10467-desktop-session-3" },
          ],
        },
      ],
    });

    const { page, cleanup } = await launchDesktopApp({
      beforeLaunch: seedGate,
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);
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
