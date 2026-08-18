/**
 * ISS-5027 launched-app regression E2E for the `"auto"` harness sentinel.
 *
 * The renderer's per-component Install action (`agent-detail-view.tsx`) and the
 * opt-in distributions banner both send the sentinel over
 * `desktop:db:catalog-install`. Before the fix the main process interpreted it
 * ONLY for `single_install` packs; every other pack fell through to a command-map
 * lookup keyed by `"auto"` — a key that by construction never exists — so the
 * IPC resolved `{ started: false, error: ENOCOMMAND }` and nothing ever spawned.
 *
 * The mocked renderer test proves the button calls the IPC, and the `streamRun`
 * node test proves resolution in isolation; neither crosses the boundary. These
 * specs drive the REAL preload -> `ipcMain` -> `streamRun` path inside the
 * launched Electron app, which is where the defect actually lived, per the
 * "UI bug fix ⇒ regression e2e" rule in `apps/desktop/AGENTS.md`.
 *
 * Both packs are seeded test-only rows with inert commands. The shipped catalog
 * rows install real software, and every real install command is gated on a
 * harness CLI being on PATH — which a CI runner does not have — so neither is
 * usable as a deterministic fixture here.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { CatalogMutationResult } from "../../src/shared/agent-db-contract.js";
import {
  HARNESS_AUTO,
  StreamRunErrorCode,
} from "../../src/shared/install-run-contract.js";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { seedPackCatalogEntry } from "./helpers/seed-pack-catalog-db";

/** The pre-fix failure text: the sentinel leaking into a command-map lookup. */
const AUTO_SENTINEL_RE = /'auto'/;
const NO_CLI_ON_PATH_RE = /none of those CLIs/;
/** Ceiling for the asynchronous Agent Dashboard runtime to start serving. */
const RUNTIME_READY_TIMEOUT_MS = 30_000;
type DesktopWindow = Window & {
  desktopApi?: {
    db?: {
      getCatalogEntry?: (packId: string) => Promise<unknown | null>;
      catalogInstall?: (
        packId: string,
        harness: string
      ) => Promise<CatalogMutationResult>;
      catalogUninstall?: (
        packId: string,
        harness: string
      ) => Promise<CatalogMutationResult>;
    };
  };
};

type CatalogAction = "install" | "uninstall";

test.describe("Pack install: auto-harness sentinel (ISS-5027)", () => {
  test("an auto uninstall of a non-single_install pack STARTS through the real IPC", async () => {
    // Uninstall is the only branch that can genuinely spawn on a runner with no
    // harness CLI installed: on-disk artifacts outlive a CLI, so it is not gated
    // on PATH the way install is. That makes it the case that proves an `auto`
    // run reaches a child process end-to-end, not just that resolution returned
    // a string.
    const launched = await launchDesktopApp({
      userDataPrefix: "desktop-pack-install-auto-e2e-",
    });

    try {
      await seedPackCatalogEntry(launched.userDataDir, {
        displayName: "Auto Harness E2E Pack",
        harnesses: ["claude", "codex"],
        installCommands: {
          claude: "echo closedloop-e2e-install-claude",
          codex: "echo closedloop-e2e-install-codex",
        },
        packId: "closedloop-e2e-auto-harness",
        uninstallCommands: {
          claude: "echo closedloop-e2e-uninstall-claude",
          codex: "echo closedloop-e2e-uninstall-codex",
        },
      });
      await gotoNav(launched.page, "sessions");

      const result = await invokeCatalogAction(
        launched.page,
        "uninstall",
        "closedloop-e2e-auto-harness"
      );

      // Pre-fix this was
      // `ENOCOMMAND: no uninstall command for harness 'auto' on pack '…'`.
      expect(result.error).toBeUndefined();
      expect(result.started).toBe(true);
      expect(typeof result.runId).toBe("number");
    } finally {
      await launched.cleanup();
    }
  });

  test("an auto install reports the specific missing-CLI reason, never the sentinel miss", async () => {
    // The install branch IS gated on a harness CLI, so on a machine without one
    // it cannot start — but WHICH failure it reports is the regression signal.
    // A harness id no CLI maps to pins that deterministically on every host:
    // pre-fix the sentinel missed the command map (ENOCOMMAND, naming 'auto'),
    // post-fix resolution runs and reports the real, actionable reason.
    const launched = await launchDesktopApp({
      userDataPrefix: "desktop-pack-install-auto-nocli-e2e-",
    });

    try {
      await seedPackCatalogEntry(launched.userDataDir, {
        displayName: "Auto Harness E2E Unmapped Pack",
        harnesses: ["closedloop-e2e-absent-harness"],
        installCommands: {
          "closedloop-e2e-absent-harness": "echo closedloop-e2e-never-runs",
        },
        packId: "closedloop-e2e-auto-harness-nocli",
        uninstallCommands: {},
      });
      await gotoNav(launched.page, "sessions");

      const result = await invokeCatalogAction(
        launched.page,
        "install",
        "closedloop-e2e-auto-harness-nocli"
      );

      expect(result.started).toBe(false);
      expect(result.error?.code).toBe(StreamRunErrorCode.NoCli);
      expect(result.error?.code).not.toBe(StreamRunErrorCode.NoCommand);
      expect(result.error?.message ?? "").toMatch(NO_CLI_ON_PATH_RE);
      expect(result.error?.message ?? "").not.toMatch(AUTO_SENTINEL_RE);
    } finally {
      await launched.cleanup();
    }
  });
});

/**
 * Call the real catalog install/uninstall IPC from the launched renderer.
 *
 * Waits on a READ first. The Agent Dashboard runtime comes up asynchronously
 * after the window opens, and until it does the IPC contract answers every
 * catalog channel with a neutral disabled response — `null` for a read,
 * `AGENT_DASHBOARD_DISABLED` for a mutation. Polling the mutation itself would
 * mean firing repeated real runs, so the gate is `getCatalogEntry`: it returns
 * the seeded row only once the runtime is serving, and doubles as proof the seed
 * landed in the store the app is actually reading.
 */
async function invokeCatalogAction(
  page: Page,
  action: CatalogAction,
  packId: string
): Promise<CatalogMutationResult> {
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const db = (window as DesktopWindow).desktopApi?.db;
          if (!db?.getCatalogEntry) {
            return "missing";
          }
          const entry = await db.getCatalogEntry(id);
          return entry ? "serving" : "starting";
        }, packId),
      { timeout: RUNTIME_READY_TIMEOUT_MS }
    )
    .toBe("serving");

  return await page.evaluate(
    async (input) => {
      const db = (window as DesktopWindow).desktopApi?.db;
      const call =
        input.action === "uninstall"
          ? db?.catalogUninstall
          : db?.catalogInstall;
      if (!call) {
        throw new Error(`desktopApi.db.catalog-${input.action} is unavailable`);
      }
      return await call(input.packId, input.harness);
    },
    { action, harness: HARNESS_AUTO, packId }
  );
}
