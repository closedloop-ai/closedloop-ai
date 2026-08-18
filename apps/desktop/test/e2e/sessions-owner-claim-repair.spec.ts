/**
 * E2E proof for ISS-6168: a session written with no owner is repaired at
 * runtime, and the repaired value reaches the Sessions table's Owner cell in the
 * launched app.
 *
 * `apps/desktop/test/AGENTS.md`: "A pure-mapper test passing does not prove the
 * value reaches the user — assert the visible cell in the launched-app spec when
 * the mapped field is user-facing." The SQLite-level suite
 * (`test/session-owner-identity.test.ts`) proves the column is written; only this
 * spec proves the whole chain survives — identity resolution through the real
 * `/me` lookup, the db-host identity push, the claim in the db-host child, the
 * `sessions` read projection, the org-directory name lookup, and
 * `renderOwnerCell` (PR #4947 review, wongk).
 *
 * The corpus is seeded exactly as the bug produced it: `user_id`/`organization_id`
 * NULL on every row. Nothing in the seed or the schema fixes it — the app has to.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  applyDesktopSeedPragmas,
  openSeedClient,
  SEED_SCHEMA_TIMEOUT_MS,
  type SeedClient,
  sleep,
  waitForMigrationsApplied,
} from "./helpers/desktop-seed-core";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";

const OWNER = {
  apiKey: "sk_live_desktop_e2e_owner_claim",
  avatarUrl: null,
  displayName: "Mika Owner",
  email: "mika@closedloop.ai",
  firstName: "Mika",
  lastName: "Owner",
  organizationId: "org-desktop-e2e-owner-claim",
  userId: "user-desktop-e2e-owner-claim",
} as const;

const SEEDED_SESSION = {
  cwd: "/sandbox/owner-claim",
  id: "desktop-owner-claim-session",
  name: "Desktop owner claim repair session",
} as const;

const SESSION_STARTED_AT = "2026-07-02T10:00:00.000Z";
const SESSION_ENDED_AT = "2026-07-02T10:12:00.000Z";
/** Three real Electron launches plus the identity watch's poll interval. */
const SPEC_TIMEOUT_MS = 300_000;
/** How long to wait for the running app to repair the seeded row. */
const CLAIM_TIMEOUT_MS = 120_000;
const CLAIM_POLL_INTERVAL_MS = 1000;

