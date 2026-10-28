/**
 * ISS-10651 E2E regression: the dashboard is VISIBLE and KEEPS UPDATING behind
 * the guest guided-onboarding takeover while transcripts are still parsing.
 *
 * Would fail before the change: `resolveDashboardState` folded an active local
 * import into `loading`, so `DashboardBody` returned `DashboardLoading` for the
 * whole import even with rows already read. The reader spent onboarding looking
 * at a skeleton, where the approved web-master prototype shows the real page
 * behind its modal.
 *
 * A renderer test cannot prove this one. The subject is a real local import
 * running against a real seeded transcript corpus, with the real blocking modal
 * mounted as a shell sibling over it — three things that only exist in a
 * launched app. The renderer suite
 * (`first-launch-dashboard-import-reveal.test.tsx`) owns the state sequence;
 * this owns that the two surfaces actually compose.
 *
 * THE SEEDED CORPUS IS LOAD-BEARING. An empty CLAUDE_HOME enumerates nothing,
 * so the import settles immediately and the page is never in the state this
 * spec is about — it would go green on the broken build for want of a running
 * import rather than because the fix works.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  DESKTOP_PARSING_SESSIONS_DESCRIPTION,
  DESKTOP_RECENT_SESSIONS_TITLE,
  DESKTOP_SYNCED_SESSIONS_TITLE,
  WEB_RECENT_SESSIONS_TITLE,
} from "@repo/app/insights/components/overview/recent-sessions-copy.ts";
import { DESKTOP_WELCOME_CTA_LABEL } from "@repo/app/onboarding/components/guided-onboarding-welcome-copy.ts";
import { z } from "zod";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";

const WELCOME_HEADING = "Discover how you (and your team) build with AI.";
/** The step a started run sits on WHILE the analyzer works — this spec's window. */
const SESSION_DISCOVERY_EYEBROW = "Session discovery";
/**
 * The `[data-tour]` row anchors. The precise marker for "the real body drew":
 * every one of them lives on a dashboard row, and the loading, error and empty
 * branches all return before a row renders, so they emit none.
 */
const ROW_ANCHORS = "[data-tour]";
/**
 * ISS-10492 retains one ambient startup bar. Runtime IPC below proves its
 * parsing stage is still active in the same window as the real dashboard rows.
 */
const ANALYZING_BAR =
  /^(Session analysis status|Desktop startup status|Agent history source files processed)$/;
/** The skeleton's role, which `DashboardLoading` renders and the body does not. */
const LOADING_SKELETON = '[data-testid="dashboard-loading"], .animate-pulse';
const STEP_BUDGET_MS = 30_000;
/** A seeded transcript's own slug, as the page renders it. */
const SEEDED_SLUG_RE = /iss-10651-/;

/**
 * Enough transcripts that the import is demonstrably STILL RUNNING when the
 * walk reaches Session discovery. Sized rather than guessed: at 24 the corpus
 * parsed before the modal got there, and the spec then passed on a deliberately
 * broken build — it was asserting "the dashboard drew" in a state where every
 * build draws it. The runtime ingest assertion below is the standing guard
 * against that, and this number is what keeps it reachable.
 */
const SEEDED_SESSIONS = Array.from({ length: 600 }, (_, index) => ({
  sessionId: `iss-10651-${index}`,
  slug: `iss-10651-${index}`,
}));

