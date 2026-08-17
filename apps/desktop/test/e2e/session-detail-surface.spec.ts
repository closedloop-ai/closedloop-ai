/**
 * Session DETAIL full-surface contract on the ELECTRON adapter (ISS-5593).
 *
 * The web twin is `e2e/session-detail-surface.spec.ts`. Both exist because the
 * two adapters feed the SAME shared `AgentSessionDetailView` from completely
 * different sources — the web route from an HTTP detail read, this one from a
 * local SQLite projection over IPC (the detail read in
 * `apps/desktop/src/main/session/shared-agent-session-detail-read.ts`). A section can
 * therefore be present on one surface and silently missing on the other, which
 * is exactly what the cross-surface rule in the root `AGENTS.md` warns about,
 * and exactly what neither adapter's specs asserted before this.
 *
 * The pre-existing desktop detail specs each drill one fact — the PR pill's
 * href (ISS-4899), the duration captions (ISS-4902), the breakdown residual
 * (ISS-5128), LOC/$ (ISS-4667). None names the surface's own shape, so an
 * entire panel could stop projecting and all of them stay green.
 *
 * ## Non-vacuity
 *
 * Every locator here is a structural hook read from the component source, and
 * each is asserted POSITIVELY. The Properties row set is asserted as an exact
 * ordered list rather than a spot check, so a row that stops projecting on this
 * adapter fails rather than passing unnoticed. No assertion in this file
 * depends on an accessible name that a nested control could own — the trap that
 * made the ISS-5579 list assertions unfailable.
 *
 * ## Honest limits of this adapter, verified not assumed
 *
 * The desktop detail read forwards transcripts, timeline, activity segments,
 * trace sources, (since ISS-5567) the branch route id and (since ISS-5617) the
 * session's linked artifacts — but no per-model context/rate-limit runtime
 * fields. The seeded corpus also has no live cwd, so this session's repository
 * never resolves. Those rows are therefore absent from the expected set below BY
 * DESIGN, and the set is written so that a future change which starts projecting
 * any of them fails here and gets a deliberate update rather than sliding in
 * unobserved.
 *
 * ISS-5617 closed the linked-artifacts half of that list WITHOUT moving this
 * set, and the distinction matters: the row is absent here because this seed
 * writes no `closedloop_artifact` links, not because the read cannot project
 * them. A seed that grows one must add "Linked artifacts" below.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ACTIVITY_PHASE_LABEL } from "@repo/api/src/activity-phase-labels.ts";
import { SESSION_ACTIVITY_PHASES_FLAG_KEY } from "@repo/api/src/types/session-activity-phases-flag.ts";
import { ActivityBreakdownSlot } from "@repo/app/agents/lib/session-activity-phases.ts";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  seedSessionActivitySegments,
  waitForActivitySegmentsSchema,
} from "./helpers/seed-activity-segments";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SESSION_ID = "iss-5593-desktop-detail-surface-session";
const SESSION_NAME = "ISS-5593 desktop detail surface";

/**
 * The seeded session's window, anchored to LAUNCH TIME rather than to a
 * calendar instant (codex, #4669).
 *
 * This seed is `status='completed'` — terminal — and the second launch runs
 * `sweepExpiredSessions` at boot (`apps/desktop/src/main/database/sqlite.ts`),
 * which DELETES terminal sessions whose `last_activity_at` predates a 90-day
 * retention window. A hardcoded instant therefore makes this spec a time bomb:
 * it passes until exactly 90 days after whatever date was typed here, then the
 * boot sweep purges the row before navigation and the required `desktop-e2e`
 * job starts reporting the not-found state instead of the detail surface. The
 * original literals (2026-05-21) had ten days left when this was written.
 *
 * Deriving the window from `Date.now()` keeps it a fixed 90 days from expiry on
 * every run. The shape is unchanged and is what the assertions below need: a
 * 20-minute session that ended an hour ago, split 15/5 between the two seeded
 * phases. Nothing in this file asserts a rendered date, so no assertion depends
 * on the anchor being any particular day.
 */
