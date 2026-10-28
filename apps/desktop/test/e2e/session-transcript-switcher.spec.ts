/** Local transcript discovery enumerates the main file and four sidechains, then exposes Desktop deep links to those files. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  breadcrumbParentLink,
  gotoHash,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  seedClaudeSubagentTranscripts,
  seedClaudeTranscripts,
} from "./helpers/seed";

// Hash-safe id: also the on-disk transcript stem and the local DB row id.
const SESSION_ID = "transcript-switcher-e2e";
const PROJECT = "e2e-transcript-switcher";
const SUBAGENT_IDS = [
  "agent-alpha",
  "agent-bravo",
  "agent-charlie",
  "agent-delta",
] as const;
const DISCLOSURE_NAME = /subagent transcripts/i;
const ANY_SUBAGENT_LINK = /^Subagent /;
const HEADER_COUNT_FOUR = /Subagent transcripts \(4\)/;
const FIRST_SIDECHAIN_DEEP_LINK = new RegExp(
  `file=subagent%3A${SUBAGENT_IDS[0]}$`
);
const LAUNCH_TIMEOUT_MS = 60_000;

test.describe("Session detail subagent transcript disclosure", () => {
  test("folds the sidechain chips behind a collapsed disclosure and opens them", async () => {
    test.setTimeout(180_000);

    await withSeededTranscriptSession(async (page) => {
      // Main is inline; the four sidechains are folded away.
      await expect(page.getByRole("link", { name: "Main" })).toBeVisible({
        timeout: LAUNCH_TIMEOUT_MS,
      });
      await expect(
        page.getByRole("link", { name: ANY_SUBAGENT_LINK })
      ).toHaveCount(0);

      const trigger = page.getByRole("button", { name: DISCLOSURE_NAME });
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toHaveAccessibleName(HEADER_COUNT_FOUR);

      await trigger.click();

      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.getByRole("link", { name: ANY_SUBAGENT_LINK })
      ).toHaveCount(SUBAGENT_IDS.length);
      await expect(
        page.getByRole("link", { name: `Subagent ${SUBAGENT_IDS[0]}` })
      ).toHaveAttribute("href", FIRST_SIDECHAIN_DEEP_LINK);
    });
  });
});

/**
 * Seed the main conversation plus four sidechains on disk BEFORE boot — so the
 * historical importer ingests the session and the local detail read enumerates
 * every file — launch the app on the session-detail route, and hand the mounted
 * page to `body`. The launch profile is left untouched: ISS-5366 removed the
 * Labs toggle the disclosure used to sit behind.
 */
async function withSeededTranscriptSession(
  body: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-tswitch-claude-")
  );
  // Isolated CODEX_HOME: `launchDesktopApp` inherits the operator's env, and a
  // real Codex home would pull unrelated sessions into the corpus.
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-tswitch-codex-")
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

    const { page, cleanup } = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      userDataPrefix: "desktop-tswitch-e2e-",
    });

    try {
      await gotoHash(page, `/sessions/${SESSION_ID}`);
      await expect(breadcrumbParentLink(page, "Sessions")).toBeVisible({
        timeout: LAUNCH_TIMEOUT_MS,
      });
      await body(page);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
}
