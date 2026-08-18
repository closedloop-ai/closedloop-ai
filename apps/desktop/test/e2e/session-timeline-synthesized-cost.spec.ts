/**
 * ISS-5566 (Electron twin): the Session Timeline must not present SYNTHESIZED
 * per-bucket cost as measured money — asserted through the LAUNCHED desktop
 * renderer reading a real seeded SQLite corpus.
 *
 * The web twin is `e2e/session-timeline-synthesized-cost.spec.ts`. Both drive
 * the same shared `AgentSessionDetailView` out of `@repo/app`, but per
 * `packages/app/AGENTS.md` a shared-view BUG FIX needs a real regression on EACH
 * adapter, and here the two adapters differ in both halves of the fix:
 *
 *   - the PRODUCER. On web the strip's provenance arrives over HTTP from the
 *     cloud detail projection. Here it is decided locally:
 *     `buildTraceActivityFields` (apps/desktop/src/main/database/session-trace.ts)
 *     omits `activityBuckets` entirely when the resolved window is unusable, and
 *     `buildLocalSessionTraceFields`
 *     (apps/desktop/src/main/session/shared-agent-sessions-api.ts) turns that
 *     omission into `[]`. There is no `activity_buckets` column — the buckets
 *     exist only if that read produces them.
 *   - the GATE. Web resolves the flag through PostHog; the packaged renderer has
 *     no PostHog wiring and resolves the byte-for-byte-equal key from the desktop
 *     Labs registry instead. A disclosure that worked on web could be silently
 *     unreachable here.
 *
 * HOW THE SEEDED SESSION REACHES THE SYNTHESIZED BRANCH: `ended_at` is stamped
 * BEFORE `started_at`. `resolveTraceEndMs` takes a parseable `ended_at`
 * unconditionally, so `endMs < startMs` and `buildTraceActivityFields` returns
 * `{}` before it builds a single bucket. `turnItems` are built from an entirely
 * independent input (the `events` rows, via `projectAgentSessionTurnItems`) and
 * never read either lifecycle stamp, so the transcript survives — which is
 * exactly the "buckets absent, transcript present" shape `buildActivityBuckets`
 * synthesizes from. That inversion is not a contrived state: it is the residue
 * of the negative-duration bug documented at
 * apps/desktop/src/main/database/session-maintenance.ts (the ISS-5182 floors
 * stopped CREATING it; nothing backfills rows that already have it), and the
 * seeded session is terminal so no sweeper heals it mid-run.
 *
 * The bug was visual, so this asserts the corrected RENDERED state, and asserts
 * it against the SAME corpus with the gate off — otherwise "no dollar labels"
 * would be satisfied by a strip that never drew any.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

/**
 * The desktop Labs key gating the disclosure. Spelled as a LITERAL rather than
 * imported from `../../src/shared/feature-flags`: that module's extension-less
 * `@repo/api/src/types/...` specifiers do not resolve under Playwright's ESM
 * loader, and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load time (same note in `agent-detail-definition-absence.spec.ts`). The copy
 * is pinned by the ISS-5566 case in
 * `apps/desktop/test/feature-flags-cross-surface.test.ts`, which asserts this
 * exact string against `DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY`,
 * so a rename fails there rather than silently leaving this spec seeding a key
 * nothing reads.
 */
const SYNTHESIZED_COST_FLAG_KEY = "session-timeline-synthesized-cost";

/**
 * The caption beneath the strip. A literal for the same reason as the flag key —
 * its module is `@repo/app` UI code this spec cannot import. Pinned against the
 * exported `TIMELINE_SYNTHESIZED_COST_LEGEND` by the copy-parity case in
 * `packages/app/agents/components/detail/__tests__/session-timeline-synthesized-cost.test.tsx`,
 * so a copy edit fails THERE with a message naming this spec rather than here
 * with an unexplained "element not found".
 */
const SYNTHESIZED_COST_LEGEND =
  "Cost over time wasn't recorded for this session; taller bars saw more activity.";

const SESSION_ID = "iss-5566-synthesized-cost-session";
const SESSION_NAME = "iss-5566 synthesized cost session";

const HOUR_MS = 3_600_000;
/** Truncated to the second: the seeder writes canonical ISO strings. */
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const STARTED_AT_MS = NOW_MS - 2 * HOUR_MS;
/**
 * BEFORE `started_at` — the whole trick. See the header: this is what makes
 * `buildTraceActivityFields` omit `activityBuckets` while the transcript, built
 * from the `events` rows, stays intact.
 */
const ENDED_AT_MS = STARTED_AT_MS - HOUR_MS;
/** A second seeded tool event, so the plotted window has a real span. */
const ACTIVITY_EVENT_AT_MS = STARTED_AT_MS + 20 * 60_000;