const SESSION_END_MS = Date.now() - 60 * 60_000;
const SESSION_START_MS = SESSION_END_MS - 20 * 60_000;
const IMPLEMENT_END_MS = SESSION_END_MS - 5 * 60_000;
const SESSION_START = new Date(SESSION_START_MS).toISOString();
const SESSION_END = new Date(SESSION_END_MS).toISOString();
const ESTIMATED_COST = 4.82;

// The `<h1>` renders `name ?? externalSessionId`; it is the only per-session
// mount barrier on this screen, because `gotoHash` only assigns the hash and
// returns without waiting for anything.
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const PROPERTIES_SECTION_SELECTOR = "section.sd3-props";
const PROPERTIES_BUTTON_NAME = "Properties";
const PROPERTY_LABEL_SELECTOR = ".prd-props .prd-prop .prd-prop-label";
const PROPS_PREVIEW_SELECTOR = "button.sd3-props-preview";
const TIMELINE_TITLE = "Session Timeline";
const TRACE_TITLE = "Session Trace";
/**
 * What the trace header reads for this seed, pinned rather than merely
 * non-empty (wongk, #4669).
 *
 * `not.toBeEmpty()` could not fail here: `getTraceCountLabel`
 * (`agent-session-detail-view.tsx`) always returns "<n> events", so it renders
 * the string "0 events" on a session whose SQLite→UI transcript projection
 * dropped every row — the assertion stayed green through exactly the breakage
 * it looked like it was guarding.
 *
 * ONE, not two, and the difference is the point. The header counts `turnItems`,
 * and `buildToolsTurn` (`@repo/lib/sessions/agent-session-detail-projection`)
 * coalesces a run of CONSECUTIVE tool-like timeline events into a single tools
 * turn with no gap check — so the seed's two `PreToolUse` events, 20 minutes
 * apart with nothing between them, are one turn carrying two tool items. That
 * is why {@link TRACE_TURN_SUMMARY} is asserted alongside: it is where the two
 * seeded events are actually observable, and a projection that lost one would
 * leave this count at 1 while changing that summary.
 */
const TRACE_COUNT_LABEL = "1 event";
/**
 * The tools turn's own summary line (`summarizeToolRun`), asserted as a
 * containment check on the transcript region: the surrounding row also carries
 * a clock time and a duration, which are seed-relative and not what this pins.
 */
const TRACE_TURN_SUMMARY = "Ran 2 tools";
const ACTIVITY_PHASES_SECTION = 'section[aria-label="Activity phases"]';
const ACTIVITY_BREAKDOWN_SECTION = 'section[aria-label="Activity breakdown"]';
const PHASE_NAME_SELECTOR = `[data-slot="${ActivityBreakdownSlot.PhaseName}"]`;
// Built from the canonical label map, not re-typed: the breakdown renders
// exactly these words, and a rename there must fail this spec rather than
// silently leave it asserting the old vocabulary. Same construction as the web
// twin's `ACTIVITY_BREAKDOWN_PHASES`.
//
// The seed tiles `implement` then `validate` back to back across the WHOLE
// session window, leaving no untiled remainder, so these two are the complete
// row set — no `Idle` row, unlike the web twin whose fixture leaves a gap.
// Ordered, and exhaustive: asserting only that SOME phase name rendered (the
// previous `.first()` spot check) stayed green if `validate` disappeared, or if
// both seeded segments collapsed onto `Implement` (wongk, #4669). Verified
// falsifiable — the first run of this assertion, written for three rows,
// failed against the two the panel really renders.
const ACTIVITY_BREAKDOWN_PHASES = [
  ACTIVITY_PHASE_LABEL.implement,
  ACTIVITY_PHASE_LABEL.validate,
];
/**
 * The word the DETAIL status dot renders for this `status='completed'` seed.
 *
 * Pinned as a literal, and deliberately NOT read from
 * `SESSION_STATUS_LABELS[SESSION_STATUS.COMPLETED]` (#4669 review) — that key no
 * longer exists. ISS-4586/ISS-4654 RETIRED `completed` from the status
 * vocabulary, and ISS-5592 removed its inbound alias too,
 * `SESSION_STATUS_LABELS` is a `Record<SessionStatus, string>` with no such
 * member, and the expression would not compile under `typecheck:e2e`.
 *
 * Nor is the nearest live entry a substitute. A `completed` row folds to
 * `INACTIVE`, and `SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE]` is
 * "Inactive" — which is genuinely what the Sessions LIST badge renders for this
 * row. The DETAIL reads a different map: `STATUS_DISPLAY_BY_STATE` in
 * `@repo/app/agents/components/detail/session-status-display`, whose
 * `AgentSessionState.Completed` entry is an intentional "Completed" literal
 * ("the word belongs to the STATE, not to a retired status spelling"). So list
 * and detail legitimately differ here, and the earlier comment claiming this was
 * "the same word the Sessions LIST badge renders" was simply wrong.
 *
 * That canonical map cannot be imported either: `session-status-display.ts`
 * pulls in `lucide-react` icons, and importing a React module from a desktop
 * spec aborts the whole Electron suite at load (apps/desktop/test/AGENTS.md,
 * "Import hazard"). Literal + provenance is the honest form.
 */
