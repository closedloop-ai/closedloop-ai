/**
 * E2E regression (ISS-6241): the import splash's Compute step names the real
 * per-session population of the data-revision rebuild, proven through the
 * LAUNCHED app against a genuine stale-revision corpus.
 *
 * WHY THIS SPEC EXISTS (wongk review). The producer, the boundary parser, the
 * splash derivation and the checklist component each have isolated tests, and
 * every one of them stays green if the PRODUCTION WIRE between them is cut —
 * `reportProgress` never handed to the rebuild, the counts never published on
 * the runtime status, the Labs flag never passed down, the count never
 * rendered. `apps/desktop/AGENTS.md` requires a mapped user-facing field to be
 * asserted through the launched app for exactly that reason, so this drives the
 * whole chain: `runDataRevisionRebuild` → the progress reporter →
 * `maintenance-progress-state` → `desktop:get-runtime-status` → preload →
 * `parseMaintenanceProgress` → `deriveImportSplashState` → the rendered step.
 *
 * HOW THE STALE POPULATION IS REAL. The rebuild is cursored on
 * `sessions.data_revision`, so launch 1 imports a batch and, with the app
 * closed, every terminal row it wrote is stamped back to an older revision —
 * the same state a user's machine is in after a DATA_REVISION bump ships. Their
 * transcripts are still on disk, so launch 2's rebuild genuinely re-parses and
 * re-derives them rather than walking a missing-source cohort. Launch 2 also
 * gets a SECOND batch of new transcripts, because the Compute stage is scoped
 * to a launch that really imported something.
 *
 * The count is Labs-gated (ISS-4779 closed-by-default), so the key is seeded
 * from the leaf `desktop-compute-progress-count-flag` module — importing
 * `src/shared/feature-flags` from a spec aborts the whole Electron run under
 * Playwright's Node loader (the same note as `collapsible-import-splash.spec.ts`
 * and `db-ahead-banner.spec.ts`).
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: `pnpm -C apps/desktop test:e2e`. This spec throws away every
 *     harness home itself (see `isolatedHarnessHomes` below), so it does not
 *     rely on the suite-wide `CODEX_HOME` note in `apps/desktop/AGENTS.md` —
 *     that note still applies to the specs that do not isolate their own.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY } from "../../src/shared/desktop-compute-progress-count-flag";
import { isolatedHarnessHomes } from "../helpers/isolated-harness-homes";
import {
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import { ageSeededTranscripts, seedClaudeTranscripts } from "./helpers/seed";
import {
  staleTerminalSessionRevisions,
  waitForTerminalSessions,
} from "./helpers/stale-revision-sessions";

const BANNER_TEST_ID = "first-launch-import-banner";

/**
 * The rendered Compute count. Deliberately noun-bearing: the rebuild's
 * population is the stale SESSION rows it re-derives, which is a different
 * population from the source files the import counts (ISS-5281), so a count
 * that drifted back to the import's noun must fail rather than pass.
 */
const COMPUTE_COUNT_PATTERN = /([\d,]+) of ([\d,]+) sessions/;

/**
 * The single mtime every seeded transcript carries, for BOTH batches.
 *
 * Comfortably past the import's 10-minute `RECENT_ACTIVITY_MS` live window, so
 * each seeded run imports as a finished session rather than a live one — and
 * fixed at module load rather than recomputed per batch, so seeding the second
 * batch cannot re-date the first batch's files out from under the catchup cache.
 */
const SEEDED_TRANSCRIPT_MTIME = new Date(Date.now() - 60 * 60 * 1000);

/**
 * Launch 1's corpus: the rows launch 2's rebuild will find stale.
 *
 * Sized so the rebuild OUTLASTS the splash's own eligibility lag, which is the
 * subtle part. Main starts post-boot maintenance the moment the import settles,
 * but the renderer will not render the Compute stage until it has held a drained
 * import for `DRAINED_SETTLE_CONFIRM_MS` (15s) — so the first ~15 seconds of the
 * rebuild are structurally invisible to this surface. At 90 sessions the whole
 * rebuild landed inside that blind spot and the step was only ever observed on
 * the NEXT phase (`artifact-links`), which owns no counts, so the assertion below
 * could never see a population no matter how long it polled.
 */
const STALE_BATCH = 800;
/** Launch 2's corpus: real import work, without which no Compute stage runs. */
const FRESH_BATCH = 20;

/**
 * Two launches, two imports and a rebuild over {@link STALE_BATCH} sessions —
 * well past the 60s suite default.
 */
const SPEC_TIMEOUT_MS = 900_000;

/**
 * How long launch 1 gets to COMMIT its imported sessions. Generous next to the
 * seconds it actually takes, because the number that matters here is the one
 * that makes a genuinely stuck import fail loudly rather than silently hand a
 * short population to launch 2.
 */
