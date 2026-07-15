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
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { AGENT_DB_FILENAME } from "./helpers/seed-branches-db";

const SEEDED_SESSION = {
  branchName: "feat/desktop-attribution-compat-e2e",
  cost: "$3.50",
  id: "desktop-attribution-compat-session",
  model: "claude-opus-4-5",
  name: "Desktop attribution compatibility session",
  prNumber: 2384,
  repoFullName: "closedloop-ai/symphony-alpha",
  tokenTotal: "1,650",
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
        await gotoNav(page, "sessions");
        await expect(
          page.locator("header").getByText("Sessions", { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        await page
          .getByRole("group", { name: "Date range" })
          .getByLabel("All time")
          .click();

        const sessionLink = page.getByRole("link", {
          name: SEEDED_SESSION.name,
        });
        const sessionRow = page.locator(".group.grid").filter({
          has: sessionLink,
        });
        await expect(sessionRow).toBeVisible({ timeout: 30_000 });
        await expect(
          page
            .locator('[data-slot="card"]')
            .filter({ hasText: "Total Sessions" })
            .locator('[data-slot="card-title"]')
        ).toHaveText("1", { timeout: 30_000 });
        await expect(
          page
            .locator('[data-slot="card"]')
            .filter({ hasText: "Total Tokens" })
            .locator('[data-slot="card-title"]')
        ).toHaveText(SEEDED_SESSION.tokenTotal, { timeout: 30_000 });
        await expect(sessionRow.getByText(SEEDED_SESSION.cost)).toBeVisible();
        await expect(
          sessionRow.getByText(`#${SEEDED_SESSION.prNumber} Merged`)
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
            name: "Agent Monitoring",
          })
        ).toBeVisible({ timeout: 30_000 });
        await page.getByRole("button", { name: "Load insights" }).click();
        await expect(
          page.getByRole("heading", {
            exact: true,
            level: 2,
            name: "Recent session activity",
          })
        ).toBeVisible({ timeout: 30_000 });
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

async function waitForAgentSessionsSchema(
  userDataDir: string,
  timeoutMs = 30_000
): Promise<void> {
  const client = createClient({
    intMode: "number",
    url: `file:${agentDashboardDbPath(userDataDir)}`,
  });
  try {
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
    for (const pragma of [
      "PRAGMA journal_mode=WAL",
      "PRAGMA busy_timeout=15000",
      "PRAGMA foreign_keys=ON",
    ]) {
      await client.execute(pragma);
    }
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
                   pr_number, url, title, pr_state, last_seen_at, created_at,
                   observed_at)
                VALUES (?, ?, 'pull_request', ?, ?, ?, ?, ?, 'MERGED', ?, ?, ?)`,
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
            endedAt,
            `Seeded PR #${SEEDED_SESSION.prNumber}`,
            observedAt,
            observedAt,
          ],
          sql: `INSERT INTO pull_requests
                  (id, session_id, pr_url, pr_number, repo_full_name,
                   branch_name, state, closed_at, merged_at, title,
                   observed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?)`,
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
    const result = await client.execute({
      args: [...tables],
      sql: `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN (${placeholders})`,
    });
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
    await sleep(250);
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
    const result = await client.execute(`PRAGMA table_info(${table})`);
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
    await sleep(250);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function agentDashboardDbPath(userDataDir: string): string {
  return path.join(userDataDir, AGENT_DB_FILENAME);
}