test("ISS-10651: the dashboard renders and keeps filling behind the onboarding modal", async () => {
  test.setTimeout(240_000);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss10651-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-iss10651-codex-")
  );
  seedClaudeTranscripts(claudeHome, SEEDED_SESSIONS);

  const launched =
    await test.step("launch the real first-run collector subject", () =>
      launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepFirstRunState: true,
        userDataPrefix: "desktop-iss10651-",
      }));

  try {
    await test.step("navigate to the original dashboard", () =>
      gotoNav(launched.page, "dashboard"));

    // Start the run, so the local import is genuinely working. At Welcome
    // nothing has been parsed yet and the pre-data screen is correct — the
    // reveal this spec is about only exists once analysis is under way.
    await launched.page
      .getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
      .click({ timeout: STEP_BUDGET_MS });
    // The takeover is up and STAYS up — this spec must not pass because the
    // modal happened to close and left the dashboard reachable the old way.
    await expect(
      launched.page.getByText(SESSION_DISCOVERY_EYEBROW)
    ).toBeVisible({ timeout: STEP_BUDGET_MS });

    // The modal hides background controls from the accessibility tree, not
    // visually. Include that subtree while retaining the visual assertion.
    await expect(
      launched.page.getByRole("progressbar", {
        includeHidden: true,
        name: ANALYZING_BAR,
      })
    ).toHaveCount(0);
    const anchors = launched.page.locator(ROW_ANCHORS);
    let lastAnchorCount: number | null = null;
    await test.step("await real parsed dashboard rows behind onboarding", async () => {
      try {
        await expect
          .poll(
            async () => {
              lastAnchorCount = await anchors.count();
              return lastAnchorCount;
            },
            { timeout: STEP_BUDGET_MS }
          )
          .toBeGreaterThan(0);
      } catch (error) {
        await test
          .info()
          .attach("dashboard-last-row-count", {
            body: Buffer.from(JSON.stringify({ lastAnchorCount })),
            contentType: "application/json",
          })
          .catch(() => undefined);
        throw error;
      }
    });
    const drawnAnchors = await anchors.count();
    // ISS-10492: the analysis bar is the progress surface, asserted through the
    // progressbar role so a hidden-but-mounted bar still counts.
    await expectImportStillParsing(launched.page);
    await expect(
      launched.page.getByRole("progressbar", {
        includeHidden: true,
        name: ANALYZING_BAR,
      })
    ).toHaveCount(0);
    // ISS-9996: assert the local caption during a proven active import. Kept
    // alongside the bar assertion above: they cover different surfaces, so
    // neither subsumes the other.
    const sessions = launched.page.locator('[data-tour="sessions"]');
    await expect(
      sessions.getByText(DESKTOP_RECENT_SESSIONS_TITLE, { exact: true })
    ).toBeVisible();
    const caption = sessions.getByText(DESKTOP_PARSING_SESSIONS_DESCRIPTION, {
      exact: true,
    });
    await expect(caption).toBeVisible();
    await expect(caption).not.toContainText("latest");
    await expect(
      sessions.getByText(DESKTOP_SYNCED_SESSIONS_TITLE, { exact: true })
    ).toHaveCount(0);
    await expect(
      sessions.getByText(WEB_RECENT_SESSIONS_TITLE, { exact: true })
    ).toHaveCount(0);
    await expect(launched.page.locator(LOADING_SKELETON)).toHaveCount(0);

    // And it is taking REAL parsed rows while the modal is still open: a seeded
    // transcript's own slug reaching the page is data that came off disk
    // through the local parser, which no skeleton and no placeholder can fake.
    await expect
      .poll(() => launched.page.getByText(SEEDED_SLUG_RE).count(), {
        timeout: STEP_BUDGET_MS,
      })
      .toBeGreaterThan(0);
    // Still the same populated page — it filled in place rather than cycling
    // back through the skeleton as each batch landed.
    await expect(launched.page.locator(LOADING_SKELETON)).toHaveCount(0);
    expect(await anchors.count()).toBeGreaterThanOrEqual(drawnAnchors);

    // Nothing dismissed the modal or restarted onboarding along the way.
    await expect(
      launched.page.getByText(SESSION_DISCOVERY_EYEBROW)
    ).toBeVisible();
    await expect(
      launched.page.getByRole("heading", { name: WELCOME_HEADING })
    ).toBeHidden();
    await launched.page
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await expect(
      launched.page.getByText(SESSION_DISCOVERY_EYEBROW)
    ).toBeHidden();
    await expect(
      launched.page.getByRole("progressbar", {
        includeHidden: true,
        name: ANALYZING_BAR,
      })
    ).toBeVisible();
    await expect(
      launched.page.getByRole("button", {
        includeHidden: true,
        name: PAUSE_OR_RESUME,
      })
    ).toHaveCount(0);
    await launched.page.screenshot({
      path: test.info().outputPath("continued-ambient-bar.png"),
    });
  } finally {
    await launched.cleanup();
    fs.rmSync(claudeHome, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

const ingestStatusSchema = z.object({
  ingest: z.object({
    complete: z.boolean(),
    processed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  }),
});

async function expectImportStillParsing(page: Page): Promise<void> {
  // The ambient bar also covers later startup stages. Read the real producer
  // so a visible bar after parsing finishes cannot satisfy this regression.
  const { ingest } = ingestStatusSchema.parse(
    await page.evaluate(() => {
      const { desktopApi } = window as typeof window & {
        desktopApi: { getRuntimeStatus: () => Promise<unknown> };
      };
      return desktopApi.getRuntimeStatus();
    })
  );
  expect(ingest.complete).toBe(false);
  expect(ingest.processed).toBeGreaterThan(0);
  expect(ingest.processed).toBeLessThan(ingest.total);
}

const PAUSE_OR_RESUME = /pause|resume.*processing/i;