const COMPLETED_STATUS_LABEL = "Completed";
/**
 * ISS-5820: the cache-write TTL subdivision this session reports. Byte-identical
 * to the web twin's `CACHE_WRITE_TOKEN_USAGE` buckets so the two adapters are
 * asserted against the SAME split, and small enough that `toLocaleString` adds
 * no grouping separator — the rendered string is then locale-independent, which
 * a runner grouping with dots instead of commas would otherwise break.
 */
const CACHE_WRITE_TTL_SPLIT = { ephemeral1h: 150, ephemeral5m: 250 } as const;
const CACHE_WRITE_LABEL_RE = /^Cache Write$/;
const CACHE_WRITE_VALUE = "250 (5m TTL) | 150 (1h TTL)";
// `getBucketButtonLabel` composes either "Jump to activity bucket <label>" or
// "Activity bucket <label>" depending on whether the bucket can be jumped to,
// so the shared fragment is what identifies a plotted bucket button.
const ACTIVITY_BUCKET_LABEL_RE = /activity bucket/i;
const MOUNT_TIMEOUT_MS = 30_000;

/**
 * The Properties rows this adapter projects for the seeded corpus, in render
 * order. Established empirically against a real Electron run, not copied from
 * the web set — the two adapters genuinely differ, and pretending otherwise
 * would be the drift this spec exists to catch.
 *
 * `Sync` is the concrete proof of that. `SessionSyncProperty` renders nothing
 * unless the session carries a `transcriptDisposition` or a `lastSyncedAt`; the
 * web detail fixture carries neither, so the row is absent from the web twin's
 * expected set, while the desktop local read populates it and the row IS here.
 * The first run of this spec failed on exactly that one row — which is also the
 * evidence that this assertion can fail rather than merely being long.
 *
 * `Cache Write` is the ISS-5820 row, and it is here for the same reason `Sync`
 * is. Its gate was a Labs toggle that defaulted OFF, so packaged Desktop never
 * rendered it; retiring the gate ON makes THIS adapter the surface the change
 * lands on. It is presence-gated on the FEA-3419 TTL split, so the seed below
 * reports one (`CACHE_WRITE_TTL_SPLIT`) — without that, the row is absent
 * because the session has nothing to divide, and its absence here would be
 * indistinguishable from the SQLite → IPC projection dropping the
 * `cache_write_5m_tokens` / `cache_write_1h_tokens` columns entirely.
 */
const EXPECTED_PROPERTY_LABELS = [
  "Status",
  "Sync",
  "Owner",
  "Harness",
  "Session ID",
  "Repository",
  "Duration",
  "Tokens",
  "Cache Write",
  "Autonomy",
  "Model",
  "Branch",
  "Pull requests",
  "Lines changed",
  "Cost",
  "LOC / $",
  "Work",
] as const;

