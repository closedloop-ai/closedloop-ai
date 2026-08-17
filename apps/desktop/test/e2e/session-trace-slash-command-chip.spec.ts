/**
 * ISS-4924: the ISS-4767 slash-command chip (#4248) driven through the DESKTOP
 * (Electron) adapter.
 *
 * The web twin is `e2e/session-detail-slash-command.spec.ts`. It is not
 * sufficient, and not because the trace differs — the trace is the SAME shared
 * `packages/app` component on both surfaces. What differs is everything around
 * it: the local transcript read (`mapDetail`'s on-disk `transcripts` summary),
 * the renderer's own mount, and the Electron runtime itself. A desktop-only
 * rendering or transcript-plumbing fault therefore ships green on the strength
 * of the web spec alone. This drives the desktop-specific chain end to end: real
 * `.jsonl` on disk → boot importer → local detail read → folded chip in the real
 * mounted trace.
 *
 * ISS-5366 retired the `session-trace-slash-command-chip` Labs flag, so the fold
 * is unconditional and there is no gate left to seed or to prove.
 *
 * How the slash-command turn gets in (no fake seam, no test-only code path):
 * the desktop trace has no route to mock. The prompt text comes from the
 * session's own transcript, so this seeds a REAL Claude `.jsonl` into an
 * isolated `CLAUDE_HOME` whose user turn IS the verbatim `/resume` invocation
 * the harness re-injects. The boot importer ingests it, the local detail read
 * reports an on-disk transcript (`mapDetail`'s `transcripts` summary), and
 * `SessionTranscriptPanel` parses those bytes into the rendered trace. The
 * shared `findSlashCommandInvocations` recognizer then sees exactly the markup
 * ISS-4767 is about. Same seeding path as
 * `session-transcript-switcher.spec.ts`, which is why one launch suffices here:
 * the corpus is on disk BEFORE the app boots, so there is no cross-process write
 * to a running store (the two-launch sandwich other specs use is for seeding
 * SQLite, which this spec does not do).
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  breadcrumbParentLink,
  gotoHash,
  launchDesktopApp,
} from "./helpers/desktop-app";
import { seedClaudeTranscripts } from "./helpers/seed";

// Hash-safe id: also the on-disk transcript stem and the imported session id.
const SESSION_ID = "iss-4924-slash-command-chip";
const PROJECT = "e2e-slash-command-chip";

/**
 * The verbatim `/resume` prompt text captured on SES-73062 — three sibling
 * harness wrapper tags for ONE typed command, indentation included. Byte-for-byte
 * the fixture the web spec drives, so both surfaces are proven on the same input.
 */
const RESUME_INVOCATION_TEXT =
  "<command-name>/resume</command-name>\n            <command-message>resume</command-message>\n            <command-args></command-args>";
const RESUME_CHIP_TEXT = "/resume";
/** The literal run the bug report quoted; must never render. */
const STRIPPED_COMMAND_DEBRIS = "command-name/resume";

const TRACE_TEXT_SELECTOR = ".st-text";
const CHIP_SELECTOR = ".st-tag";
const CHIP_NAME_SELECTOR = ".st-tag-name";
// Boot + historical import + transcript parse all sit between launch and the
// first painted trace row, so the mount barrier gets a launch-sized budget.
const MOUNT_TIMEOUT_MS = 60_000;

test.describe("Session trace slash-command chip (ISS-4924)", () => {
  test("folds a slash-command turn into one command chip", async () => {
    test.setTimeout(180_000);

    await withSeededSlashCommandSession(async (page) => {
      const trace = await slashCommandTraceBody(page);

      // The chip names the command — the whole point of the fix.
      await expect(trace.locator(CHIP_NAME_SELECTOR).first()).toHaveText(
        RESUME_CHIP_TEXT
      );

      // Exactly one chip: the three wrapper tags collapsed into a single fact.
      await expect(trace.locator(CHIP_SELECTOR)).toHaveCount(1);

      // No tag names render, as XML or as the bracket-less run the report quoted.
      await expect(trace).not.toContainText(STRIPPED_COMMAND_DEBRIS);
      await expect(trace).not.toContainText("<command-name>");
      await expect(trace).not.toContainText("command-args");
    });
  });
});

/**
 * The single rendered trace body that carries the folded invocation.
 *
 * Resolved by structure (the one `.st-text` containing chips) rather than by
 * index: the seeded assistant reply renders its own chip-free `.st-text`, and
 * `visible=true` drops the keep-alive-hidden copies desktop views leave mounted.
 *
 * Asserting the count is ONE before anything else is what makes every negative
 * assertion below meaningful — a trace that never rendered, or a session that
 * never imported, fails here instead of letting `not.toContainText` succeed
 * against nothing.
 */
async function slashCommandTraceBody(page: Page) {
  const trace = page
    .locator(TRACE_TEXT_SELECTOR)
    .locator("visible=true")
    .filter({ has: page.locator(CHIP_SELECTOR) });
  await expect(trace).toHaveCount(1, { timeout: MOUNT_TIMEOUT_MS });
  return trace;
}

/**
 * Seed a Claude transcript whose user turn is the `/resume` invocation, boot the
 * app on that session's detail route, and hand the mounted page to `body`. The
 * launch profile is left untouched — ISS-5366 removed the Labs toggle the fold
 * used to sit behind.
 */
async function withSeededSlashCommandSession(
  body: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-slash-chip-claude-")
  );
  // Isolated CODEX_HOME: `launchDesktopApp` inherits the operator's env, and a
  // real Codex home would pull unrelated sessions into the corpus.
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-slash-chip-codex-")
  );

  try {
    seedClaudeTranscripts(
      claudeHome,
      [
        {
          sessionId: SESSION_ID,
          slug: SESSION_ID,
          userText: RESUME_INVOCATION_TEXT,
        },
      ],
      PROJECT
    );

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      userDataPrefix: "desktop-slash-chip-e2e-",
    });

    try {
      await gotoHash(page, `/sessions/${SESSION_ID}`);
      await expect(breadcrumbParentLink(page, "Sessions")).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });
      await body(page);

      await page.screenshot({
        fullPage: true,
        path: test.info().outputPath("session-trace-slash-command-chip.png"),
      });

      // No uncaught renderer errors — a blanked chunk would also fail above.
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
}
