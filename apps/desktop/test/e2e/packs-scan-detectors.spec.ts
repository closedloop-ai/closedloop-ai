/**
 * ISS-11597: the boot pack scan's CLI, npm-global and git detections reach the
 * Packs screen.
 *
 * Every other spec that renders Packs launches with `SKIP_CATALOG_DETECTORS=1`
 * and seeds the catalog directly, and the detector unit suite mocks both
 * `execFileNonBlocking` and the login-shell lookup. So nothing committed runs
 * the real child processes `pack-scanner.ts` starts during the boot scan, and a
 * regression in detection alone stayed green. This spec leaves the detectors on
 * and gives them something real to find:
 *
 *  - a fake `rtk` in a directory only the login shell's profile exports, so it
 *    is found through the login-shell PATH or not at all (`detectBinaryTool`),
 *    then asked for `--version`;
 *  - a fake `npm` that answers exactly the `npm ls -g` probe
 *    (`detectClaudeCodeRouter`);
 *  - `<CLAUDE_HOME>/skills/gstack` as a git repository with an `origin`, which
 *    `deriveGitRemoteUrl` reads with `git remote get-url origin`.
 *
 * The Packs screen renders the CATALOG `github_url`, never the scanned
 * `source_url`, so the git origin, the rtk version and the install paths are
 * asserted through the renderer's own `getPackDetail` read. What the screen does
 * render from the scan, the per-harness install state, is asserted in the DOM.
 *
 * Expected values come from the fixture this file writes, not from production
 * constants, except the catalog pack ids and the scanner's npm-global install
 * path label.
 *
 * Prerequisites: the app must be built first (`pnpm -C apps/desktop build`).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { HarnessName } from "@repo/api/src/types/harness-name.ts";
import type {
  InstalledPack,
  InstalledPackDetail,
} from "../../src/shared/agent-db-contract";
import {
  gotoNav,
  type LaunchedApp,
  launchDesktopApp,
} from "./helpers/desktop-app";
import {
  makeHarnessHomes,
  removeHarnessHomes,
  waitForCatalogEntryServing,
} from "./helpers/pack-install-fixture";

/** One launch, a deferred boot scan, and three detail views. */
const SPEC_TIMEOUT_MS = 300_000;
/** Ceiling for the runtime to serve, and again for the boot scan to land. */
const READY_TIMEOUT_MS = 120_000;

const RTK_VERSION = "9.8.7";
const GSTACK_VERSION = "1.2.3.4";
/** Deliberately NOT the catalog's gstack URL, so catalog data cannot pass. */
const GSTACK_ORIGIN = "https://github.com/closedloop-e2e/gstack-fixture.git";
const GSTACK_SKILL = "ship";
/** The probe argv `detectClaudeCodeRouter` sends; the fake answers only this. */
const NPM_PROBE_ARGS = "ls -g --depth=0 @musistudio/claude-code-router";
/** The install path the scanner records for an npm-global router. */
const ROUTER_NPM_INSTALL_PATH = "@musistudio/claude-code-router (npm -g)";
/**
 * The login shell the resolver runs (`$SHELL -ilc`). Pinned rather than taken
 * from the runner, because an absent shell makes the resolver fall back to the
 * launch PATH, which does not hold `rtk`, and the spec would fail for a reason
 * outside the app.
 */
const LOGIN_SHELL = "/bin/bash";
/** Dirs the login-shell resolver appends when the shell itself fails. */
const RESOLVER_FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** A catalog pack the fixture provides, and what its detail must offer. */
type DetectedPack = {
  packId: string;
  displayName: string;
  /** Harness labels whose header control must read `Update <label>`. */
  updateLabels: string[];
  /** Harness labels whose header control must read `Install <label>`. */
  installLabels: string[];
};

