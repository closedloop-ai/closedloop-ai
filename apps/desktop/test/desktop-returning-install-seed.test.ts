import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ElectronLauncher,
  launchDesktopApp,
  RETURNING_INSTALL_LOCAL_STORAGE_SEED,
} from "./e2e/helpers/desktop-app.js";
import {
  assertReturningInstallSeed,
  returningInstallSeedEnv,
  returningInstallSeedLaunchArgs,
} from "./e2e/helpers/returning-install-seed.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("omits the returning-install hook and automatic seed for first-run launches", () => {
  expect(returningInstallSeedLaunchArgs(true)).toEqual([]);
  expect(
    returningInstallSeedEnv(true, RETURNING_INSTALL_LOCAL_STORAGE_SEED)
  ).toEqual({});
});

it("reports every mismatched canonical key before waiting for a shell", async () => {
  const missing = Object.entries(RETURNING_INSTALL_LOCAL_STORAGE_SEED).map(
    ([key, expectedValue]) => ({ key, expected: expectedValue, actual: null })
  );
  const page: Pick<Page, "evaluate" | "locator"> = {
    evaluate: vi.fn<Page["evaluate"]>().mockResolvedValue(missing),
    locator: vi.fn<Page["locator"]>(),
  };
  await expect(
    assertReturningInstallSeed(
      page as Page,
      RETURNING_INSTALL_LOCAL_STORAGE_SEED,
      30_000
    )
  ).rejects.toThrow(
    `returning-install preload seed was not applied: ${missing.map(({ key }) => key).join("; ")}`
  );
  expect(page.evaluate).toHaveBeenCalledWith(
    expect.any(Function),
    RETURNING_INSTALL_LOCAL_STORAGE_SEED
  );
  expect(page.locator).not.toHaveBeenCalled();
});

describe("actual Desktop launcher seed wiring", () => {
  it.each([false, true])(
    "uses the intended first-run opt-out=%s before spawn and cleans a failed launch",
    async (keepFirstRunState) => {
      const homes = fs.mkdtempSync(
        path.join(os.tmpdir(), "returning-seed-unit-homes-")
      );
      roots.push(homes);
      let profile: string | undefined;
      let captured: Parameters<ElectronLauncher>[0] | undefined;
      const launcher: ElectronLauncher = (options) => {
        captured = options;
        return Promise.reject(new Error("synthetic launch stop"));
      };
      await expect(
        launchDesktopApp({
          keepFirstRunState,
          harnessHomesRoot: homes,
          beforeLaunch: (directory) => {
            profile = directory;
            roots.push(directory);
          },
          launchElectron: launcher,
        })
      ).rejects.toThrow("synthetic launch stop");
      if (captured === undefined || profile === undefined) {
        throw new Error("Actual launcher spawn seam was not reached");
      }
      const returningArgs = returningInstallSeedLaunchArgs(false);
      const returningPreload = returningArgs[1];
      expect(captured.args?.includes(returningPreload)).toBe(
        !keepFirstRunState
      );
      const seededEnv = returningInstallSeedEnv(
        false,
        RETURNING_INSTALL_LOCAL_STORAGE_SEED
      );
      const [seedKey] = Object.keys(seededEnv);
      const expectedSeed = keepFirstRunState
        ? process.env[seedKey]
        : seededEnv[seedKey];
      expect(captured.env?.[seedKey]).toBe(expectedSeed);
      expect(fs.existsSync(profile)).toBe(false);
      expect(fs.existsSync(homes)).toBe(false);
    }
  );
});
