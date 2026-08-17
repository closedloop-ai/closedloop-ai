/**
 * E2E proof of the FEA-4194 post-revert Sessions contract, driven seed-to-render
 * through the real desktop SQLite store — the only place SQLite hydration is
 * composed through the renderer (`SessionsView` -> `SessionsToolbar` /
 * `SyncedSessionsTable`).
 *
 * FEA-4194 reverted the unapproved Substantive | Idle | All quality segment.
 * This spec is the trimmed successor to the deleted `sessions-idle-quality.spec.ts`
 * (which drove all three segments). It pins the two things that must remain true
 * after the revert, against a corpus that deliberately contains one substantive
 * and one genuinely idle row:
 *
 *   1. The quality segment control is GONE — no `role="group"` named
 *      "Filter sessions by quality" and no `Substantive` radio in the toolbar.
 *      A future re-introduction of the taxonomy fails HERE, by name.
 *   2. With no `quality` filter sent (the server defaults an absent value to
 *      `all`, fail-open), the mixed corpus renders in full — BOTH the
 *      substantive and the idle row.
 *
 * ISS-5770 changed the second claim's tail. It used to add "…and the idle row
 * still carries the canonical `IdleConcept.PhantomSession` badge". That badge
 * rendered only inside the `Signals` (`qualifiers`) column, which ISS-5770
 * removed to match the Sessions prototype, taking the chip's sole render site
 * (`session-row-state-chips.tsx`) with it. The chip was NOT re-homed. The
 * assertion below is therefore inverted — it now pins the absence, by the same
 * canonical label — so the loss is recorded in the suite rather than silently
 * untested, and re-homing the chip later turns this red as the cue to restore
 * the positive form.
 *
 * DO NOT re-add quality-segment assertions here: there is no segment control to
 * drive anymore, and the server-side `quality` contract is exercised by unit
 * tests (`packages/api/src/agent-session-filters.test.ts`).
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
// Explicit `.ts` extension is REQUIRED here (and only here). Playwright resolves
// spec imports with Node's ESM resolver, which — unlike the electron-vite bundler
// and vitest that run every other `@repo/api/src/...` import — needs an explicit
// file extension. `@repo/api` ships no `exports` map, so the extensionless form
// throws `ERR_MODULE_NOT_FOUND` under the Playwright loader. The desktop tsconfig
// sets `allowImportingTsExtensions`, so typecheck accepts it. Reading the badge
// label from the canonical vocab (not a hardcoded string) is still the point:
// ISS-5770 inverted the assertion to pin the chip's ABSENCE, and naming it from
// the vocabulary is what keeps that absence about the real badge rather than
// about a string that could drift out from under it.
import {
  IdleConcept,
  idleConceptLabel,
} from "@repo/api/src/types/idle-concepts.ts";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  type SessionListSeed,
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SUBSTANTIVE_NAME = "fea-4194 substantive";
const IDLE_NAME = "fea-4194 idle";
const IDLE_SESSION_ID = "fea-4194-idle";

const SEEDED: SessionListSeed[] = [
  { sessionId: "fea-4194-substantive", name: SUBSTANTIVE_NAME },
  { sessionId: IDLE_SESSION_ID, name: IDLE_NAME, idle: true },
];

const IDLE_BADGE_LABEL = idleConceptLabel(IdleConcept.PhantomSession);

test.describe("Sessions list post-quality-revert (FEA-4194)", () => {
  test("renders the full mixed corpus with the idle badge and no quality segment", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-idle-badge-claude-")
    );
    // Isolate CODEX_HOME too: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts, inflating the
    // seeded corpus this spec pins.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-idle-badge-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-idle-badge-udd-")
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

      // One substantive + one genuinely idle (metadata NULL -> turns 0) row.
      await seedSessionsList(userDataDir, SEEDED);

      // Launch 2 — the list sends no `quality` param, so the full corpus shows.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "sessions");

        // Widen to "All time" so the corpus is in range regardless of run clock.
        // `:visible` scopes to the Sessions toolbar (keep-alive views stay
        // mounted-but-hidden and also render this control).
        await page.locator('[aria-label="All time"]:visible').click();

        // ── Full corpus: both rows visible (no quality filter) ────────────────
        // Ordered deliberately: every positive, blocking assertion runs BEFORE
        // the negative ones. A `toHaveCount(0)` passes just as happily on a page
        // that never rendered — that vacuity is how the original FEA-3343 break
        // stayed hidden. So prove the table rendered with real data first.
        await expect(
          page.getByRole("link", { name: SUBSTANTIVE_NAME })
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole("link", { name: IDLE_NAME })).toBeVisible({
          timeout: 30_000,
        });

        // ── The idle (phantom) chip is GONE, with its column ──────────────────
        // ISS-5770 removed the `Signals` (`qualifiers`) column outright, and
        // `session-row-state-chips.tsx` — the ONLY render site the FEA-3572
        // `IdleConcept.PhantomSession` chip ever had — went with it. It was not
        // re-homed: `Awaiting input` became the Status pill's `Waiting`, the
        // upload state folded into that pill, and the transcript verdict moved to
        // Session Detail, but the phantom chip has no successor anywhere.
        //
        // This assertion is REVERSED rather than deleted, so the drop is stated
        // rather than merely stopping being tested. FEA-4194's own subject —
        // "the mixed corpus renders in full, both rows, with no quality filter"
        // — is asserted above and is untouched by this; the chip was only ever a
        // supporting signal about the idle row.
        const idleRow = page
          .locator(`a[href="#/sessions/${IDLE_SESSION_ID}"]`)
          .first()
          .locator('xpath=ancestor::*[@role="row"][1]');
        // POSITIVE anchor first. Both claims below are absences, and an absence
        // scoped to a locator that resolves to nothing passes vacuously — which
        // is the exact trap the original comment here was written to close. So
        // prove the row resolved and rendered a real cell before asserting what
        // is missing from it.
        await expect(
          idleRow.locator('[data-column-id="status"]')
        ).toBeVisible();
        await expect(
          idleRow.locator('[data-column-id="qualifiers"]')
        ).toHaveCount(0);
        // Named from the canonical vocabulary, not a hardcoded string, and
        // matched EXACTLY — so re-homing the chip under a different label would
        // not quietly satisfy this, and re-homing it under the SAME label turns
        // this red on purpose, as the signal to restore the positive assertion.
        await expect(
          idleRow.getByText(IDLE_BADGE_LABEL, { exact: true })
        ).toHaveCount(0);

        // ── The removed quality segment is gone ───────────────────────────────
        // FEA-4194: no `role="group"` named "Filter sessions by quality" and no
        // `Substantive` radio anywhere in the (visible) Sessions toolbar. A
        // re-introduction of the taxonomy fails here.
        await expect(
          page.getByRole("group", { name: "Filter sessions by quality" })
        ).toHaveCount(0);
        await expect(
          page.getByRole("radio", { name: "Substantive" })
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