const IMPORT_COMMIT_TIMEOUT_MS = 180_000;

/** One read of the rendered splash plus the payload driving it. */
const READ_COMPUTE_SAMPLE = () => {
  const splashText =
    document.querySelector('[data-testid="first-launch-import-banner"]')
      ?.textContent ?? "";
  const api = (
    globalThis as unknown as {
      desktopApi?: { getRuntimeStatus?: () => Promise<unknown> };
    }
  ).desktopApi;
  const pending = api?.getRuntimeStatus?.();
  if (!pending) {
    return Promise.resolve({ splashText, processed: null, total: null });
  }
  return pending.then((status) => {
    const maintenance = (
      status as {
        maintenance?: { processed?: number; total?: number } | null;
      } | null
    )?.maintenance;
    return {
      splashText,
      processed: maintenance?.processed ?? null,
      total: maintenance?.total ?? null,
    };
  });
};

/** Whether the launched app reports its historical import pass as drained. */
const READ_INGEST_DRAINED = () => {
  const api = (
    globalThis as unknown as {
      desktopApi?: { getRuntimeStatus?: () => Promise<unknown> };
    }
  ).desktopApi;
  const pending = api?.getRuntimeStatus?.();
  if (!pending) {
    return Promise.resolve(false);
  }
  return pending.then(
    (status) =>
      (status as { ingest?: { drained?: boolean } } | null)?.ingest?.drained ===
      true
  );
};

function seedBatch(claudeHome: string, prefix: string, count: number): void {
  seedClaudeTranscripts(
    claudeHome,
    Array.from({ length: count }, (_unused, index) => ({
      sessionId: `${prefix}${index}`,
      slug: `${prefix}${index}`,
      userText: `Seeded compute-count source ${prefix}${index}`,
    })),
    "iss6241-compute-count"
  );
  // Load-bearing, not hygiene. The rebuild works TERMINAL stale rows only
  // (`groupTerminalStaleByHarness`), and a transcript written moments ago
  // imports as a live `active` session — so an unaged corpus gives this spec
  // nothing to stale, no population to rebuild, and a Compute step that
  // correctly renders no count at all.
  ageSeededTranscripts(claudeHome, SEEDED_TRANSCRIPT_MTIME);
}

