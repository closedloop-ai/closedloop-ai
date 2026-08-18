/**
 * E2E regression (ISS-5281): the first-launch import splash tells the truth
 * about a real import, proven through the LAUNCHED app.
 *
 * The renderer suites for this fix mock `useIngestProgress` at the component
 * boundary, so they inject both ends and never execute the chain the fix
 * actually changed (wongk review): `IngestProgressTracker` →
 * `CollectorManager.getIngestProgress` → the `desktop:get-runtime-status` IPC →
 * preload → `useIngestProgress` → `deriveImportSplashState` → the rendered
 * splash. This spec drives that chain with a genuine first-launch backfill.
 *
 * Two things it would have caught before the fix:
 *   1. `ingest.drained` did not exist on the runtime-status payload at all. The
 *      splash inferred "the queue is empty" from aggregate
 *      `processed >= total && !preparing`, which is true mid-pass on every
 *      cooperative yield/resume. Here the producer's own answer is read off the
 *      real payload and asserted against the pass it describes: FALSE while a
 *      first pass is in flight, TRUE only once every begun pass has ended.
 *   2. The splash counted the `processed`/`total` pair as "sessions". They are
 *      source-file units — one OpenCode source is a whole `opencode.db` holding
 *      many sessions — so the rendered count is asserted in TRANSCRIPTS against
 *      real ingest numbers, and the false-failure copy the ticket exists to kill
 *      ("Import didn't finish" over a run that finished) is asserted absent at
 *      the settled point rather than over an arbitrary sleep.
 *
 * ISS-6118 (wongk review) extends it through the end of the lifecycle: the
 * splash must also TAKE ITSELF DOWN off that real payload, inside a budget the
 * 120s no-movement backstop cannot buy. The renderer suites cover the dismissal
 * branch with `useIngestProgress` mocked — both ends injected — so the launched
 * app is the only place the settle is proven against the producer it actually
 * reads.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: pnpm -C apps/desktop test:e2e (with an isolated CODEX_HOME)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";

/**
 * Enough sources that the backfill is still mid-pass when the splash first
 * paints, so the in-flight sample below is observable rather than raced past.
 * The same count the startup-readiness spec seeds for the same reason.
 */
const SEEDED_SESSION_COUNT = 80;

/** Import-heavy launch: the settle wait alone can approach the 60s default. */
const SPEC_TIMEOUT_MS = 180_000;

/** The rendered overall count, in the population it actually measures. */
const TRANSCRIPT_COUNT_PATTERN = /[\d,]+ \/ [\d,]+ transcripts/;
/**
 * A rendered COUNT stated in sessions — precisely what the splash printed before
 * this fix (`"0 / 80 sessions"` on the rail, `"80 sessions"` in the body,
 * `"60 sessions imported"` on the collapsed row) and what ISS-5281 re-nouned to
 * transcripts everywhere the pair is shown.
 *
 * Scoped to counts deliberately. The scan-phase detail line ("Reading your Codex
 * sessions") is prose naming the work in progress, carries no measured
 * population, and is untouched by this ticket on both sides of the diff — a
 * blanket ban on the word would pin copy this fix never claimed and could only
 * be satisfied by rewriting unrelated strings.
 */
const SESSION_COUNT_PATTERN = /[\d,]+(?: \/ [\d,]+)? sessions/;
/**
 * The rendered overall count in ANY noun — the frame-selection predicate, kept
 * deliberately noun-blind so it cannot pre-decide the assertion it feeds. A
 * splash that printed the pre-fix `"0 / 80 sessions"` still satisfies this, is
 * captured, and then fails {@link TRANSCRIPT_COUNT_PATTERN} below. Selecting on
 * the transcript wording instead would turn that regression into a poll timeout.
 *
 * Requiring a rendered PAIR is also what keeps the scan phase out of the count
 * assertions. Because this spec reads the status IPC directly, it is always at
 * least as fresh as the splash, so a frame sampled purely on the producer's
 * numbers can still be painting "Scanning your local logs" — a frame that
 * renders no count at all, and would fail the count assertions for a skew
 * ISS-5281 never claimed to fix. A frame matching this pattern has by
 * construction already left the scan phase, so the hazard is excluded
 * structurally rather than by gating on any particular phase headline.
 */