const DETECTED_PACKS: DetectedPack[] = [
  {
    packId: "rtk",
    displayName: "RTK (Rust Token Killer)",
    updateLabels: ["Claude", "Codex"],
    installLabels: [],
  },
  {
    packId: "claude-code-router",
    displayName: "Claude Code Router",
    updateLabels: ["Claude"],
    installLabels: [],
  },
  {
    // Only the Claude skills root holds gstack, so Codex must stay installable:
    // the per-harness control set has to come from the scan, not the catalog.
    packId: "gstack",
    displayName: "gstack",
    updateLabels: ["Claude"],
    installLabels: ["Codex"],
  },
];

/** A catalog pack the fixture does NOT provide: the card's negative control. */
const UNDETECTED_PACK_ID = "superclaude";

type DetectorFixture = {
  root: string;
  home: string;
  rtkPath: string;
  gstackPath: string;
  launchPath: string;
  /** Every argv the fake `npm` was called with, one line per call. */
  npmCallLog: string;
};

type PackProjection = {
  harnesses: string[];
  installs: Array<{
    harness: string;
    installPath: string;
    sourceUrl: string | null;
    version: string | null;
  }>;
};

type PacksDesktopWindow = Window & {
  desktopApi?: {
    db?: {
      getInstalledPacks?: () => Promise<InstalledPack[]>;
      getPackDetail?: (packId: string) => Promise<InstalledPackDetail | null>;
    };
  };
};

test("ISS-11597: the boot scan's rtk, npm-global and git detections reach the Packs screen", async () => {
  test.setTimeout(SPEC_TIMEOUT_MS);
  const homes = makeHarnessHomes();
  const fixture = createDetectorFixture(homes.claudeHome);
  let launched: LaunchedApp | undefined;

  try {
    expect(
      isExecutableFile(LOGIN_SHELL),
      `${LOGIN_SHELL} must exist to act as the login shell`
    ).toBe(true);
    expectNoRouterBinary(fixture.launchPath);

    launched = await launchDesktopApp({
      env: {
        ...homes.env,
        HOME: fixture.home,
        PATH: fixture.launchPath,
        SHELL: LOGIN_SHELL,
        // Opening a pack detail refreshes its contents from GitHub first; the
        // sibling pack specs skip that for the same reason. The detectors are
        // deliberately NOT skipped: they are the subject.
        SKIP_CATALOG_CONTENTS_FETCH: "1",
      },
      userDataPrefix: "desktop-packs-scan-detectors-e2e-",
    });
    const { page } = launched;

    // SYNCHRONIZATION, then the data half of the assertion. The panel reads
    // the catalog once on mount with no retry, so the scan must have landed
    // before anything navigates to Packs.
    await waitForCatalogEntryServing(page, "rtk", READY_TIMEOUT_MS);
    await expect
      .poll(() => readDetections(page), { timeout: READY_TIMEOUT_MS })
      .toEqual({
        "claude-code-router": {
          harnesses: [HarnessName.Claude],
          installs: [
            {
              harness: HarnessName.Claude,
              installPath: ROUTER_NPM_INSTALL_PATH,
              sourceUrl: expect.any(String),
              version: null,
            },
          ],
        },
        gstack: {
          harnesses: [HarnessName.Claude],
          installs: [
            {
              harness: HarnessName.Claude,
              installPath: fixture.gstackPath,
              // From `git remote get-url origin`, not from the catalog.
              sourceUrl: GSTACK_ORIGIN,
              version: GSTACK_VERSION,
            },
          ],
        },
        rtk: {
          harnesses: [HarnessName.Claude, HarnessName.Codex],
          installs: [HarnessName.Claude, HarnessName.Codex].map((harness) => ({
            harness,
            installPath: fixture.rtkPath,
            sourceUrl: expect.any(String),
            // From the fake's own `--version` output.
            version: RTK_VERSION,
          })),
        },
      });
    expect(
      readNpmCalls(fixture),
      "the router row must come from the npm ls -g probe"
    ).toContain(NPM_PROBE_ARGS);

    await gotoNav(page, "packs");

    // The grid: every detected pack reads Installed, and a pack the fixture
    // does not provide reads Install, which proves the locator can fail.
    for (const pack of DETECTED_PACKS) {
      const card = page.getByTestId(`pack-card-${pack.packId}`);
      await expect(card).toBeVisible({ timeout: READY_TIMEOUT_MS });
      await expect(
        card.getByRole("button", { name: "Installed", exact: true })
      ).toBeVisible();
      await expect(
        card.getByRole("button", { name: "Install", exact: true })
      ).toHaveCount(0);
    }
    const undetected = page.getByTestId(`pack-card-${UNDETECTED_PACK_ID}`);
    await expect(
      undetected.getByRole("button", { name: "Install", exact: true })
    ).toBeVisible();
    await expect(
      undetected.getByRole("button", { name: "Installed", exact: true })
    ).toHaveCount(0);

    // The detail: the per-harness controls follow the detected harnesses.
    for (const pack of DETECTED_PACKS) {
      await expectDetailControls(page, pack);
    }

    expect(launched.pageErrors, "no uncaught renderer errors").toEqual([]);
  } finally {
    await launched?.cleanup();
    fs.rmSync(fixture.root, { force: true, recursive: true });
    removeHarnessHomes(homes);
  }
});