/** The cost strip's own bars, so a dollar elsewhere on screen cannot answer for it. */
const BAR_SELECTOR = ".sd3-bars2 .sd3-bar2";
/** The `$0.0025`-class label that sat above each weighted bar before the fix. */
/*
 * The cost rail, NOT a descendant of `.sd3-bars2` — see the web twin. ISS-5563
 * moved every printed figure into a sibling rail (`.sd3-bars2-lbls >
 * .sd3-bar2-lbl`) because an in-bar span is clipped by the bar button's
 * `overflow: hidden`. The old descendant selector matched nothing after that
 * move, which made the flag-ON count assertion below pass vacuously.
 */
const BAR_LABEL_SELECTOR = ".sd3-bars2-lbls .sd3-bar2-lbl";
/*
 * One segment of a bar's cost stack — the strip's claim about WHERE money went.
 *
 * ISS-5999: the ELEMENT, not `.cb-cache`. ISS-5819's clock window is
 * unconditional now, so the stack is painted from the "Group by" segments (whose
 * colour rides on an inline style, because model names and phase keys are open
 * sets and cannot each have a stylesheet rule) rather than from the three
 * hardcoded `.cb-cache`/`.cb-out`/`.cb-in` elements, which now render only when
 * no source window resolves at all. The contract this selector carries is
 * unchanged — a bar either paints a priced stack or it does not — and the web
 * twin's jsdom regression made exactly this move (`firstStackedBar`).
 */
const BAR_STACK_SELECTOR = ".sd3-bars2 .sd3-bar2 i";
/** The hatch that replaces that stack on a synthesized strip. */
const SYNTHESIZED_BAR_SELECTOR = ".sd3-bars2 .sd3-bar2.synthesized";
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
const MOUNT_TIMEOUT_MS = 30_000;

test.describe("Session Timeline synthesized cost (ISS-5566 desktop adapter)", () => {
  test("withdraws the dollars it never measured, and captions why", async () => {
    test.setTimeout(240_000);

    await withSeededSession(
      { flagOn: true, prefix: "desktop-synth-cost-on" },
      async (page) => {
        // The strip is on screen at all — otherwise the two zero-count
        // assertions below would be satisfied by an empty panel.
        await expect(page.locator(BAR_SELECTOR).first()).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await expect(
          page.locator(SYNTHESIZED_BAR_SELECTOR).first()
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The rail always renders one cell per bucket (labels are
        // `(string | null)[]`), so absence is "no cell carries a figure".
        await expect(
          page.locator(BAR_LABEL_SELECTOR).filter({ hasText: "$" })
        ).toHaveCount(0);
        await expect(page.locator(BAR_STACK_SELECTOR)).toHaveCount(0);

        // `exact: true` deliberately: `getByText` matches by SUBSTRING by
        // default, which a truncated or differently-qualified caption would
        // also satisfy.
        await expect(
          page.getByText(SYNTHESIZED_COST_LEGEND, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      }
    );
  });

  test("still prints those dollars on the same corpus with the gate off", async () => {
    test.setTimeout(240_000);

    await withSeededSession(
      { flagOn: false, prefix: "desktop-synth-cost-off" },
      async (page) => {
        // The pre-fix render, on the SAME seeded session. Without this arm the
        // assertions above could be satisfied by a strip that never had a label
        // or a stack to withdraw, and the ISS-4779 closed default would ship
        // unexercised on this adapter either way.
        await expect(
          page.locator(BAR_LABEL_SELECTOR).filter({ hasText: "$" }).first()
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(page.locator(BAR_STACK_SELECTOR).first()).toBeVisible();
        await expect(page.locator(SYNTHESIZED_BAR_SELECTOR)).toHaveCount(0);
        await expect(
          page.getByText(SYNTHESIZED_COST_LEGEND, { exact: true })
        ).toHaveCount(0);
      }
    );
  });
});

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real local session-detail
 * read projects the seeded corpus at boot. The Labs flag is seeded on BOTH
 * launches because `seedE2eDesktopSettings` rewrites the settings file each
 * time.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only session is the seeded one.
 */
async function withSeededSession(
  { flagOn, prefix }: { flagOn: boolean; prefix: string },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const seedGate = (dir: string) => {
    if (flagOn) {
      seedDesktopFeatureFlags(dir, { [SYNTHESIZED_COST_FLAG_KEY]: true });
    }
  };
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

  try {
    const first = await launchDesktopApp({
      beforeLaunch: seedGate,
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedSessionsList(userDataDir, [
      {
        activityEventAt: new Date(ACTIVITY_EVENT_AT_MS).toISOString(),
        at: new Date(STARTED_AT_MS).toISOString(),
        endedAt: new Date(ENDED_AT_MS).toISOString(),
        estimatedCost: 4.82,
        lastActivityAt: new Date(NOW_MS).toISOString(),
        name: SESSION_NAME,
        sessionId: SESSION_ID,
      },
    ]);

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      beforeLaunch: seedGate,
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoHash(page, `/sessions/${SESSION_ID}`);
      // The session TITLE is the per-session barrier; the strip renders on every
      // session, so waiting on it alone could be satisfied by a previous screen.
      await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(
        SESSION_NAME,
        { timeout: MOUNT_TIMEOUT_MS }
      );
      await run(page);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}
