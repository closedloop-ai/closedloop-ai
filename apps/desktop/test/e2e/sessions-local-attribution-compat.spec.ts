/**
 * E2E proof: Desktop renders local session cost data while safely omitting
 * cloud-only PR/branch attribution lenses.
 *
 * Desktop consumes the shared agent-session components through a local IPC data
 * source backed by SQLite. It intentionally remains `viewerScope=self` and may
 * omit the optional `byPr` / `byBranch` usage fields that cloud responses expose.
 * This spec seeds the real SQLite file while the app is down, relaunches the
 * real Electron app, and verifies the Sessions and bounded Insights views render
 * the local rows, cost, tokens, branch, and PR chip without requiring those
 * optional cloud attribution arrays.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";
import { TOTAL_TOKENS_METRIC_CARD_LABEL } from "@repo/app/agents/components/sessions/sessions-summary-card-labels.ts";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  gotoNavSettled,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  AGENT_DB_FILENAME,
  applyDesktopBusyTimeout,
  applyDesktopSeedPragmas,
  isSqliteBusyError,
} from "./helpers/desktop-seed-core";

const SEEDED_SESSION = {
  branchName: "feat/desktop-attribution-compat-e2e",
  cost: "$3.50",
  id: "desktop-attribution-compat-session",
  model: "claude-opus-4-5",
  name: "Desktop attribution compatibility session",
  prNumber: 2384,
  repoFullName: "closedloop-ai/closedloop-ai",
  // FEA-3937: the shared summary bar abbreviates token counts with
  // `formatTokenCount`, matching every other token display in the product,
  // instead of the old inline card's raw `.toLocaleString()` grouping.
  //
  // ISS-7175: 1.75k, not the 1.65k this asserted before. The tile summed
  // `input + output` (1200 + 450 = 1650) while calling itself "Total"; the
  // COMPUTATION moved to match the label, so it now sums all four counters the
  // seed writes — 1200 + 450 + 80 cache-read + 20 cache-write = 1750. The
  // expectation changed because the measured quantity did, not to go green.
  tokenTotal: "1.75k",
} as const;

test.describe("Desktop local attribution compatibility", () => {
  test("renders seeded local session cost data without PR/branch usage arrays", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-attribution-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-attribution-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-attribution-udd-")
    );

    try {
      const firstLaunch = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      await waitForAgentSessionsSchema(userDataDir);
      await firstLaunch.cleanup();

      await seedDesktopAttributionCompatibilitySession(userDataDir);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        // The COMMITTED Sessions panel. Every element query below is scoped to
        // it, because the shell's keep-alive leaves Dashboard mounted (it is the
        // canonical landing, so always the first view mounted) and Dashboard
        // renders its own `SessionsSummaryCards` — the same `[data-slot="card"]`
        // with the same "Sessions" and "Total Tokens" descriptions. Page-global,
        // every card assertion below is a strict-mode violation against that
        // hidden twin. The old `header` check does not substitute: the Topbar
        // follows the IMMEDIATE nav id, so it says "Sessions" while the body is
        // still the outgoing view.
        const sessions = await gotoNavSettled(page, "sessions");
        // The shared helper, not a hand-rolled locator: it chooses and clicks
        // inside ONE browser task, which is the only shape that survives the
        // deferred route commit. Its docstring carries the full reasoning and
        // the ISS-7995 history — every bare
        // `page.locator('[aria-label="…"]:visible').click()` in this suite has
        // failed this way, including in the Date range group Dashboard now
        // always renders alongside this one.
        await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);

        // Page-rooted on purpose: a `filter({ has })` locator is re-rooted at
        // each candidate row, so it must NOT already be scoped to the panel —
        // that would look for the panel INSIDE a row. The row locator carries
        // the scoping instead, which is what keeps this off Dashboard's grid.
        const sessionLink = page.getByRole("link", {
          name: SEEDED_SESSION.name,
        });
        const sessionRow = sessions.locator(".group.grid").filter({
          has: sessionLink,
        });
        await expect(sessionRow).toBeVisible({ timeout: 30_000 });
        // FEA-3937: the shared `SessionsSummaryCards` composite labels this card
        // "Sessions" (was "Total Sessions" on the old desktop inline bar). Anchor
        // on the exact card-description label so the substring "Sessions" can't
        // also catch a sibling card whose copy mentions "sessions".
        await expect(
          sessions
            .locator('[data-slot="card"]')
            .filter({
              has: page
                .locator('[data-slot="card-description"]')
                .getByText("Sessions", { exact: true }),
            })
            .locator('[data-slot="card-title"]')
        ).toHaveText("1", { timeout: 30_000 });
        await expect(
          sessions
            .locator('[data-slot="card"]')
            .filter({
              has: page
                .locator('[data-slot="card-description"]')
                .getByText(TOTAL_TOKENS_METRIC_CARD_LABEL, { exact: true }),
            })
            .locator('[data-slot="card-title"]')
        ).toHaveText(SEEDED_SESSION.tokenTotal, { timeout: 30_000 });
        await expect(sessionRow.getByText(SEEDED_SESSION.cost)).toBeVisible();

        // ISS-5315 made PR one of `SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS`, so the
        // PR chip is no longer in the default view — the column is one View-menu
        // switch away, exactly as a user reaches it. The claim under test is
        // unchanged (the seeded local session still attributes its PR number
        // with no PR/branch usage arrays), so the spec drives the
        // column back on rather than dropping the assertion.
        // ISS-8909: the column switches moved. The retired v1 toolbar carried a
        // always-visible "View" menu; the shared v2 toolbar folds that control
        // into "Options" → "Show / hide columns" at `md` and up, and the "View"
        // button that remains belongs to the COMPACT row, which is
        // `display:none` at this width. The claim is unchanged — the spec still
        // drives the PR column back on exactly as a user reaches it.
        await sessions
          .getByRole("button", { exact: true, name: "Options" })
          .click();
        await page
          .getByRole("menu")
          .getByRole("menuitem", { exact: true, name: "PR" })
          .click();
        await page.keyboard.press("Escape");
        // ISS-12709 (#8970): Desktop stores no GitHub PR state, so the seed no
        // longer writes one and the merge state is no longer local evidence;
        // the PR number attribution is the claim that remains.
        await expect(
          sessionRow.getByText(`#${SEEDED_SESSION.prNumber}`)
        ).toBeVisible();
        await expect(
          sessionRow.getByText(SEEDED_SESSION.branchName)
        ).toBeVisible();

        await page.screenshot({
          fullPage: true,
          path: test
            .info()
            .outputPath("desktop-sessions-local-attribution.png"),
        });

        await gotoNav(page, "insights");
        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 1,
            name: "Insights",
          })
        ).toBeVisible({ timeout: 30_000 });
        await page.getByRole("button", { name: "Load insights" }).click();
        // FEA-3989: the loaded bounded view no longer carries a "Recent session
        // activity" card heading; the seeded session link appearing is the
        // populated-load signal.
        await expect(
          page.locator("a:visible", { hasText: SEEDED_SESSION.name })
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(SEEDED_SESSION.cost).last()).toBeVisible();

        await page.screenshot({
          fullPage: true,
          path: test
            .info()
            .outputPath("desktop-insights-local-attribution.png"),
        });

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

type LibsqlClient = ReturnType<typeof createClient>;

const REQUIRED_AGENT_SESSION_TABLES = [
  "sessions",
  "artifacts",
  "session_artifact_links",
  "token_usage",
  "pull_requests",
] as const;
const REQUIRED_AGENT_SESSION_COLUMNS = {
  sessions: ["last_activity_at"],
} as const;
const AGENT_SCHEMA_POLL_INTERVAL_MS = 250;

async function waitForAgentSessionsSchema(
  userDataDir: string,
  timeoutMs = 30_000
): Promise<void> {
  const client = createClient({
    intMode: "number",
    url: `file:${agentDashboardDbPath(userDataDir)}`,
  });
  try {
    await applyDesktopBusyTimeout(client);
    await waitForTables(client, REQUIRED_AGENT_SESSION_TABLES, timeoutMs);
    await waitForColumns(
      client,
      "sessions",
      REQUIRED_AGENT_SESSION_COLUMNS.sessions,
      timeoutMs
    );
  } finally {
    client.close();
  }
}

async function seedDesktopAttributionCompatibilitySession(
  userDataDir: string
): Promise<void> {
  const observedAt = new Date().toISOString();
  const startedAt = "2026-07-02T10:00:00.000Z";
  const endedAt = "2026-07-02T10:12:00.000Z";
  const client = createClient({
    intMode: "number",
    url: `file:${agentDashboardDbPath(userDataDir)}`,
  });

  try {
    await applyDesktopSeedPragmas(client);
    await waitForTables(client, REQUIRED_AGENT_SESSION_TABLES, 30_000);

    const branchArtifactId = `artifact-branch-${SEEDED_SESSION.id}`;
    const pullRequestArtifactId = `artifact-pr-${SEEDED_SESSION.id}`;
    await client.batch(
      [
        {
          args: [
            SEEDED_SESSION.id,
            SEEDED_SESSION.name,
            SEEDED_SESSION.branchName,
            SEEDED_SESSION.model,
            startedAt,
            endedAt,
            observedAt,
            observedAt,
          ],
          sql: `INSERT INTO sessions
                  (id, name, status, cwd, model, started_at, ended_at,
                   updated_at, last_activity_at, harness, billing_mode,
                   data_revision)
                VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, 'claude', 'api',
                        1)`,
        },
        {
          args: [
            branchArtifactId,
            `branch:${SEEDED_SESSION.repoFullName}:${SEEDED_SESSION.branchName}`,
            SEEDED_SESSION.repoFullName,
            SEEDED_SESSION.branchName,
            observedAt,
            observedAt,
            observedAt,
          ],
          sql: `INSERT INTO artifacts
                  (id, identity_key, kind, repo_full_name, branch_name,
                   created_at, last_seen_at, observed_at)
                VALUES (?, ?, 'branch', ?, ?, ?, ?, ?)`,
        },
        {
          args: [
            pullRequestArtifactId,
            `pr:${SEEDED_SESSION.repoFullName}:${SEEDED_SESSION.prNumber}`,
            SEEDED_SESSION.repoFullName,
            SEEDED_SESSION.branchName,
            SEEDED_SESSION.prNumber,
            `https://github.com/${SEEDED_SESSION.repoFullName}/pull/${SEEDED_SESSION.prNumber}`,
            `Seeded PR #${SEEDED_SESSION.prNumber}`,
            endedAt,
            observedAt,
            observedAt,
          ],
          sql: `INSERT INTO artifacts
                  (id, identity_key, kind, repo_full_name, branch_name,
                   pr_number, url, title, last_seen_at, created_at,
                   observed_at)
                VALUES (?, ?, 'pull_request', ?, ?, ?, ?, ?, ?, ?, ?)`,
        },
        {
          args: [
            `link-branch-${SEEDED_SESSION.id}`,
            SEEDED_SESSION.id,
            branchArtifactId,
            observedAt,
            observedAt,
          ],
          sql: `INSERT INTO session_artifact_links
                  (id, session_id, artifact_id, relation, method, evidence,
                   is_primary, status, extractor_version, observed_at,
                   created_at)
                VALUES (?, ?, ?, 'authored', 'git_push', '{}', 1,
                        'confirmed', 1, ?, ?)`,
        },
        {
          args: [
            `link-pr-${SEEDED_SESSION.id}`,
            SEEDED_SESSION.id,
            pullRequestArtifactId,
            observedAt,
            observedAt,
          ],
          sql: `INSERT INTO session_artifact_links
                  (id, session_id, artifact_id, relation, method, evidence,
                   is_primary, status, extractor_version, observed_at,
                   created_at)
                VALUES (?, ?, ?, 'created', 'gh_pr_create', '{}', 0,
                        'confirmed', 1, ?, ?)`,
        },
        {
          args: [
            SEEDED_SESSION.id,
            SEEDED_SESSION.model,
            1200,
            450,
            80,
            20,
            1200,
            450,
            80,
            20,
            startedAt,
            endedAt,
            3.5,
            endedAt,
          ],
          sql: `INSERT INTO token_usage
                  (session_id, model, input_tokens, output_tokens,
                   cache_read_tokens, cache_write_tokens, raw_input, raw_output,
                   raw_cache_read, raw_cache_write, created_at, updated_at,
                   cost_usd_estimated, cost_currency, cost_source,
                   cost_observed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD',
                        'e2e-seed', ?)`,
        },
        {
          args: [
            `pr-${SEEDED_SESSION.id}`,
            SEEDED_SESSION.id,
            `https://github.com/${SEEDED_SESSION.repoFullName}/pull/${SEEDED_SESSION.prNumber}`,
            SEEDED_SESSION.prNumber,
            SEEDED_SESSION.repoFullName,
            SEEDED_SESSION.branchName,
            endedAt,
            observedAt,
            observedAt,
          ],
          sql: `INSERT INTO pull_requests
                  (id, session_id, pr_url, pr_number, repo_full_name,
                   branch_name, closed_at,
                   observed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        },
      ],
      "write"
    );
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

async function waitForTables(
  client: LibsqlClient,
  tables: readonly string[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const placeholders = tables.map(() => "?").join(", ");

  for (;;) {
    let result: Awaited<ReturnType<typeof client.execute>>;
    try {
      result = await client.execute({
        args: [...tables],
        sql: `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name IN (${placeholders})`,
      });
    } catch (error) {
      if (!isSqliteBusyError(error) || Date.now() > deadline) {
        throw error;
      }
      await sleep(AGENT_SCHEMA_POLL_INTERVAL_MS);
      continue;
    }
    if (result.rows.length === tables.length) {
      return;
    }
    if (Date.now() > deadline) {
      const found =
        result.rows.map((row) => String(row.name)).join(", ") || "none";
      throw new Error(
        `agent sessions DB schema did not appear within ${timeoutMs}ms (found: ${found})`
      );
    }
    await sleep(AGENT_SCHEMA_POLL_INTERVAL_MS);
  }
}

async function waitForColumns(
  client: LibsqlClient,
  table: string,
  columns: readonly string[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let result: Awaited<ReturnType<typeof client.execute>>;
    try {
      result = await client.execute(`PRAGMA table_info(${table})`);
    } catch (error) {
      if (!isSqliteBusyError(error) || Date.now() > deadline) {
        throw error;
      }
      await sleep(AGENT_SCHEMA_POLL_INTERVAL_MS);
      continue;
    }
    const foundColumns = new Set(result.rows.map((row) => String(row.name)));
    if (columns.every((column) => foundColumns.has(column))) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${table} columns did not appear within ${timeoutMs}ms (found: ${
          [...foundColumns].join(", ") || "none"
        })`
      );
    }
    await sleep(AGENT_SCHEMA_POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function agentDashboardDbPath(userDataDir: string): string {
  return path.join(userDataDir, AGENT_DB_FILENAME);
}