/**
 * Write the fixture the boot scan detects. Every path is under one temp root
 * except the gstack repository, which lives in the isolated Claude home where
 * `scanGStack` looks for it.
 */
function createDetectorFixture(claudeHome: string): DetectorFixture {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "closedloop-e2e-scan-detectors-")
  );
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const loginBinDir = path.join(root, "login-bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(loginBinDir, { recursive: true });

  const rtkPath = path.join(loginBinDir, "rtk");
  writeExecutable(
    rtkPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  echo "rtk ${RTK_VERSION}"`,
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n")
  );
  // No backticks anywhere in these scripts: `sh` reads one as a command
  // substitution and the probe then fails for a reason unrelated to the app.
  // The fake records each call, because the router row's fields are constants
  // a detector could write without ever running npm.
  const npmCallLog = path.join(root, "npm-calls.log");
  writeExecutable(
    path.join(binDir, "npm"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuote(npmCallLog)}`,
      `if [ "$*" = "${NPM_PROBE_ARGS}" ]; then`,
      '  echo "+-- @musistudio/claude-code-router@1.0.0"',
      "  exit 0",
      "fi",
      'echo "fixture npm: unsupported arguments: $*" >&2',
      "exit 1",
    ].join("\n")
  );

  // `detectBinaryTool` resolves rtk through `$SHELL -ilc`. Only the isolated
  // HOME's login profiles export rtk's directory, the way a user's rc would,
  // and it is not on the launch PATH: if login-shell discovery breaks, the
  // resolver's fallback PATH cannot find rtk either. `npm` stays on the launch
  // PATH because `detectClaudeCodeRouter` spawns it from the inherited PATH.
  const exportLine = `export PATH=${shellQuote(loginBinDir)}:"$PATH"\n`;
  for (const profile of [".zshenv", ".zshrc", ".bash_profile", ".profile"]) {
    fs.writeFileSync(path.join(home, profile), exportLine);
  }

  const gstackPath = path.join(claudeHome, "skills", "gstack");
  fs.mkdirSync(path.join(gstackPath, GSTACK_SKILL), { recursive: true });
  fs.writeFileSync(path.join(gstackPath, "VERSION"), `${GSTACK_VERSION}\n`);
  fs.writeFileSync(
    path.join(gstackPath, GSTACK_SKILL, "SKILL.md"),
    "# fixture skill\n"
  );
  execFileSync("git", [
    "-c",
    "init.defaultBranch=main",
    "init",
    "--quiet",
    gstackPath,
  ]);
  execFileSync("git", [
    "-C",
    gstackPath,
    "remote",
    "add",
    "origin",
    GSTACK_ORIGIN,
  ]);

  return {
    root,
    home,
    rtkPath,
    gstackPath,
    launchPath: [binDir, process.env.PATH ?? ""].join(path.delimiter),
    npmCallLog,
  };
}