const OVERALL_COUNT_PATTERN = /[\d,]+ \/ [\d,]+ [a-z]+/;
/** The self-refuting copy this ticket exists to kill. */
const FALSE_FAILURE_PATTERN = /Import didn't finish|Stopped after/;
/**
 * How long the splash may take to take ITSELF down once the producer reports the
 * import over. Bounded far below the renderer's 120s no-movement backstop
 * (`STALL_GIVE_UP_MS`) on purpose: that backstop does not hide the splash at all
 * — it resolves to the graceful partial-import state, which stays ON SCREEN
 * carrying "Import didn't finish" until the user dismisses it. So a build whose
 * settle path is broken cannot satisfy this by merely being slow; it fails here
 * and again on the failure-copy assertion.
 */
const SPLASH_HIDE_BUDGET_MS = 45_000;
type IngestSample = {
  present: boolean;
  total: number;
  processed: number;
  preparing: boolean;
  complete: boolean;
  /** `undefined` on a build that never learned the field — a real failure here. */
  drained: unknown;
  /** What the splash is rendering at the instant of this sample. */
  splashText: string;
  /**
   * The splash's own a11y state, read off the SAME element the text above comes
   * from so the closing absence assertion has a matching positive control: the
   * component drives `aria-hidden` from `visible`, and this spec asserts it
   * false while the import is in flight and true once it has ended.
   */
  hidden: boolean;
};

/**
 * One read of the REAL runtime-status IPC plus the splash it is driving.
 *
 * The two are NOT the same instant and must not be asserted as if they were.
 * `getRuntimeStatus()` here is a live round-trip to the producer, while the
 * splash renders whatever the renderer's own shared poller last received —
 * `use-ingest-progress.ts` ticks it every `INGEST_POLL_MS` (1s), so the DOM
 * trails the payload by up to a full interval by design. ISS-5346 made that gap
 * observable: the reveal now waits for the renderer's `Mounted` phase rather
 * than the pre-mount `Shell` one, so `whenInitiallyShown()` — and with it the
 * Agent Dashboard runtime that starts the ingest — now resolves AFTER the
 * banner's first poll tick instead of before it. The first payload carrying a
 * total therefore lands in the renderer's lag window, where the splash is still
 * honestly painting the scan phase it last heard about.
 *
 * So each channel is polled on its own terms below: the producer contract off
 * the payload, the rendered-copy contract off a frame the splash has actually
 * painted. Both are captured within the same in-flight run.
 */
const READ_INGEST_SAMPLE = (): Promise<IngestSample> => {
  const api = (
    globalThis as unknown as {
      desktopApi?: { getRuntimeStatus?: () => Promise<unknown> };
    }
  ).desktopApi;
  const splash = document.querySelector(
    '[data-testid="first-launch-import-banner"]'
  );
  const splashText = splash?.textContent ?? "";
  // Absent counts as hidden: a splash that never mounted is not on screen.
  const hidden = splash?.getAttribute("aria-hidden") !== "false";
  const pending = api?.getRuntimeStatus?.();
  if (!pending) {
    return Promise.resolve({
      present: false,
      total: 0,
      processed: 0,
      preparing: false,
      complete: false,
      drained: undefined,
      splashText,
      hidden,
    });
  }
  return pending.then((status) => {
    const ingest = (
      status as {
        ingest?: {
          total?: number;
          processed?: number;
          preparing?: boolean;
          complete?: boolean;
          drained?: unknown;
        } | null;
      } | null
    )?.ingest;
    return {
      present: Boolean(ingest),
      total: ingest?.total ?? 0,
      processed: ingest?.processed ?? 0,
      preparing: ingest?.preparing ?? false,
      complete: ingest?.complete ?? false,
      // Read as `unknown` on purpose: a build that never sends the field must
      // fail the type assertion below rather than coerce to a plausible false.
      drained: ingest?.drained,
      splashText,
      hidden,
    };
  });
};

