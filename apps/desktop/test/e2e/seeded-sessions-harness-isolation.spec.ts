/**
 * ISS-7697 — the shared seeded-Sessions helper must keep EVERY collector home
 * out of the population, not just Claude's and Codex's.
 *
 * ## Why this spec exists in this exact shape
 *
 * `launchDesktopApp` inherits `process.env`. A launch that pins only
 * `CLAUDE_HOME`/`CODEX_HOME` leaves `CURSOR_HOME`, `COPILOT_HOME`,
 * `COPILOT_VSCODE_STORAGE_DIR` and `OPENCODE_DATA_DIR` resolving under
 * `os.homedir()`, so the boot collectors read the OPERATOR'S REAL local agent
 * history into the corpus the spec is about to assert against. On PR #5639 that
 * surfaced as a genuine local Copilot row landing in a seeded Sessions
 * population — a test run reading a developer's real sessions, and a population
 * that depends on whose machine ran the suite.
 *
 * The defect is invisible where it is introduced: on a machine with no Cursor,
 * Copilot or OpenCode history the unisolated launch passes exactly like the
 * isolated one. So asserting "the seeded specs still pass" proves nothing, and
 * neither does a lone absence assertion. Both halves below are required:
 *
 *  - the NEGATIVE half runs the real shared helper against an ambient
 *    `CURSOR_HOME` exported into this process's env and asserts the foreign
 *    session is absent, and
 *  - the POSITIVE half runs the same environment with exactly ONE key REPOINTED
 *    (`CURSOR_HOME`, named at that same store) against the SAME locator, and
 *    asserts it IS present.
 *
 * One key rather than the pre-fix `{ CLAUDE_HOME, CODEX_HOME }` literal, for a
 * reason the control case restates at the call site: re-typing that pair would
 * leave Copilot and OpenCode inherited too, and a regression test for a privacy
 * defect must not reproduce the privacy defect to prove it exists.
 *
 * ISS-7731 changed HOW the control has to be written, not what it proves. The
 * control used to OMIT `CURSOR_HOME` and let `launchDesktopApp`'s
 * `...process.env` spread supply the ambient one. That launcher now isolates
 * every collector home BY DEFAULT, above `...process.env` — so an omitted home
 * resolves to a throwaway, not to the operator's, and omission can no longer
 * express "read this store". Naming the directory in `options.env` is what
 * expresses it now, and it is the only thing that can: it is the deliberate,
 * diff-visible escape hatch `desktop-app.ts` documents at that layer. The
 * contrast the negative half rests on is unchanged and in fact tighter — the
 * two launches now differ in `CURSOR_HOME`'s VALUE and nothing else.
 *
 * The claim the old spelling carried — that a home left ambient falls back
 * under `os.homedir()`, so the resolver reads its variable at all — did not go
 * away with it. It moved to where it is still true post-ISS-7731, against the
 * launcher's captured environment rather than through it:
 * `test/desktop-e2e-harness-home-isolation.test.ts`, "the ambient control:
 * dropping ONE variable puts exactly that resolver back under the operator's
 * home".
 *
 * The "operator's real Cursor store" is simulated by a temp `CURSOR_HOME`
 * exported into this process's env before either launch. That is faithful to
 * the defect (the leak is precisely that an ambient, inherited home wins — which
 * is exactly what the negative half still puts in front of the launcher) and it
 * makes the proof machine-independent — the run never reads, and never needs,
 * the real `~/.cursor`.
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
  activeNavPanel,
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNavSettled,
  launchDesktopApp,
} from "./helpers/desktop-app";
import type { SessionListSeed } from "./helpers/seed-branches-db";
import { seedCursorTranscript } from "./helpers/seed-cursor-transcript";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  seededSessionsEnv,
  withSeededSessionsList,
} from "./helpers/seeded-sessions-list";

/**
 * The foreign session's rendered name. `parse-cursor.ts` derives a session's
 * name from its cwd BASENAME, and the desktop Sessions row falls back to the
 * session id when there is no name — this token is both, so the row carries it
 * either way. Distinctive enough that it cannot collide with a real local
 * session, which is what makes an absence assertion meaningful.
 */