test.describe("Desktop session owner claim repair", () => {
  test("repairs an unowned seeded session and renders its Owner cell", async () => {
    test.setTimeout(SPEC_TIMEOUT_MS);

    const dirs = makeSeededSessionsDirs("desktop-owner-claim");
    const identityServer = await startOwnerIdentityServer();
    const env = {
      CLAUDE_HOME: dirs.claudeHome,
      CL_AUTH_API_ORIGIN: identityServer.origin,
      CLOSEDLOOP_API_KEY: OWNER.apiKey,
      CODEX_HOME: dirs.codexHome,
    };

    try {
      // 1. Create + migrate the schema, then close so the seed writes alone.
      const firstLaunch = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir: dirs.userDataDir,
      });
      try {
        await withSeedClient(dirs.userDataDir, (client) =>
          waitForMigrationsApplied(client, SEED_SCHEMA_TIMEOUT_MS)
        );
      } finally {
        await firstLaunch.cleanup();
      }

      // 2. Seed the corpus in its BROKEN shape: no owner on any row.
      await seedUnownedSession(dirs.userDataDir);
      const seededOwner = await readSeededOwner(dirs.userDataDir);
      expect(seededOwner).toEqual({ organizationId: null, userId: null });

      // 3. Launch the app and let it repair the row. Polling the store rather
      //    than the screen keeps the wait bounded and deterministic: the claim
      //    writes without emitting a change event, so the mounted grid would not
      //    refetch on its own.
      const repairLaunch = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir: dirs.userDataDir,
      });
      try {
        await waitForOwnerClaimed(dirs.userDataDir);
      } finally {
        await repairLaunch.cleanup();
      }

      // 4. Relaunch and assert what the user actually sees.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir: dirs.userDataDir,
      });
      try {
        await gotoNav(page, "sessions");
        await page.locator('[aria-label="All time"]:visible').click();
        const sessionLink = page.getByRole("link", {
          name: SEEDED_SESSION.name,
        });
        await expect(sessionLink).toBeVisible({ timeout: 30_000 });
        const sessionRow = page
          .locator(".group.grid")
          .filter({ has: sessionLink });
        await expect(
          sessionRow.locator('[data-column-id="owner"]')
        ).toContainText(OWNER.displayName, { timeout: 30_000 });
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await identityServer.close();
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

type OwnerIdentityServer = { origin: string; close: () => Promise<void> };

/**
 * The two cloud reads desktop needs before an Owner cell can render a name:
 * `/me` resolves the signed-in principal the claim stamps, and `/users` is the
 * org directory `resolveOwner` looks that id up in. Anything else 404s, so a
 * spec can never pass on an accidentally permissive catch-all.
 */
async function startOwnerIdentityServer(): Promise<OwnerIdentityServer> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === "/me") {
      writeJson(response, {
        success: true,
        data: { id: OWNER.userId, organizationId: OWNER.organizationId },
      });
      return;
    }
    if (request.method === "GET" && pathname === "/users") {
      writeJson(response, {
        success: true,
        data: [
          {
            id: OWNER.userId,
            email: OWNER.email,
            firstName: OWNER.firstName,
            lastName: OWNER.lastName,
            avatarUrl: OWNER.avatarUrl,
          },
        ],
      });
      return;
    }
    response.statusCode = 404;
    writeJson(response, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Owner identity server did not bind to a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function writeJson(response: ServerResponse, body: unknown): void {
  response.statusCode = response.statusCode || 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function withSeedClient<T>(
  userDataDir: string,
  run: (client: SeedClient) => Promise<T>
): Promise<T> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    return await run(client);
  } finally {
    client.close();
  }
}

/** Insert the session exactly as the importer wrote it before the fix. */
function seedUnownedSession(userDataDir: string): Promise<void> {
  const observedAt = new Date().toISOString();
  return withSeedClient(userDataDir, async (client) => {
    await client.execute({
      args: [
        SEEDED_SESSION.id,
        SEEDED_SESSION.name,
        SEEDED_SESSION.cwd,
        SESSION_STARTED_AT,
        SESSION_ENDED_AT,
        observedAt,
        observedAt,
      ],
      sql: `INSERT INTO sessions
              (id, name, status, cwd, started_at, ended_at, updated_at,
               last_activity_at, harness, billing_mode, data_revision,
               user_id, organization_id)
            VALUES (?, ?, 'inactive', ?, ?, ?, ?, ?, 'claude', 'api', 1,
                    NULL, NULL)`,
    });
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  });
}

function readSeededOwner(
  userDataDir: string
): Promise<{ userId: string | null; organizationId: string | null }> {
  return withSeedClient(userDataDir, async (client) => {
    const result = await client.execute({
      args: [SEEDED_SESSION.id],
      sql: "SELECT user_id, organization_id FROM sessions WHERE id = ?",
    });
    const row = result.rows[0];
    return {
      userId: (row?.user_id as string | null) ?? null,
      organizationId: (row?.organization_id as string | null) ?? null,
    };
  });
}

/**
 * Wait for the RUNNING app to stamp the seeded row. The identity resolves after
 * the store opened (the resolver answers null on its first call and warms `/me`
 * in the background), so the repair arrives on the db-host identity push, not at
 * db open.
 */
async function waitForOwnerClaimed(userDataDir: string): Promise<void> {
  const deadline = Date.now() + CLAIM_TIMEOUT_MS;
  let last: { userId: string | null; organizationId: string | null } = {
    userId: null,
    organizationId: null,
  };
  while (Date.now() < deadline) {
    last = await readSeededOwner(userDataDir);
    if (last.userId !== null) {
      expect(last).toEqual({
        organizationId: OWNER.organizationId,
        userId: OWNER.userId,
      });
      return;
    }
    await sleep(CLAIM_POLL_INTERVAL_MS);
  }
  throw new Error(
    `the running app never claimed the unowned session (last read: ${JSON.stringify(last)})`
  );
}