/**
 * PRECONDITION. When the npm probe fails, `detectClaudeCodeRouter` falls back
 * to a `ccr` binary, so a runner that had one would let a broken npm probe pass
 * here. Fail loudly instead of asserting something the fixture cannot prove.
 */
function expectNoRouterBinary(launchPath: string): void {
  const dirs = [
    ...launchPath.split(path.delimiter).filter(Boolean),
    ...RESOLVER_FALLBACK_DIRS,
  ];
  const found = dirs
    .map((dir) => path.join(dir, "ccr"))
    .filter((candidate) => isExecutableFile(candidate));
  expect(
    found,
    "no ccr binary may be reachable, or the router row would not prove the npm probe ran"
  ).toEqual([]);
}

/**
 * The three detected packs as the renderer reads them: harnesses from
 * `getInstalledPacks` (what the grid merges into each card) and install rows
 * from `getPackDetail` (the only read that carries them).
 */
async function readDetections(
  page: Page
): Promise<Record<string, PackProjection | null> | null> {
  return await page.evaluate(
    async (packIds) => {
      const db = (window as PacksDesktopWindow).desktopApi?.db;
      if (!(db?.getInstalledPacks && db.getPackDetail)) {
        return null;
      }
      const installed = await db.getInstalledPacks();
      const result: Record<string, PackProjection | null> = {};
      for (const packId of packIds) {
        const listed = installed.find((pack) => pack.packId === packId);
        const detail = await db.getPackDetail(packId);
        result[packId] =
          listed && detail
            ? {
                harnesses: [...listed.harnesses].sort(),
                installs: detail.installs
                  .map((install) => ({
                    harness: install.harness,
                    installPath: install.installPath,
                    sourceUrl: install.sourceUrl,
                    version: install.version,
                  }))
                  .sort((a, b) => a.harness.localeCompare(b.harness)),
              }
            : null;
      }
      return result;
    },
    DETECTED_PACKS.map((pack) => pack.packId)
  );
}

/**
 * Open a detected pack's detail, assert its per-harness controls, and return to
 * the grid. Every positive control is paired with the absence of its opposite,
 * so a header that rendered every harness the same way cannot pass.
 */
async function expectDetailControls(
  page: Page,
  pack: DetectedPack
): Promise<void> {
  const card = page.getByTestId(`pack-card-${pack.packId}`);
  // Click the name, not the card's center, which can land on the disabled
  // Installed button.
  await card.getByText(pack.displayName, { exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: pack.displayName })
  ).toBeVisible();

  for (const label of pack.updateLabels) {
    await expect(
      page.getByRole("button", { name: `Update ${label}`, exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Install ${label}`, exact: true })
    ).toHaveCount(0);
  }
  for (const label of pack.installLabels) {
    await expect(
      page.getByRole("button", { name: `Install ${label}`, exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Update ${label}`, exact: true })
    ).toHaveCount(0);
  }

  // A button while selection is component state, a link once the detail is
  // addressable (`packs-detail-route`); either returns to the grid.
  await page
    .getByRole("button", { name: "All plugins" })
    .or(page.getByRole("link", { name: "All plugins" }))
    .click();
  await expect(card).toBeVisible();
}

/** The argv lines the fake `npm` recorded, or none if it never ran. */
function readNpmCalls(fixture: DetectorFixture): string[] {
  if (!fs.existsSync(fixture.npmCallLog)) {
    return [];
  }
  return fs.readFileSync(fixture.npmCallLog, "utf8").split("\n");
}

function writeExecutable(filePath: string, body: string): void {
  fs.writeFileSync(filePath, `${body}\n`, { mode: 0o755 });
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** POSIX single-quote escaping, so a temp path cannot break the profile. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
