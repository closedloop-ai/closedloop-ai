/**
 * ISS-5575 (wongk, #4971 — Electron twin of `e2e/session-detail-stale-duration.spec.ts`):
 * the session-detail Duration reads the DISPLAYED status, over the LOCAL
 * SQLite/IPC read path.
 *
 * The derivation (`packages/app/agents/lib/session-detail-duration-window.ts`)
 * is mounted by both shells, but its two new inputs — `last_activity_at` and
 * `awaiting_input_since` — reach this renderer through `mapDetail`, not through
 * a cloud projection. A mapping change that drops either leaves every vitest
 * suite green while this screen silently stops folding, or folds a run that is
 * blocked on a human. Only a real read catches that, which is why this spec
 * seeds the store rather than a payload.
 *
 * The local read is also where the second case actually BITES: `mapDetail`
 * inherits the RAW canonical status unless the independent
 * `sessions-displayed-status-parity` Labs flag is on, so an awaiting-input
 * session arrives here as `active` with the timestamp beside it — the exact
 * shape that folded to Stale and stopped the Duration while the title chip on
 * the same screen still read "Waiting".
 *
 * ISS-6455 extends it to the LIST cell the same rows render, which is the half
 * that regressed next: the projection moved into `session-table-row.ts`, whose
 * inputs reach this renderer through the local `mapListItem` rather than a
 * cloud projection. Asserting the badge and the Duration on BOTH surfaces in one
 * run is what makes this a parity spec rather than two independent claims.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  gotoHash,
  gotoNav,
  launchDesktopApp,
  widenToAllTime,
} from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const HOUR_MS = 60 * 60 * 1000;
/**
 * Instants are RELATIVE TO THE RUN CLOCK. The staleness fold compares last
 * activity against `new Date()` in the running renderer, so a pinned literal
 * would drift across the 24h cutoff as the calendar moved and invert the
 * control. It also keeps the seeds inside the boot retention sweep's window.
 */
const RUN_START_MS = Date.now();
const STARTED_AT = new Date(RUN_START_MS - 64 * HOUR_MS).toISOString();
/** Past the 24h display cutoff — the filed SES-78262 gap. */
const SILENT_63H = new Date(RUN_START_MS - 63 * HOUR_MS).toISOString();
const AWAITING_SINCE = new Date(RUN_START_MS - 40 * HOUR_MS).toISOString();
/** `updated_at`: recent, so the boot stale sweep leaves the row `active`. */
const SYNCED_AT = new Date(RUN_START_MS - 60_000).toISOString();

const STALE_SESSION_ID = "iss-5575-stale-active";
const STALE_SESSION_NAME = "iss-5575 silent active session";
const WAITING_SESSION_ID = "iss-5575-awaiting-input";
const WAITING_SESSION_NAME = "iss-5575 awaiting input session";

/**
 * The staleness sentence (`SESSION_STALE_TOOLTIP`) and the `active` wire value,
 * as literals: this spec runs against a PACKAGED renderer and cannot import
 * `@closedloop-ai/loops-api`. The constant itself is pinned by the vitest suites that do
 * import it.
 */
const SESSION_STATUS_ACTIVE = "active";
const STALE_EXPLANATION_RE = /No activity for over 24 hours/;

/** `formatDuration` output, e.g. "64h 0m". Never rendered for an empty span. */
const MEASURED_DURATION_RE = /\d+h \d+m/;
const EM_DASH = "—";
const MOUNT_TIMEOUT_MS = 30_000;

/**
 * `SESSION_STATUS_LABELS` for the two DISPLAY-only words this spec reads off the
 * list's Status cell. Literals for the same reason the sentence above is one:
 * the packaged renderer this drives cannot import `@repo/api`.
 */
const WAITING_STATUS_LABEL = "Waiting";
const STALE_STATUS_LABEL = "Stale";

/**
 * Both rows keep a RECENT `updated_at`. The boot stale sweep reaps an `active`
 * row whose `updated_at` predates `DEFAULT_STALE_SESSION_MINUTES` (180) into
 * `inactive` with `ended_at = last_activity_at`, so an old `updated_at` deletes
 * the very state under test before the renderer reads it — the row arrives
 * terminal with a real end and renders a number for a completely different
 * reason. Recent `updated_at` + ancient `last_activity_at` IS the population the
 * display fold exists for: a cloud-synced session whose row keeps being touched
 * while its agent has said nothing for days.
 */
const SEEDED: SessionListSeed[] = [
  {
    at: STARTED_AT,
    // Not ended, and silent past the cutoff: the display stops believing the
    // stored `active`, so the Duration has nothing honest to measure to.
    endedAt: null,
    lastActivityAt: SILENT_63H,
    name: STALE_SESSION_NAME,
    sessionId: STALE_SESSION_ID,
    status: SESSION_STATUS_ACTIVE,
    updatedAt: SYNCED_AT,
  },
  {
    at: STARTED_AT,
    // The SAME silence, blocked on a human. `waiting` is never persisted as a
    // status — the timestamp IS the signal (root `AGENTS.md`).
    awaitingInputSince: AWAITING_SINCE,
    endedAt: null,
    lastActivityAt: SILENT_63H,
    name: WAITING_SESSION_NAME,
    sessionId: WAITING_SESSION_ID,
    status: SESSION_STATUS_ACTIVE,
    updatedAt: SYNCED_AT,
  },
];

