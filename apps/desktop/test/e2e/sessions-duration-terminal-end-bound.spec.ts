/**
 * ISS-5182: a TERMINAL session's Duration is bounded by its own frozen
 * `ended_at`, and activity recorded after that end may not extend it — proved
 * through the launched app, not through the mapper.
 *
 * `apps/desktop/test/AGENTS.md` is explicit that a green unit does not prove the
 * value reaches the user: `session-trace-wall-clock-anchor.test.ts` calls
 * `buildSessionTraceSyncFields` directly, so a broken SQLite → sync-projection →
 * IPC → renderer handoff would leave it green while the Duration cell still
 * rendered the inflated number. This spec puts the ISS-5131 production
 * timestamps into the real store and reads the two surfaces a person actually
 * looks at.
 *
 * The fixture is session `019f02703d`'s reported shape, verbatim in its spans: a
 * run that started at T0 and was frozen terminal at T0 + 31h 4m, whose
 * `last_activity_at` then kept being recomputed at ingest for six more days out
 * to T0 + 170h 30m. Under the pre-ISS-5182 activity-first anchor the collector
 * adopted that later instant and every Duration surface read "170h 30m" — a 5.5x
 * inflation on a session that had been over for most of a week.
 *
 * WHAT THIS SPEC BINDS, AND WHAT IT NO LONGER BINDS. It was written against the
 * pre-ISS-5131 renderer, where the Duration cell led with the collector's
 * `wallClock` — so removing the activity-first anchor in `resolveTraceEndMs` was
 * observable right here, as "170h 30m" turning into "31h 4m". ISS-5131 (#4409)
 * then made every Duration surface read exactly two inputs, `status` and
 * `endedAt` (`resolveSessionDurationWindow`), and consult neither `wallClock`
 * nor `lastActivityAt`. The collector's trace end therefore no longer reaches
 * any Duration surface, and no assertion below can distinguish the two anchors.
 * The ISS-5182 collector change is pinned by unit tests instead —
 * `session-trace-wall-clock-anchor.test.ts`,
 * `session-trace-duration-fields.test.ts`, and
 * `packages/lib/session-trace/derivation.test.ts` — which call
 * `buildSessionTraceSyncFields` / `resolveActivityEndMs` directly.
 *
 * What it still earns its runtime for is the END-TO-END bound on ISS-5131's own
 * reported record: SQLite -> sync projection -> IPC -> renderer, against the
 * real `019f02703d` spans, proving a post-terminal `last_activity_at` and a
 * post-terminal collector turn reach neither Duration surface. That overlaps
 * `sessions-duration-parity.spec.ts`, which asserts the same rule on a scaled
 * fixture and additionally covers the ISS-4675 timeline-axis caption; this one
 * carries the reported 5.5x numbers verbatim.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  breadcrumbParentLink,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SESSION_ID = "iss-5182-terminal-end-bound";
const SESSION_NAME = "iss-5182 terminal end bound session";

/**
 * ISS-5131's real spans, to the millisecond: `2026-07-28T14:58:31.028Z` →
 * `2026-07-29T22:02:53.365Z` is the run, and `2026-08-04T17:28:37.425Z` is the
 * drifted `last_activity_at` six days later. `formatTraceDuration` renders them
 * as "31h 4m" and "170h 30m" — the two numbers the report named.
 */
const TRUE_SPAN_MS = 31 * 3_600_000 + 4 * 60_000 + 22_337;
const DRIFTED_SPAN_MS = 170 * 3_600_000 + 30 * 60_000 + 6397;

// Dated relative to the run clock, not pinned to a literal: `last_activity_at`
// is the boot retention sweep's age anchor (it deletes terminal sessions whose
// last activity predates the 90-day window), so a fixed past date would quietly
// become a time bomb that deletes the corpus once the calendar caught up.
const STARTED_AT = new Date(
  Date.now() - DRIFTED_SPAN_MS - 3_600_000
).toISOString();
/** The end frozen at the terminal transition — the only bound Duration may use. */
const ENDED_AT = new Date(Date.parse(STARTED_AT) + TRUE_SPAN_MS).toISOString();
/** The post-terminal drift the collector must ignore. */
const DRIFTED_ACTIVITY_AT = new Date(
  Date.parse(STARTED_AT) + DRIFTED_SPAN_MS
).toISOString();

const EXPECTED_DURATION = "31h 4m";
/** The number the defect rendered. It must reach no Duration surface. */
const INFLATED_DURATION = "170h 30m";
/** Shared mount barrier for the launched renderer's slower first paint. */
const MOUNT_TIMEOUT_MS = 30_000;

const SEEDED: SessionListSeed[] = [
  {
    at: STARTED_AT,
    endedAt: ENDED_AT,
    // Pin `last_activity_at` to the start instant so the ONLY post-end signal in
    // this fixture is the trace turn below. Without the pin the helper defaults
    // this column to "now", and the assertions could not tell "the collector
    // ignored the late turn" from "the column happened to be early".
    lastActivityAt: STARTED_AT,
    name: SESSION_NAME,
    sessionId: SESSION_ID,
    status: "inactive",
    // The defect's signature: a collector-observed turn six days PAST the
    // session's own end. Pre-ISS-5182 this anchored the wall window.
    traceMessageAt: DRIFTED_ACTIVITY_AT,
  },
];

test.describe("Sessions Duration is bounded by a terminal end (ISS-5182)", () => {
  test("post-terminal activity drift reaches neither the list cell nor the detail row", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-terminal-end-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts into the store,
    // polluting the seeded corpus this spec pins.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-terminal-end-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-terminal-end-udd-")
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
        await gotoNav(page, "sessions");
        // Widen to "All time" so the seed is in range regardless of the default
        // window. `:visible` scopes to the mounted Sessions toolbar.
        await page.locator('[aria-label="All time"]:visible').click();

        // Prove the row rendered before asserting anything negative about it.
        const rowLink = page.getByRole("link", { name: SESSION_NAME });
        await expect(rowLink).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        const listDuration = page
          .locator('[role="row"]')
          .filter({ has: rowLink })
          .locator('[data-column-id="duration"]');

        await expect(listDuration).toHaveText(EXPECTED_DURATION, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(listDuration).not.toHaveText(INFLATED_DURATION);

        await rowLink.click();
        await expect(breadcrumbParentLink(page, "Sessions")).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });

        // The Properties panel is collapsed by default; the Duration row is
        // inside it.
        await page
          .getByRole("button", { name: "Properties" })
          .filter({ visible: true })
          .click();
        const durationRow = page.locator(".prd-prop").filter({
          has: page.locator(".prd-prop-label", { hasText: "Duration" }),
        });

        // Same bound, on the other surface. No qualifier: ISS-5131 (#4409)
        // removed the "wall" suffix and the active/waiting sub-facts from this
        // row, leaving it printing one measure.
        await expect(durationRow).toContainText(EXPECTED_DURATION, {
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(durationRow).not.toContainText(INFLATED_DURATION);

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