test.describe("Session detail full surface, Electron adapter (ISS-5593)", () => {
  test("the local read projects every section the detail surface defines", async () => {
    test.setTimeout(240_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5593-surface-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the
    // seed.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5593-surface-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-iss5593-surface-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, then close so the seed
      // writes with the app DOWN.
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
        await waitForActivitySegmentsSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      await seedSessionsList(userDataDir, [
        {
          at: SESSION_START,
          // `activityEventAt` is the ONE lever that moves the PROJECTED
          // `lastActivityAt` — the desktop read derives it as
          // `max(started_at, max(events.created_at))`, so the `lastActivityAt`
          // column alone leaves the projection pinned to `at` (see the
          // `SessionListSeed` docstring). Seeding both keeps the session window
          // internally consistent instead of leaning on an `endedAt` fallback
          // to mask the gap, which would let the timeline assertions below pass
          // for the wrong reason. Mirrors `session-detail-duration-captions`.
          activityEventAt: SESSION_END,
          // ISS-5820: a session that DID report the cache-write TTL split, so
          // the now-ungated Cache Write row has a subdivision to render.
          cacheWriteTtlSplit: CACHE_WRITE_TTL_SPLIT,
          endedAt: SESSION_END,
          estimatedCost: ESTIMATED_COST,
          lastActivityAt: SESSION_END,
          name: SESSION_NAME,
          sessionId: SESSION_ID,
        },
      ]);
      // Two attributed phases plus an idle tail: enough for both the raw phase
      // strip and the derived breakdown to render real rows rather than their
      // "nothing attributed" fallbacks, and NOT idle-dominant, which would fold
      // the phase strip closed by default (FEA-4238).
      await seedSessionActivitySegments(userDataDir, SESSION_ID, [
        {
          confidence: 0.82,
          endMs: IMPLEMENT_END_MS,
          phase: "implement",
          startMs: SESSION_START_MS,
        },
        {
          confidence: 0.61,
          endMs: SESSION_END_MS,
          phase: "validate",
          startMs: IMPLEMENT_END_MS,
        },
      ]);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        // ISS-5841: activity phases are a Labs toggle, default OFF. This spec
        // asserts the detail surface projects EVERY section it defines, phases
        // among them, so it opts the gate ON rather than dropping the section
        // from its inventory — the gate's own default is covered by
        // `test/feature-flags.test.ts`, not here.
        beforeLaunch: (dir) => {
          seedDesktopFeatureFlags(dir, {
            [SESSION_ACTIVITY_PHASES_FLAG_KEY]: true,
          });
        },
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoHash(page, `/sessions/${SESSION_ID}`);
        await expect(visible(page, SESSION_TITLE_SELECTOR)).toHaveText(
          SESSION_NAME,
          { timeout: MOUNT_TIMEOUT_MS }
        );

        /*
         * The Properties pane, in its default collapsed shape.
         *
         * ISS-5999: no status assertion here. ISS-5818 took status off this
         * strip — the title one line up carries a chip from the SESSION_STATUS
         * lifecycle axis, and restating `AgentSessionState` below it could put
         * two legitimately-different words in one viewport — and ISS-5999
         * retired the gate that made the removal conditional. The state's word
         * is asserted on the EXPANDED row below, which is where it now lives.
         */
        await expect(visible(page, PROPS_PREVIEW_SELECTOR)).toBeVisible();
        await expect(
          visible(page, PROPERTIES_SECTION_SELECTOR)
        ).toHaveAttribute("data-open", "false");

        /*
         * ISS-5613's rendered-radius probe (#4943) stood here. It read
         * `.sd3-props-preview .sd3-status-dot` to prove the renderer had loaded
         * the design-system globals that declare `--radius-full`, since the
         * shared stylesheet alone cannot prove it.
         *
         * ISS-5999 removes that probe's SUBJECT from this surface: ISS-5818 took
         * status off the Properties preview (the title chip is the one remaining
         * statement), so the session detail page renders no `.sd3-status-dot` at
         * all — `session-detail-prototype-parity.test.tsx` asserts exactly that.
         * The assertion is therefore not "dropped", it is obsolete HERE; keeping
         * it would pin an element the page no longer has.
         *
         * The token concern is still live and still only provable in a real
         * engine. Branch detail still renders `.sd3-props-preview`
         * > `.sd3-status-dot` (`branch-properties-panel.tsx`), so that surface is
         * where this probe belongs — tracked back to ISS-5613, not to ISS-5999.
         */

        // Session Timeline, with real plotted buckets rather than the
        // "nothing to plot" branch.
        await expect(
          page
            .getByText(TIMELINE_TITLE, { exact: true })
            .locator("visible=true")
        ).toBeVisible();
        const bars = visible(page, "button.sd3-bar2");
        await expect(bars.first()).toBeVisible();
        await expect(bars.first()).toHaveAttribute(
          "aria-label",
          ACTIVITY_BUCKET_LABEL_RE
        );

        // The raw phase tiling and the derived per-phase breakdown are two
        // different panels answering two different questions; the local read
        // must project both.
        await expect(visible(page, ACTIVITY_PHASES_SECTION)).toBeVisible();
        const breakdown = visible(page, ACTIVITY_BREAKDOWN_SECTION);
        await expect(breakdown).toBeVisible();
        await expect(breakdown.locator(PHASE_NAME_SELECTOR)).toHaveText([
          ...ACTIVITY_BREAKDOWN_PHASES,
        ]);

        // The trace header names the section and counts what it is showing.
        await expect(visible(page, ".sd3-tracehead .sd3-th-title")).toHaveText(
          TRACE_TITLE
        );
        await expect(visible(page, ".sd3-tracehead .sd3-th-count")).toHaveText(
          TRACE_COUNT_LABEL
        );
        // …and the panel under that header rendered the turn the count is
        // counting. Both assertions are needed and neither subsumes the other:
        // the header alone can read a number while the transcript region is
        // empty, and the region alone says nothing about the header agreeing
        // with it (wongk, #4669).
        await expect(visible(page, ".sd3-trace")).toContainText(
          TRACE_TURN_SUMMARY
        );

        // The expanded row-set contract — the failure mode none of the existing
        // desktop detail specs could catch.
        await page
          .getByRole("button", { name: PROPERTIES_BUTTON_NAME, exact: true })
          .locator("visible=true")
          .click();
        await expect(
          visible(page, PROPERTIES_SECTION_SELECTOR)
        ).toHaveAttribute("data-open", "true");
        await expect(visible(page, PROPERTY_LABEL_SELECTOR)).toHaveText([
          ...EXPECTED_PROPERTY_LABELS,
        ]);
        // ISS-5999: the state's own word, on the row that carries it now that
        // the collapsed strip does not. The `.prd-prop` that owns the `Status`
        // label, so a match cannot be answered by another row's text.
        await expect(
          visible(page, PROPERTY_LABEL_SELECTOR)
            .filter({ hasText: "Status" })
            .locator("xpath=..")
        ).toContainText(COMPLETED_STATUS_LABEL);

        /*
         * ISS-5820: the Cache Write row's VALUE, on packaged Desktop, with no
         * Labs toggle seeded for it — the launch above opts in only the
         * ISS-5841 activity-phases gate.
         *
         * The label's presence in the row-set above is not enough on its own:
         * this is the surface whose behaviour the retirement actually changes,
         * so the numbers have to arrive too. The split lives in two nullable
         * `token_usage` columns that the SQLite → IPC projection
         * (`session-detail-mappers.ts`) has to carry all the way to
         * `deriveCacheWriteTtlBreakdown`; drop either column there and the
         * breakdown is null, the row self-suppresses, and BOTH this assertion
         * and the row-set above go red.
         */
        await expect(
          visible(page, PROPERTY_LABEL_SELECTOR)
            .filter({ hasText: CACHE_WRITE_LABEL_RE })
            .locator("xpath=..")
        ).toContainText(CACHE_WRITE_VALUE);

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});

/**
 * Scopes a selector to the on-screen instance. The renderer keeps prior views
 * mounted-but-hidden for instant back-navigation, so an unscoped locator can
 * resolve a stale copy of the same class from a screen the user left.
 */
function visible(page: Page, selector: string) {
  return page.locator(selector).locator("visible=true");
}