test("ISS-6241: the Compute step names the rebuild's real session population", async () => {
  test.setTimeout(SPEC_TIMEOUT_MS);

  // ONE home for both batches: launch 2 must still see launch 1's transcripts,
  // or its stale rows would have no source to re-parse and the rebuild would
  // walk a missing-source cohort instead of doing the work being measured.
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss6241-compute-count-")
  );
  // EVERY other harness home is thrown away too, not just Codex. The population
  // this spec asserts against is the one it stales, so an unisolated harness
  // does not merely slow the launch down — the operator's real Copilot store and
  // their whole `opencode.db` (one batch source holding an unbounded number of
  // sessions) land in `sessions` as terminal rows, get staled with everything
  // else, and become part of the denominator under test. On a machine carrying
  // that history the first launch's import does not settle inside the wait
  // below at all.
  const harnessHomesRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss6241-compute-count-homes-")
  );
  const harnessEnv = {
    ...isolatedHarnessHomes(harnessHomesRoot),
    // …except Claude's, which IS the seeded corpus both launches read.
    CLAUDE_HOME: claudeHome,
  };
  // Reused across BOTH launches: the stale rows live in this profile's store.
  let userDataDir: string | undefined;
  // What launch 1 actually committed, so the staled population can be checked
  // against it rather than assumed.
  let importedSessions = 0;

  try {
    seedBatch(claudeHome, "iss6241-stale-", STALE_BATCH);

    const first = await launchDesktopApp({
      userDataPrefix: "desktop-iss6241-compute-count-e2e-",
      env: harnessEnv,
      keepUserDataDir: true,
    });
    userDataDir = first.userDataDir;
    try {
      // The splash has to actually mount, or launch 1 is not the first-launch
      // flow this spec thinks it is.
      await expect(first.page.getByTestId(BANNER_TEST_ID)).toBeVisible({
        timeout: 120_000,
      });
      // …but the handoff is keyed to the DATABASE, not to that splash going
      // away. What launch 2 needs from launch 1 is committed terminal rows to
      // stale, and they are there seconds after the import commits. The splash
      // outlives them by a long way — it is deliberately held up for the whole
      // post-boot maintenance chain and its settle/stall timers (ISS-4716,
      // FEA-2264) — so waiting for it to unmount waited on work this spec does
      // not test and did not reliably finish at all: a launch whose 90 sources
      // imported in 4s still had the banner mounted 240s later.
      importedSessions = await waitForTerminalSessions(
        userDataDir,
        STALE_BATCH,
        IMPORT_COMMIT_TIMEOUT_MS
      );
      // …and then let the historical pass actually FINISH, which is a separate
      // fact from the rows being committed and is the one launch 2 depends on:
      // completing the pass flushes the per-file catchup cache, and that cache is
      // the ONLY reason launch 2 skips these 800 unchanged transcripts instead of
      // re-importing them. A re-import rewrites each row at the CURRENT revision,
      // which silently un-stales the entire population — the rebuild then finds
      // nothing, correctly publishes no counts, and the step under test can never
      // render one.
      await expect
        .poll(() => first.page.evaluate(READ_INGEST_DRAINED), {
          timeout: IMPORT_COMMIT_TIMEOUT_MS,
          message: "launch 1's historical import never drained",
        })
        .toBe(true);
    } finally {
      await first.cleanup();
    }

    // The guard for all of the above. If the cache did not survive launch 1 the
    // spec must fail HERE, naming the reason, rather than proceeding to measure a
    // rebuild whose population something quietly erased.
    expect(countCachedIngestSources(userDataDir)).toBeGreaterThanOrEqual(
      STALE_BATCH
    );

    // App closed: no lock to fight, and no race with a rebuild that might
    // already be draining the population under test.
    const staledSessions = await staleTerminalSessionRevisions(userDataDir);
    // Not merely positive: every terminal row launch 1 committed has to be in
    // the population, or the denominator asserted below would be measuring some
    // smaller accident of timing.
    expect(staledSessions).toBeGreaterThanOrEqual(importedSessions);

    seedBatch(claudeHome, "iss6241-fresh-", FRESH_BATCH);

    const second = await launchDesktopApp({
      userDataDir,
      env: harnessEnv,
      keepUserDataDir: true,
      beforeLaunch: (dir) =>
        seedDesktopFeatureFlags(dir, {
          [DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY]: true,
        }),
    });

    try {
      let counted = "";
      let payloadTotal: number | null = null;
      let payloadProcessed: number | null = null;
      await expect
        .poll(
          async () => {
            const sample = await second.page.evaluate(READ_COMPUTE_SAMPLE);
            if (
              counted === "" &&
              COMPUTE_COUNT_PATTERN.test(sample.splashText)
            ) {
              counted = sample.splashText;
              payloadTotal = sample.total;
              payloadProcessed = sample.processed;
            }
            return counted !== "";
          },
          {
            timeout: 240_000,
            message: "the Compute step never named its population",
          }
        )
        .toBe(true);

      const match = COMPUTE_COUNT_PATTERN.exec(counted);
      expect(match).not.toBeNull();
      const renderedProcessed = Number(
        (match as RegExpExecArray)[1].replaceAll(",", "")
      );
      const renderedTotal = Number(
        (match as RegExpExecArray)[2].replaceAll(",", "")
      );

      // The denominator is the population THIS test staled — not the import's
      // source-file count, and not a number derived from anything on screen.
      expect(renderedTotal).toBe(staledSessions);
      // A numerator can never outrun its own denominator; that shape is what
      // renders as more-than-complete.
      expect(renderedProcessed).toBeLessThanOrEqual(renderedTotal);
      // …and the rendered pair is the producer's pair, not a renderer
      // invention: the DOM trails the 1s poll, so the numerator may have moved
      // on, but the population of one attempt does not change under it.
      expect(payloadTotal).toBe(renderedTotal);
      expect(payloadProcessed).not.toBeNull();
    } finally {
      await second.cleanup();
    }
  } finally {
    fs.rmSync(claudeHome, { recursive: true, force: true });
    fs.rmSync(harnessHomesRoot, { recursive: true, force: true });
    if (userDataDir !== undefined) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});

/**
 * How many source files the persisted claude ingest cache remembers.
 *
 * This is the mechanism the two-launch handoff rests on: the cache is a per-file
 * (mtime, size) record written when an import pass completes, and on the next
 * launch an unchanged file is skipped on the strength of it. Reading it back is
 * how this spec proves launch 2 will SKIP the staled corpus rather than
 * re-importing it — the one event that would erase the population under test
 * without failing anything.
 */
function countCachedIngestSources(userDataDir: string): number {
  const cachePath = path.join(
    userDataDir,
    "agent-dashboard-ingest",
    "ingest-cache-claude.json"
  );
  if (!fs.existsSync(cachePath)) {
    return 0;
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const entries = (parsed as { entries?: Record<string, unknown> } | null)
    ?.entries;
  return entries ? Object.keys(entries).length : 0;
}
