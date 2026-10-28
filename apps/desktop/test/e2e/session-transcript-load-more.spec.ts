/**
 * ISS-9857: "Load more events" on the DESKTOP (Electron) adapter — the flag-gated
 * control that walks the transcript past the detail read's 10,000-event prefix
 * through the `desktop:shared-agent-sessions:events` IPC page.
 *
 * WHY A DESKTOP SPEC AND NO WEB TWIN. The control renders only on the panel's
 * Projection branch (a detail with no parsed transcript), and on the web that
 * branch never renders — a cloud detail always carries a main transcript
 * summary. The desktop-local read is where a 10,001-event session projects
 * from raw rows, so this is the surface the affordance is reachable on
 * (`apps/desktop/AGENTS.md` → E2E Coverage for UI Surfaces).
 *
 * HOW THE CORPUS IS SHAPED. The seeded stream is `SESSION_DETAIL_EVENT_MAX_ROWS
 * + 1` rows, so the detail serves exactly the prefix and reports
 * `eventsTruncated`. The last prefix row and the one row past it SHARE a
 * `created_at`: the client mints its first cursor from the prefix's last row,
 * so this pair is the boundary the `(created_at, id)` keyset must decide by id
 * alone — a `created_at`-only page would skip the beyond-row or repeat the
 * prefix's last. Event ids are zero-padded so their text order matches their
 * index order, which is what makes that tiebreak deterministic.
 *
 * The bulk of the prefix is tool events, which the projection coalesces into
 * one `tools` card, so the DOM stays small; the rows that must be found by
 * text are prompt rows, which each render as their own turn.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits.ts";
import { SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY } from "@repo/api/src/types/session-transcript-load-more-events-flag.ts";
import {
  LOAD_MORE_EVENTS_ERROR,
  LOAD_MORE_EVENTS_LABEL,
  LOADING_MORE_EVENTS_LABEL,
} from "@repo/app/agents/components/detail/transcript-load-more-copy.ts";
import { z } from "zod";
import {
  CONTROL_STABILITY_ATTRIBUTE,
  observeControlIdentity,
} from "./helpers/control-identity-observation.js";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import {
  applyDesktopSeedPragmas,
  openSeedClient,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForColumnsPresent,
} from "./helpers/desktop-seed-core";
import { mergeE2eFeatureFlagAssignment } from "./helpers/e2e-feature-flag-assignment-seed";
import {
  recordDbChangedPushes,
  waitForLiveBridgeQuiescence,
} from "./helpers/live-bridge-quiescence";
import { createReadinessFailureDiagnostic } from "./helpers/readiness-failure-diagnostic";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SESSION_ID = "iss-9857-load-more-session";
const SESSION_NAME = "ISS-9857 load more session";

const SESSION_START = "2026-06-10T12:00:00.000Z";
const SESSION_END = "2026-06-10T14:00:00.000Z";
const START_MS = Date.parse(SESSION_START);

/** The prefix plus ONE row past it — the smallest stream the detail truncates. */
const EVENT_COUNT = SESSION_DETAIL_EVENT_MAX_ROWS + 1;
/** Index of the last row the detail serves. */
const LAST_PREFIX_INDEX = SESSION_DETAIL_EVENT_MAX_ROWS - 1;
/** Index of the one row only the events page can reach. */
const BEYOND_INDEX = SESSION_DETAIL_EVENT_MAX_ROWS;

const PROMPT_EVENT_TYPE = "UserPromptSubmit";
const TOOL_EVENT_TYPES = ["PreToolUse", "PostToolUse"] as const;
const TOOL_NAME = "SeedTool";

const PREFIX_LANDMARK_TEXT = "ISS-9857 first prefix row";
const LAST_PREFIX_TEXT = "ISS-9857 last prefix row";
const BEYOND_PREFIX_TEXT = "ISS-9857 beyond the prefix";

const END_OF_READ_NOTE = /^End of what we could read/;
const LOAD_MORE_NAME = LOAD_MORE_EVENTS_LABEL;
const LOADING_MORE_NAME = LOADING_MORE_EVENTS_LABEL;
/** The control's own error copy; other alerts on the page are not its concern. */
const LOAD_MORE_ERROR = LOAD_MORE_EVENTS_ERROR;

/** Rows per INSERT statement; well under SQLite's bound-parameter ceiling. */
const INSERT_CHUNK_ROWS = 500;
const EVENTS_TABLE = "events";
const EVENT_REQUIRED_COLUMNS = [
  "id",
  "session_id",
  "event_type",
  "tool_name",
  "summary",
  "created_at",
] as const;