test.describe("Session Duration reads the displayed status (ISS-5575)", () => {
  test("a silent active run folds, an awaiting-input one keeps measuring — in the list and on the detail", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-stale-duration-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts into the store,
    // polluting the seeded corpus this spec pins.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-stale-duration-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-stale-duration-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
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

      // Seed while the app is DOWN (no cross-process WAL contention).
      await seedSessionsList(userDataDir, SEEDED);

      // Launch 2 — the real local IPC read path projects the seeded corpus.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        // ISS-6455 (wongk, #5099 review): the LIST first, over the same
        // SQLite -> IPC -> renderer path. The fix moved the awaiting-input
        // projection into `session-table-row.ts`, which only this surface runs
        // — a component test hands the mapper an already-shaped row and stays
        // green if the local adapter drops `awaiting_input_since` before it
        // gets there. The detail assertions below then read as the parity claim
        // they are: one record, one answer, one click apart.
        await gotoNav(page, "sessions");
        // Widen so the 64h-old seeds are in range regardless of the default
        // window. The shared helper, not a bare click: a blind click on an
        // already-selected toggle races the surface's first paint and waits out
        // the full timeout (see its docstring).
        await widenToAllTime(page);

        const waitingRow = await sessionRow(page, WAITING_SESSION_NAME);
        // A run that asked for approval 40 hours ago is still awaiting input,
        // so the row badges the projection instead of folding it away...
        await expect(
          waitingRow.locator('[data-column-id="status"]')
        ).toHaveText(WAITING_STATUS_LABEL, { timeout: MOUNT_TIMEOUT_MS });
        // ...and keeps measuring. This cell held the em-dash before the fix,
        // one click from a detail Duration still climbing against `now()`.
        await expect(
          waitingRow.locator('[data-column-id="duration"]')
        ).toHaveText(MEASURED_DURATION_RE);

        // The control that stops the above from being a blanket "every silent
        // row keeps measuring": the same silence WITHOUT the awaiting-input
        // anchor still folds, on both cells.
        const staleRow = await sessionRow(page, STALE_SESSION_NAME);
        await expect(staleRow.locator('[data-column-id="status"]')).toHaveText(
          STALE_STATUS_LABEL
        );
        await expect(
          staleRow.locator('[data-column-id="duration"]')
        ).toHaveText(EM_DASH);

        await gotoHash(page, `/sessions/${STALE_SESSION_ID}`);
        await expect(page.locator("h1")).toHaveText(STALE_SESSION_NAME, {
          timeout: MOUNT_TIMEOUT_MS,
        });

        const staleDuration = await openDurationRow(page);
        // The shipped defect: a number climbing against `now()` here while the
        // list cell one click away had already folded to the em-dash.
        await expect(staleDuration).toContainText(EM_DASH, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(staleDuration).not.toContainText(MEASURED_DURATION_RE);
        // ...and the dash is not bare. The sentence is the tail of the value's
        // accessible name, so it is reachable without a hover.
        await expect(
          staleDuration.getByRole("button", { name: STALE_EXPLANATION_RE })
        ).toBeVisible();

        await gotoHash(page, `/sessions/${WAITING_SESSION_ID}`);
        await expect(page.locator("h1")).toHaveText(WAITING_SESSION_NAME, {
          timeout: MOUNT_TIMEOUT_MS,
        });

        const waitingDuration = await openDurationRow(page);
        // A run that asked for approval 40 hours ago genuinely IS still awaiting
        // input, so the fold must not reach it — the control that stops the case
        // above from being a blanket "old sessions show no Duration".
        await expect(waitingDuration).toContainText(MEASURED_DURATION_RE, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(
          waitingDuration.getByRole("button", { name: STALE_EXPLANATION_RE })
        ).toHaveCount(0);

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
      fs.rmSync(userDataDir, { force: true, recursive: true });
    }
  });
});

/**
 * The Sessions LIST row for a seeded session, proven visible before it is read.
 * Every assertion made against it is scoped to one of its cells, and a cell
 * locator that resolves to nothing satisfies a text assertion vacuously — so the
 * row link is awaited here rather than at each call site.
 */
async function sessionRow(page: Page, sessionName: string): Promise<Locator> {
  const rowLink = page.getByRole("link", { name: sessionName });
  await expect(rowLink).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  return page.locator('[role="row"]').filter({ has: rowLink });
}

/**
 * Opens the collapsed Properties panel on the mounted detail and returns its
 * Duration row. Re-opened per session because a hash navigation remounts the
 * panel in its default collapsed state.
 */
async function openDurationRow(page: Page) {
  const properties = page
    .getByRole("button", { name: "Properties" })
    .filter({ visible: true });
  await expect(properties).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await properties.click();
  return page.locator(".prd-prop").filter({
    has: page.locator(".prd-prop-label", { hasText: "Duration" }),
  });
}
