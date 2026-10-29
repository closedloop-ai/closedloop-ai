/**
 * ISS-5964: the subagent-transcript caption, through the DESKTOP (Electron)
 * adapter — the twin of the web case `reconciles the transcript file count
 * against the Subagents metric` in `e2e/session-transcript-switcher.spec.ts`.
 *
 * ISS-5762 reworded this caption so it stops reading as a truncation notice. A
 * codex P1 on PR #4801 asked for the desktop half and it was deferred, because
 * that lane could not run the Electron harness. This spec is that half.
 *
 * WHY BOTH SURFACES, when the string is shared. The caption is a pure function
 * of `(reportedSubagentCount, readableCount)` in
 * `packages/app/agents/lib/subagent-transcripts.ts`, so no adapter can change
 * the wording — but each adapter feeds it a DIFFERENT producer, and that is what
 * this pins. On desktop `reportedSubagentCount` derives from
 * `resolveSubagentCount(session)` over an `agentCount` the local SQLite read
 * computes as `COUNT(*)` of the session's `agents` rows
 * (`sessionDetailsCtes` in `main/database/session-detail-mappers.ts`), while
 * `readableCount` counts transcript FILES the local detail gate enumerated off
 * disk. Those two populations are collected independently, so they can disagree
 * on desktop for reasons the cloud projection cannot reproduce.
 *
 * HOW THE MISMATCH IS FORCED, and why it is a real shape. The fixture seeds four
 * sidechain transcript FILES and lets the real importer ingest them, then adds
 * three further `agents` rows with no transcript of their own. That is a
 * genuinely reachable state — a subagent whose row was collected while its
 * sidechain file was never written — and it is seeded through the same raw
 * columns the desktop sync source selects, so the detail read cannot tell a
 * seeded row from a collected one.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { isolatedHarnessHomes } from "../helpers/isolated-harness-homes";
import {
  breadcrumbParentLink,
  gotoHash,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  seedClaudeSubagentTranscripts,
  seedClaudeTranscripts,
} from "./helpers/seed";
import { seedSessionSubagents } from "./helpers/seed-session-subagents";

const SESSION_ID = "transcript-caption-e2e";
const PROJECT = "e2e-transcript-caption";
/**
 * The `agent-` prefix is load-bearing, not decoration: Claude sidechain
 * discovery globs `<projectDir>/<sessionId>/subagents/agent-*.jsonl`
 * (`listClaudeSubagentTranscriptFiles` in `collectors/claude/claude-home.ts`,
 * and the parser's own walk), so a differently-named file is silently ingested
 * as nothing and the switcher never mounts.
 */
const SUBAGENT_IDS = [
  "agent-caption-alpha",
  "agent-caption-bravo",
  "agent-caption-charlie",
  "agent-caption-delta",
] as const;

/**
 * Rows added on top of the four the importer collects, each WITHOUT a sidechain
 * file. `agentCount` becomes 4 collected + 3 seeded + the session's own main row
 * = 8, so `resolveSubagentCount` reports 7 against 4 readable transcripts.
 */
const UNTRANSCRIBED_SUBAGENTS = [
  { name: "Untranscribed one", startedAt: "2026-06-26T16:01:00.000Z" },
  { name: "Untranscribed two", startedAt: "2026-06-26T16:02:00.000Z" },
  { name: "Untranscribed three", startedAt: "2026-06-26T16:03:00.000Z" },
] as const;

const DISCLOSURE_NAME = /subagent transcripts/i;
/** The reconciled state: the header prints its own parenthetical. */
const RECONCILED_NAME = /Subagent transcripts \(4\)/;
/** The mismatch state: the exact clause ISS-5762 settled on. */
const MISMATCH_CLAUSE = /7 subagents, 4 transcripts available/;
/** Any parenthetical at all — suppressed while the caption carries the count. */
const ANY_PARENTHETICAL = /Subagent transcripts \(\d+\)/;
/** The count clause, in either direction. */
const ANY_COUNT_CLAUSE = /transcripts? available/;
/**
 * The transport words the caption must never use. A desktop-local sidechain is
 * readable off disk with no archive identity, so "archived"/"synced"/"uploaded"
 * would each assert bytes reached a remote the session never had. Secondary to
 * the positive clause assertions above — on its own it passes vacuously.
 */
const TRANSPORT_WORDING = /archived|synced|uploaded/i;
const LAUNCH_TIMEOUT_MS = 60_000;
/** The cold-store import launch, which waits on the real historical importer. */
const IMPORT_TIMEOUT_MS = 120_000;

