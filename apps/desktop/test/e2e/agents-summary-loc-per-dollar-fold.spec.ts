/**
 * ISS-6409: the Agents summary LOC/$ card mounts at the DESKTOP host over the
 * bounded page-data read. The web twin is
 * `e2e/agents-summary-loc-per-dollar-fold.spec.ts`, which owns the union-of-
 * sessions fold figures; the local store holds no per-commit LOC (ISS-12709),
 * so none are producible here.
 *
 * What stays desktop-only is the process boundary: the fold once rode the IPC
 * inventory response as a function, Electron's structured clone rejected it,
 * and every Agents read failed. Only a launched app can see that.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar.ts";
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
import { waitForAgentComponentsSchema } from "./helpers/seed-agent-components-db";

/**
 * The desktop Labs key for the bounded page-data read, which is the path that
 * carries the fold. Spelled as a LITERAL rather than imported from
 * `../../src/shared/feature-flags`: that module's extension-less
 * `@repo/api/src/types/...` specifiers do not resolve under Playwright's ESM
 * loader, and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load time. The copy is pinned against the canonical constant by
 * `apps/desktop/test/labs-setting-key-ledger.test.ts`, so a rename fails there
 * rather than leaving this spec seeding a key nothing reads.
 */
const BOUNDED_PAGE_DATA_FLAG_KEY = "agents-bounded-page-data";

const AGENTS_SEARCH_LABEL = "Search components";
const DESKTOP_VIEWPORT = { height: 900, width: 1380 };
const MOUNT_TIMEOUT_MS = 30_000;

const SHARED_SESSION = "iss-6409-shared";
const ALPHA_SOLO_SESSION = "iss-6409-alpha-solo";
const BRAVO_SOLO_SESSION = "iss-6409-bravo-solo";
const ALPHA = "iss-6409-alpha";
const BRAVO = "iss-6409-bravo";
/** A non-verifiable kind in the population. */
const NON_VERIFIABLE = "iss-6409-tool";
const NON_VERIFIABLE_KIND = "tool";
const NON_VERIFIABLE_SESSION = "iss-6409-tool-session";

function seededCorpus(): AgentComponentUsageCorpus {
  return {
    components: [
      {
        id: ALPHA,
        key: ALPHA,
        name: "ISS-6409 Alpha",
        usage: [
          { invocations: 2, sessionId: SHARED_SESSION },
          { invocations: 1, sessionId: ALPHA_SOLO_SESSION },
        ],
      },
      {
        id: BRAVO,
        key: BRAVO,
        name: "ISS-6409 Bravo",
        usage: [
          { invocations: 2, sessionId: SHARED_SESSION },
          { invocations: 1, sessionId: BRAVO_SOLO_SESSION },
        ],
      },
      {
        id: NON_VERIFIABLE,
        kind: NON_VERIFIABLE_KIND,
        key: NON_VERIFIABLE,
        name: "ISS-6409 Tool",
        usage: [{ invocations: 1, sessionId: NON_VERIFIABLE_SESSION }],
      },
    ],
    sessions: [
      {
        costUsd: 100,
        name: "ISS-6409 shared session",
        sessionId: SHARED_SESSION,
      },
      {
        costUsd: 100,
        name: "ISS-6409 alpha solo session",
        sessionId: ALPHA_SOLO_SESSION,
      },
      {
        costUsd: 50,
        name: "ISS-6409 bravo solo session",
        sessionId: BRAVO_SOLO_SESSION,
      },
      {
        costUsd: 10,
        name: "ISS-6409 tool session",
        sessionId: NON_VERIFIABLE_SESSION,
      },
    ],
  };
}

/**
 * Anchor on the summary card's own info trigger rather than the label text.
 * `AgentCard`'s narrow fallback also renders the bare label inside a
 * `data-slot="card"`, so a text filter is unique only while the grid path
 * renders — one container breakpoint away from resolving three elements, or
 * from silently matching alpha's ROW card, which would also pass
 * for the wrong reason. `About <label>` is emitted only by `MetricCard`. Same
 * anchor the web twin uses.
 */
function locPerDollarCard(page: Page) {
  return page
    .getByRole("button", { name: `About ${LOC_PER_DOLLAR_LABEL}` })
    .locator("xpath=ancestor::*[@data-slot='card'][1]");
}

/**
 * Launch once to migrate the store, seed with the app DOWN, then relaunch and
 * run. A running app does not reliably observe a test-process write, while
 * reading the committed schema across processes is fine. The Labs flag is
 * seeded on BOTH launches because `seedE2eDesktopSettings` rewrites the
 * settings file each time.
 */
async function withSeededDesktop(
  run: (page: Page) => Promise<void>
): Promise<void> {
  const prefix = "iss-6409-fold";
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const seedGate = (dir: string) => {
    seedDesktopFeatureFlags(dir, { [BOUNDED_PAGE_DATA_FLAG_KEY]: true });
  };

  try {
    const first = await launchDesktopApp({
      beforeLaunch: seedGate,
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForAgentComponentsSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedAgentComponentUsage(userDataDir, seededCorpus());

    const { page, cleanup } = await launchDesktopApp({
      beforeLaunch: seedGate,
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await run(page);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}

test.describe("Agents summary LOC/$ over the bounded read (ISS-6409)", () => {
  test("the card mounts over the bounded IPC read", async () => {
    // Two full Electron launches per case (migrate, seed with the app down,
    // relaunch) plus a schema wait, against a 60s config default. The house
    // value for this shape; ~18 sibling call sites use it. Not masking a hang:
    // the cases run in ~7s once mounted.
    test.setTimeout(180_000);
    await withSeededDesktop(async (page) => {
      // The boot gate must settle BEFORE navigating, or the disabled-DB
      // responder's empty list is cached and the workspace pins empty.
      await waitForLocalAgentComponentList(page);
      await gotoNav(page, "agents");
      await expect(page.getByLabel(AGENTS_SEARCH_LABEL)).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });

      await expect(locPerDollarCard(page)).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
    });
  });
});