test.describe("Import splash drained truth (ISS-5281)", () => {
  test.setTimeout(SPEC_TIMEOUT_MS);

  test("reports drained from the producer and counts transcripts, not sessions", async () => {
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss5281-splash-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss5281-splash-codex-")
    );

    try {
      seedClaudeTranscripts(
        claudeHome,
        Array.from({ length: SEEDED_SESSION_COUNT }, (_unused, index) => ({
          sessionId: `iss5281-splash-${index}`,
          slug: `iss5281-splash-${index}`,
          userText: `Seeded import source ${index}`,
        }))
      );

      const { page, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      });

      try {
        // --- In flight -------------------------------------------------------
        // Wait for samples the app itself proves are mid-pass, rather than for a
        // wall-clock moment. `expect.poll` re-reads until the predicate holds, so
        // nothing here depends on how fast the runner imports.
        //
        // One loop, two independent captures — the producer's first mid-pass
        // payload, and the first splash frame that actually paints an overall
        // count — because the renderer's poll makes them land on different ticks
        // (see READ_INGEST_SAMPLE). Capturing both in the same loop, rather than
        // waiting for one and then the other, keeps each observation inside the
        // same in-flight run: the count line is rendered only while the splash is
        // on Importing/Computing, so a second sequential wait could start after
        // that window had already closed.
        let inFlight: IngestSample | null = null;
        let countedText = "";
        let shownWhileImporting = false;
        await expect
          .poll(
            async () => {
              const sample = await page.evaluate(READ_INGEST_SAMPLE);
              if (
                inFlight === null &&
                sample.total > 0 &&
                sample.processed < sample.total
              ) {
                inFlight = sample;
              }
              if (
                countedText === "" &&
                OVERALL_COUNT_PATTERN.test(sample.splashText)
              ) {
                countedText = sample.splashText;
                // Positive control for the closing hide assertion, captured on
                // the frame that proves the splash was actually up.
                shownWhileImporting = !sample.hidden;
              }
              return inFlight !== null && countedText !== "";
            },
            { timeout: 90_000 }
          )
          .toBe(true);

        const midPass = inFlight as unknown as IngestSample;
        expect(midPass.present).toBe(true);
        // The field exists on the wire and is a real boolean, not an absent
        // value the renderer would have to guess at.
        expect(typeof midPass.drained).toBe("boolean");
        // A pass IS in flight, so the producer must say so — this is the sample
        // whose counters the old renderer-side inference could not read
        // correctly on a yield/resume plateau.
        expect(midPass.drained).toBe(false);
        expect(midPass.complete).toBe(false);

        // …and the splash renders that same pair in the population it measures.
        // The frame was selected noun-blind, so this is the assertion that
        // decides the noun, not the wait above.
        expect(countedText).toMatch(TRANSCRIPT_COUNT_PATTERN);
        expect(countedText).not.toMatch(SESSION_COUNT_PATTERN);
        // A running import is not a failed one, whatever the counters do.
        expect(countedText).not.toMatch(FALSE_FAILURE_PATTERN);

        // --- Settled ---------------------------------------------------------
        // Every begun pass has ended, so the producer flips `drained`. Polling
        // on the producer's own answer (not on a timer) is what makes the
        // settled assertion below deterministic.
        let settledText = "";
        await expect
          .poll(
            async () => {
              const sample = await page.evaluate(READ_INGEST_SAMPLE);
              settledText = sample.splashText;
              return sample.drained === true;
            },
            { timeout: 120_000 }
          )
          .toBe(true);

        // The bug in one line: a run that reached the end must never be
        // described as one that stopped.
        expect(settledText).not.toMatch(FALSE_FAILURE_PATTERN);
        expect(settledText).not.toContain("couldn't be read");
        // The settled frame is where the pre-fix build printed its loudest
        // session count ("N sessions imported"), so the noun is pinned at both
        // ends of the run rather than only mid-pass.
        expect(settledText).not.toMatch(SESSION_COUNT_PATTERN);

        // --- Taken down ------------------------------------------------------
        // ISS-6118 (wongk review): the renderer suites drive the dismissal
        // branch with `useIngestProgress` mocked, so nothing there proves the
        // splash ever comes DOWN off a real producer payload. It was up on the
        // frame that carried the count above — asserted, not assumed, so the
        // absence below is a state change and not a selector that stopped
        // matching — and it must now take itself down within a budget the 120s
        // no-movement backstop cannot buy (see SPLASH_HIDE_BUDGET_MS).
        expect(shownWhileImporting).toBe(true);
        let lastFrame = "";
        await expect
          .poll(
            async () => {
              const sample = await page.evaluate(READ_INGEST_SAMPLE);
              lastFrame = sample.splashText;
              return sample.hidden;
            },
            { timeout: SPLASH_HIDE_BUDGET_MS }
          )
          .toBe(true);
        // It ended by finishing, not by giving up: the partial-import state
        // keeps the splash ON SCREEN, so this pins which of the two ways out of
        // the import the app actually took.
        expect(lastFrame).not.toMatch(FALSE_FAILURE_PATTERN);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});