test.describe("Session detail subagent transcript caption", () => {
  test("prints its own count and no reconciliation clause when the numbers agree", async () => {
    test.setTimeout(180_000);

    await withCaptionSession({ untranscribed: [] }, async (page) => {
      const trigger = page.getByRole("button", { name: DISCLOSURE_NAME });
      await expect(trigger).toBeVisible({ timeout: LAUNCH_TIMEOUT_MS });

      // Four collected sidechains and four readable files agree, so the header
      // carries the count itself...
      await expect(trigger).toHaveAccessibleName(RECONCILED_NAME);
      // ...and the reconciliation clause stays off screen entirely. Non-vacuous
      // because the assertion above proves this same trigger renders a name.
      await expect(trigger).not.toHaveAccessibleName(ANY_COUNT_CLAUSE);
      await expect(trigger).not.toHaveAccessibleName(TRANSPORT_WORDING);
    });
  });

  test("reconciles the reported subagent count against the readable transcripts", async () => {
    test.setTimeout(180_000);

    await withCaptionSession(
      { untranscribed: UNTRANSCRIBED_SUBAGENTS },
      async (page) => {
        const trigger = page.getByRole("button", { name: DISCLOSURE_NAME });
        await expect(trigger).toBeVisible({ timeout: LAUNCH_TIMEOUT_MS });

        // The positive assertion first: the caption states BOTH populations, so
        // a panel that never rendered fails here rather than satisfying the
        // negative checks below by matching nothing.
        await expect(trigger).toHaveAccessibleName(MISMATCH_CLAUSE);
        // The caption now carries the count, so the parenthetical is dropped —
        // the same number is never printed twice.
        await expect(trigger).not.toHaveAccessibleName(ANY_PARENTHETICAL);
        await expect(trigger).not.toHaveAccessibleName(TRANSPORT_WORDING);
      }
    );
  });
});

/**
 * Wait for the session detail AND its transcript switcher to mount. The switcher
 * renders only once the local detail read has enumerated more than one file, so
 * the `Main` link is the signal that the sidechains crossed the utility-process
 * boundary — a bare breadcrumb is not.
 */
async function expectSwitcherMounted(
  page: Page,
  timeout: number
): Promise<void> {
  await expect(breadcrumbParentLink(page, "Sessions")).toBeVisible({ timeout });
  await expect(page.getByRole("link", { name: "Main" })).toBeVisible({
    timeout,
  });
}

/**
 * Seed the main conversation plus four sidechains on disk, let the real importer
 * ingest them, add any untranscribed `agents` rows while the app is DOWN, then
 * launch on the session-detail route and hand the mounted page to `body`.
 */
async function withCaptionSession(
  options: {
    untranscribed: readonly { name: string; startedAt: string }[];
  },
  body: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-tcaption-claude-")
  );
  // `launchDesktopApp` inherits the operator's env, so EVERY harness home is
  // thrown away, not just Codex: a real Copilot store or `opencode.db` (a batch
  // source holding an unbounded number of sessions) would be imported into the
  // very profile these launches wait on, and the `expectSwitcherMounted` waits
  // below are bounded.
  const harnessHomesRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-tcaption-homes-")
  );
  const harnessEnv = {
    ...isolatedHarnessHomes(harnessHomesRoot),
    // …except Claude's, which IS the seeded corpus both launches read.
    CLAUDE_HOME: claudeHome,
  };
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-tcaption-udd-")
  );

  try {
    seedClaudeTranscripts(
      claudeHome,
      [{ sessionId: SESSION_ID, slug: SESSION_ID }],
      PROJECT
    );
    seedClaudeSubagentTranscripts(
      claudeHome,
      SESSION_ID,
      SUBAGENT_IDS,
      PROJECT
    );

    // The untranscribed rows can only be added once the importer has created the
    // session, and only while the app's own connection is released — so that
    // case takes a throwaway import launch first. The reconciled case needs no
    // seeding, so it runs as a single launch.
    if (options.untranscribed.length > 0) {
      const importLaunch = await launchDesktopApp({
        env: harnessEnv,
        // The profile has to survive this launch's teardown — the seeding step
        // and the asserting launch below both read the store it built.
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await gotoHash(importLaunch.page, `/sessions/${SESSION_ID}`);
        await expectSwitcherMounted(importLaunch.page, IMPORT_TIMEOUT_MS);
        // This launch mounts the same lazy session-detail route the asserting
        // launch does, so without this its renderer throws would be discarded
        // by its own teardown and never reach any assertion.
        expect(importLaunch.pageErrors).toEqual([]);
      } finally {
        await importLaunch.cleanup();
      }

      await seedSessionSubagents(
        userDataDir,
        SESSION_ID,
        options.untranscribed.map((subagent) => ({
          name: subagent.name,
          startedAt: subagent.startedAt,
          subagentType: "general-purpose",
        }))
      );
    }

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      env: harnessEnv,
      // Removed by this function's own `finally`, alongside the two homes.
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await gotoHash(page, `/sessions/${SESSION_ID}`);
      await expectSwitcherMounted(page, IMPORT_TIMEOUT_MS);
      await body(page);
      // After `body`, not before: the caption assertions can all pass while a
      // lazy chunk or route module is still throwing, and a throw raised while
      // the disclosure renders only lands in `pageErrors` once `body` has run.
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(harnessHomesRoot, { force: true, recursive: true });
    fs.rmSync(userDataDir, { force: true, recursive: true });
  }
}