/**
 * Generous against a one-page corpus: the loop below ends when the control
 * retires, and this only stops a producer that never stops minting cursors.
 */
const MAX_PAGE_CLICKS = 10;

const MOUNT_TIMEOUT_MS = 60_000;
/** The cold-store launch that creates and migrates the schema. */
const SCHEMA_TIMEOUT_MS = 120_000;
const settledStartupSchema = z.object({
  dashboardReady: z.literal(true),
  maintenance: z.object({ active: z.literal(false) }),
});

type EventRow = {
  id: string;
  eventType: string;
  toolName: string | null;
  summary: string;
  createdAt: string;
};

/**
 * Ids padded so `id` text order equals index order — the keyset's tiebreak.
 */
function eventId(index: number): string {
  return `${SESSION_ID}-event-${String(index).padStart(5, "0")}`;
}

function eventRows(): EventRow[] {
  const rows: EventRow[] = [];
  for (let index = 0; index < EVENT_COUNT; index++) {
    // The beyond-row shares the last prefix row's instant: the straddling pair.
    const atIndex = index === BEYOND_INDEX ? LAST_PREFIX_INDEX : index;
    const createdAt = new Date(START_MS + atIndex).toISOString();
    if (index === 0) {
      rows.push(promptRow(index, PREFIX_LANDMARK_TEXT, createdAt));
    } else if (index === LAST_PREFIX_INDEX) {
      rows.push(promptRow(index, LAST_PREFIX_TEXT, createdAt));
    } else if (index === BEYOND_INDEX) {
      rows.push(promptRow(index, BEYOND_PREFIX_TEXT, createdAt));
    } else {
      rows.push({
        id: eventId(index),
        eventType: TOOL_EVENT_TYPES[index % TOOL_EVENT_TYPES.length] ?? "",
        toolName: TOOL_NAME,
        summary: `tool call ${index}`,
        createdAt,
      });
    }
  }
  return rows;
}

function promptRow(
  index: number,
  summary: string,
  createdAt: string
): EventRow {
  return {
    id: eventId(index),
    eventType: PROMPT_EVENT_TYPE,
    toolName: null,
    summary,
    createdAt,
  };
}

/**
 * Insert the whole stream while the app is DOWN, in chunked multi-row
 * statements. `seedSessionEvents` would issue one statement per row; at 10,001
 * rows that is the difference between a seed and a timeout.
 */