const FOREIGN_SESSION_TOKEN = "iss7697-foreign-cursor-session";
const FOREIGN_SESSION_STARTED_AT = "2026-06-26T15:00:00.000Z";
/**
 * A SECOND Cursor session, planted in the ISOLATED `CURSOR_HOME` the fixed
 * helper points the launch at. It is what makes the absence assertion
 * non-vacuous — see the negative case below.
 */
const ISOLATED_SESSION_TOKEN = "iss7697-isolated-cursor-session";

/** The Claude-side corpus, seeded straight into SQLite by the shared helper. */
const SEEDED: SessionListSeed[] = [
  { sessionId: "iss7697-isolation-seeded", name: "iss7697-isolation-seeded" },
];

const SPEC_TIMEOUT_MS = 300_000;
const ROW_TIMEOUT_MS = 60_000;

test.describe("Seeded Sessions harness-home isolation (ISS-7697)", () => {
  test("a launch pointed at the operator's Cursor store lets that session into the population", async () => {
    test.setTimeout(SPEC_TIMEOUT_MS);

    const operator = makeOperatorCursorHome();
    const dirs = makeSeededSessionsDirs("iss7697-leaky");
    try {
      // The leak's shape, reproduced by REPOINTING exactly one key rather than
      // by re-typing the literal `{ CLAUDE_HOME, CODEX_HOME }` pair. Two
      // reasons, and the second one matters more:
      //
      //  1. It isolates the variable. This launch and the isolated one below
      //     differ in `CURSOR_HOME`'s value and nothing else, so a difference in
      //     the population can only be attributed to that.
      //  2. This spec must not commit the defect it polices. The literal pair
      //     leaves Copilot and OpenCode ambient too, so on a developer's own
      //     machine this control launch would read their REAL Copilot store and
      //     `opencode.db` into the profile — a regression test for a privacy
      //     defect, reproducing the privacy defect. Every other home stays
      //     pinned to a throwaway; only Cursor's points at the stand-in store.
      //
      // Named rather than omitted since ISS-7731 (see the file header): the
      // launcher now isolates every home by default, ABOVE `...process.env`, so
      // omitting a key yields a throwaway and would assert nothing. The value is
      // `operator.root` — the same temp store the negative half leaves ambient,
      // never the real `~/.cursor`.
      const { page, cleanup } = await launchDesktopApp({
        env: seededSessionsEnv(dirs, { CURSOR_HOME: operator.root }),
        keepUserDataDir: true,
        userDataDir: dirs.userDataDir,
      });
      try {
        // Keep-alive parks this real Dashboard copy when Sessions takes over.
        // Wait for it first so a page-global row query fails deterministically.
        const dashboard = await gotoNavSettled(page, "dashboard");
        // ISS-11927 (#8982): the seeded sessions predate the Dashboard's
        // default 7d range, which now says so instead of drawing their rows.
        await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);
        await expect(
          dashboard.getByText(FOREIGN_SESSION_TOKEN, { exact: true })
        ).toBeVisible({ timeout: ROW_TIMEOUT_MS });
        await showAllSessions(page);
        await expect(foreignSessionRow(page)).toBeVisible({
          timeout: ROW_TIMEOUT_MS,
        });
      } finally {
        await cleanup();
      }
    } finally {
      cleanupSeededSessionsDirs(dirs);
      operator.restore();
    }
  });

  test("the shared helper's environment keeps that same session out of the population", async () => {
    test.setTimeout(SPEC_TIMEOUT_MS);

    const operator = makeOperatorCursorHome();
    const dirs = makeSeededSessionsDirs("iss7697-isolated");
    try {
      // Materialize the isolated homes and plant a DIFFERENT Cursor session in
      // the one this launch will actually read. That row is both the settle
      // point and the non-vacuity guard: it proves the Cursor collector ran and
      // that its sessions reach this very list, so the absence below can only
      // mean the ambient home was overridden — not that the collector never got
      // its turn, or that Cursor rows never render here at all.
      // `isolatedHarnessHomes` only `mkdir -p`s, so the second call
      // `withSeededSessionsList` makes returns these same paths untouched.
      const isolatedCursorHome = seededSessionsEnv(dirs).CURSOR_HOME;
      // Named, so a helper that stops isolating Cursor fails HERE saying so,
      // rather than deeper down on an undefined path.
      expect(
        isolatedCursorHome,
        "the shared helper's launch environment does not pin CURSOR_HOME, so this spec has no isolated home to plant its non-vacuity session in"
      ).toBeTruthy();
      seedCursorTranscript(isolatedCursorHome, {
        cwd: path.join(os.tmpdir(), ISOLATED_SESSION_TOKEN),
        sessionId: ISOLATED_SESSION_TOKEN,
        startedAt: FOREIGN_SESSION_STARTED_AT,
      });

      await withSeededSessionsList(dirs, SEEDED, async (page) => {
        const sessions = await gotoNavSettled(page, "sessions");
        await expect(
          sessions.getByRole("link", {
            name: ISOLATED_SESSION_TOKEN,
            exact: true,
          })
        ).toBeVisible({ timeout: ROW_TIMEOUT_MS });
        await expect(foreignSessionRow(page)).toHaveCount(0);
      });
    } finally {
      cleanupSeededSessionsDirs(dirs);
      operator.restore();
    }
  });

  test("every collector home the isolated set covers is redirected away from the operator's", () => {
    const dirs = makeSeededSessionsDirs("iss7697-env");
    try {
      const env = seededSessionsEnv(dirs);
      // An edit-time canary, and ONLY that. The expectation is written
      // independently of `isolatedHarnessHomes` so it cannot read its answer
      // from the thing it polices, but both sides still move together when that
      // helper is edited — so this fires when someone DROPS a variable from the
      // set, and stays green when someone adds a COLLECTOR that was never in
      // it. That second direction is the one ISS-7697 is actually about, and it
      // is covered where the collectors' own resolvers can be executed:
      // `test/collector-home.test.ts`, "isolatedHarnessHomes redirects every
      // collector's REAL home resolver".
      expect(Object.keys(env).sort()).toEqual([
        // Review (#5717, tamsinb): the Claude Desktop sidecar root joined the
        // canonical set — a home distinct from `CLAUDE_HOME` that resolves
        // under `os.homedir()` on macOS when left unpinned.
        "CLAUDE_DESKTOP_SESSIONS_HOME",
        "CLAUDE_HOME",
        "CODEX_HOME",
        "COPILOT_HOME",
        "COPILOT_VSCODE_STORAGE_DIR",
        "CURSOR_HOME",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_DATA_DIR",
      ]);
      for (const [key, value] of Object.entries(env)) {
        expect(value, `${key} escaped the run's temp roots`).toContain(
          os.tmpdir()
        );
      }
      // The two the corpus lives in still point at the seeded dirs, or the
      // isolation would have thrown the fixture away with the contamination.
      expect(env.CLAUDE_HOME).toBe(dirs.claudeHome);
      expect(env.CODEX_HOME).toBe(dirs.codexHome);
    } finally {
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

/** The Sessions row for the foreign session, by its rendered name. */
function foreignSessionRow(page: Page) {
  return activeNavPanel(page, "sessions").getByRole("link", {
    name: FOREIGN_SESSION_TOKEN,
    exact: true,
  });
}

/** Navigate to Sessions and widen the window so no row is hidden by date. */
async function showAllSessions(page: Page): Promise<void> {
  await gotoNavSettled(page, "sessions");
  await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);
}

/**
 * Stand up a temp `CURSOR_HOME` holding one recognizable session and export it
 * into this process's env, standing in for the operator's real `~/.cursor`.
 *
 * `restore()` puts the variable back exactly as it was — DELETING it when it was
 * originally unset, because assigning `undefined` would leave the string
 * `"undefined"` behind and point the next spec's collector at a bogus path.
 */
function makeOperatorCursorHome(): { root: string; restore: () => void } {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss7697-operator-cursor-")
  );
  seedCursorTranscript(root, {
    sessionId: FOREIGN_SESSION_TOKEN,
    cwd: path.join(os.tmpdir(), FOREIGN_SESSION_TOKEN),
    startedAt: FOREIGN_SESSION_STARTED_AT,
  });

  const had = Object.hasOwn(process.env, "CURSOR_HOME");
  const previous = process.env.CURSOR_HOME;
  process.env.CURSOR_HOME = root;

  return {
    root,
    restore: () => {
      if (had) {
        process.env.CURSOR_HOME = previous;
      } else {
        Reflect.deleteProperty(process.env, "CURSOR_HOME");
      }
      fs.rmSync(root, { force: true, recursive: true });
    },
  };
}