async function seedEventStream(userDataDir: string): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await waitForColumnsPresent(
      client,
      EVENTS_TABLE,
      EVENT_REQUIRED_COLUMNS,
      SEED_SCHEMA_TIMEOUT_MS
    );
    const rows = eventRows();
    const statements: { sql: string; args: (string | null)[] }[] = [];
    for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
      const chunk = rows.slice(start, start + INSERT_CHUNK_ROWS);
      statements.push({
        sql: `INSERT INTO events
                (id, session_id, event_type, tool_name, summary, created_at)
              VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
        args: chunk.flatMap((row) => [
          row.id,
          SESSION_ID,
          row.eventType,
          row.toolName,
          row.summary,
          row.createdAt,
        ]),
      });
    }
    await client.batch(statements, "write");
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

async function openSeededSession(page: Page): Promise<void> {
  await gotoHash(page, `/sessions/${SESSION_ID}`);
  await expect(page.getByText(SESSION_NAME).first()).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  // The prefix's own prompt rows: the projected trace mounted and served the
  // detail's bounded set, so the assertions below are about the boundary and
  // not about a panel that never rendered.
  await expect(page.getByText(PREFIX_LANDMARK_TEXT)).toBeVisible({
    timeout: MOUNT_TIMEOUT_MS,
  });
  await expect(page.getByText(LAST_PREFIX_TEXT)).toBeVisible();
}

test.describe("Session transcript load more (desktop adapter)", () => {
  test("walks past the detail prefix behind the flag, and offers nothing without it", async () => {
    test.setTimeout(420_000);

    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss9857-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, then close so the seed
      // below writes with no cross-process WAL contention.
      const first =
        await test.step("launch the original transcript schema or subject", () =>
          launchDesktopApp({
            keepUserDataDir: true,
            userDataDir,
          }));
      try {
        await test.step("await original branch schema", () =>
          waitForBranchesSchema(userDataDir, SCHEMA_TIMEOUT_MS));
      } finally {
        await first.cleanup();
      }

      // `idle` withholds the seeder's own default tool event, so the stream is
      // exactly the rows seeded next and the boundary lands where computed.
      await test.step("seed the original transcript Sessions row", () =>
        seedSessionsList(userDataDir, [
          {
            at: SESSION_START,
            endedAt: SESSION_END,
            idle: true,
            name: SESSION_NAME,
            sessionId: SESSION_ID,
          },
        ]));
      await seedEventStream(userDataDir);

      // Launch 2 — flag ON. The renderer resolves the signed-in account's
      // PostHog assignment from the seeded file, the same path a rollout
      // arrives on; there is no desktop Labs toggle to pair with the key.
      const withFlag =
        await test.step("launch the original transcript schema or subject", () =>
          launchDesktopApp({
            beforeLaunch: (dir) =>
              mergeE2eFeatureFlagAssignment(dir, {
                [SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY]: true,
              }),
            keepUserDataDir: true,
            userDataDir,
          }));
      try {
        await recordDbChangedPushes(withFlag.page);
        // The shell is visible during startup. A quiet DB-change window can
        // precede a still-running rebuild, whose final push resets loaded pages.
        await waitForStartupMaintenance(withFlag.page);
        await openSeededSession(withFlag.page);
        // The fresh store's boot maintenance (rollups, heals) is still pushing
        // `desktop:db:changed`, and each push refetches the detail this control
        // sits under. Let the bridge go quiet first, so the click below lands
        // on a control that stays mounted.
        const identity = await observeControlIdentity(
          withFlag.page,
          LOAD_MORE_NAME
        );
        try {
          await waitForLiveBridgeQuiescence(withFlag.page);
          await identity.finish();
        } finally {
          await identity.dispose();
        }
        // The panel replaces its rows once after mount (the transcript read
        // settles into the projection); a click on the node that is about to
        // be swapped is lost, so wait for the control to keep its identity.
        await waitForStableControl(withFlag.page);
        // The detail served the prefix and said so; the control is offered
        // beside the note rather than in place of it, because the rows on
        // screen really do stop early until the page lands.
        const note = withFlag.page.getByText(END_OF_READ_NOTE);
        await expect(note).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        const loadMore = withFlag.page.getByRole("button", {
          name: LOAD_MORE_NAME,
        });
        await expect(loadMore).toBeVisible();
        await expect(withFlag.page.getByText(BEYOND_PREFIX_TEXT)).toHaveCount(
          0
        );
        await loadMore.scrollIntoViewIfNeeded();
        await withFlag.page.screenshot({
          path: test
            .info()
            .outputPath("session-transcript-load-more-offered.png"),
        });

        // Click until the control retires. One page suffices for this corpus
        // (one row past the prefix, well under a page), but the loop is what
        // the assertion is about: the walk ends when the producer stops minting
        // a cursor, not after a count this spec would otherwise hardcode.
        //
        // The control is one button under two names — `Load more events` when
        // it can be clicked, `Loading more events…` while a page is in flight —
        // so "is it mounted" is asked of the pair. A click is settled once the
        // trace it extends has changed under it: the last page retires the
        // control, and every other page lands at least one event (a page with
        // none mints no cursor), so the rendered rows differ from the snapshot
        // taken before the click. Nothing here waits on the busy name being
        // SEEN: the IPC page can land before React paints the in-flight state.
        const busy = withFlag.page.getByRole("button", {
          name: LOADING_MORE_NAME,
        });
        const control = loadMore.or(busy);
        const trace = withFlag.page.locator(".sd3-trace");
        for (let click = 0; (await control.count()) > 0; click++) {
          expect(
            click,
            "the walk retires the control within a bounded number of pages"
          ).toBeLessThan(MAX_PAGE_CLICKS);
          // A trace refresh can replace the control while we scroll. Scroll
          // first, wait for the node to stay put, then click the current node.
          await loadMore.scrollIntoViewIfNeeded();
          await waitForStableControl(withFlag.page);
          const rowsBefore = await trace.innerText();
          await loadMore.click();
          await expect
            .poll(
              async () =>
                (await control.count()) === 0 ||
                ((await busy.count()) === 0 &&
                  (await trace.innerText()) !== rowsBefore),
              { timeout: MOUNT_TIMEOUT_MS }
            )
            .toBe(true);
          await expect(loadMoreError(withFlag.page)).toHaveCount(0);
        }

        // The row only the page could reach is on screen, in the same trace as
        // the prefix's last row — the union re-projection, not a second list.
        await expect(withFlag.page.getByText(BEYOND_PREFIX_TEXT)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(withFlag.page.getByText(LAST_PREFIX_TEXT)).toBeVisible();
        // At exhaustion the rows on screen ARE the whole stream, so the note
        // that says they stop early is gone rather than left contradicting them.
        await expect(note).toHaveCount(0);
        await expect(loadMore).toHaveCount(0);
        await expect(loadMoreError(withFlag.page)).toHaveCount(0);
        // Rows can remount while Playwright waits for scroll actionability.
        // Scroll their owning viewport, then resolve the row afresh to prove
        // the exhausted screenshot actually includes the paged event.
        await withFlag.page.locator(".sd3-scroll").evaluate((scroller) => {
          scroller.scrollTop = scroller.scrollHeight;
        });
        await expect(
          withFlag.page.getByText(BEYOND_PREFIX_TEXT)
        ).toBeInViewport();
        await withFlag.page.screenshot({
          path: test
            .info()
            .outputPath("session-transcript-load-more-exhausted.png"),
        });

        expect(withFlag.pageErrors).toEqual([]);
      } finally {
        await withFlag.cleanup();
      }

      // Launch 3 — flag OFF, same profile. The note alone, exactly as before
      // ISS-9857: no control, and nothing past the prefix reachable.
      const withoutFlag =
        await test.step("launch the original transcript schema or subject", () =>
          launchDesktopApp({
            beforeLaunch: (dir) =>
              mergeE2eFeatureFlagAssignment(dir, {
                [SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY]: false,
              }),
            keepUserDataDir: true,
            userDataDir,
          }));
      try {
        await openSeededSession(withoutFlag.page);

        await expect(withoutFlag.page.getByText(END_OF_READ_NOTE)).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(
          withoutFlag.page.getByRole("button", { name: LOAD_MORE_NAME })
        ).toHaveCount(0);
        await expect(
          withoutFlag.page.getByText(BEYOND_PREFIX_TEXT)
        ).toHaveCount(0);
        await withoutFlag.page
          .getByText(END_OF_READ_NOTE)
          .scrollIntoViewIfNeeded();
        await withoutFlag.page.screenshot({
          path: test
            .info()
            .outputPath("session-transcript-load-more-flag-off.png"),
        });

        expect(withoutFlag.pageErrors).toEqual([]);
      } finally {
        await withoutFlag.cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

/**
 * The control's error line, and only that. The detail page carries other
 * `role="alert"` notices of its own (a seeded session with no harness draws
 * the "rendering not yet available" status), so a bare alert count would fail
 * on a page whose load-more worked.
 */
function loadMoreError(page: Page) {
  return page.getByRole("alert").filter({ hasText: LOAD_MORE_ERROR });
}

/**
 * Resolve once the control has kept the SAME DOM node across two polls. The
 * detail page swaps its transcript rows once after mount, and a click that
 * lands on the node about to be swapped is a click on nothing.
 */
async function waitForStableControl(page: Page): Promise<void> {
  const tagControl = () =>
    page.evaluate(
      ({ name, attribute }) => {
        const control = Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === name
        );
        if (!control) {
          return false;
        }
        const alreadyTagged = control.getAttribute(attribute) === "yes";
        control.setAttribute(attribute, "yes");
        return alreadyTagged;
      },
      { name: LOAD_MORE_NAME, attribute: CONTROL_STABILITY_ATTRIBUTE }
    );
  await expect
    .poll(tagControl, { intervals: [1000], timeout: MOUNT_TIMEOUT_MS })
    .toBe(true);
}

async function waitForStartupMaintenance(page: Page): Promise<void> {
  const diagnostic = createReadinessFailureDiagnostic(
    test.info(),
    "transcript-startup-last-report"
  );
  try {
    await test.step("await original dashboard and maintenance readiness", async () => {
      await expect
        .poll(
          async () => {
            const status = await page.evaluate(() => {
              const desktopApi = Reflect.get(globalThis, "desktopApi") as {
                getRuntimeStatus?: () => unknown;
              };
              return desktopApi.getRuntimeStatus?.();
            });
            diagnostic.observe(status);
            return settledStartupSchema.safeParse(status).success;
          },
          { timeout: MOUNT_TIMEOUT_MS }
        )
        .toBe(true);
    });
  } catch (error) {
    await diagnostic.attach().catch(() => undefined);
    throw error;
  }
}
