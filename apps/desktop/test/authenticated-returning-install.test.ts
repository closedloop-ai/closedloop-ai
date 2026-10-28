import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DASHBOARD_FLAG_SET,
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
  desktopGuestGuidedOnboardingStorageKey,
} from "../src/renderer/components/dashboard/dashboard-storage-keys";
import { launchAuthenticatedDesktopApp } from "./e2e/helpers/authenticated-desktop-app.js";
import {
  type ElectronLauncher,
  hasProcessExited,
  MAIN_JS,
  RETURNING_INSTALL_LOCAL_STORAGE_SEED,
} from "./e2e/helpers/desktop-app.js";
import type * as ReturningSeedModule from "./e2e/helpers/returning-install-seed.js";
import {
  returningInstallSeedEnv,
  returningInstallSeedLaunchArgs,
} from "./e2e/helpers/returning-install-seed.js";
import { succeedingElectronLauncher } from "./support/electron-launcher-stub.js";

const readback = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>()
);
vi.mock("./e2e/helpers/returning-install-seed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ReturningSeedModule>()),
  assertReturningInstallSeed: readback,
}));

const roots: string[] = [];
const children: ChildProcess[] = [];
const seedSchema = z.record(z.string(), z.string());
afterEach(() => {
  readback.mockReset();
  for (const child of children.splice(0)) {
    if (!hasProcessExited(child)) {
      child.kill("SIGKILL");
    }
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("explicit authenticated returning-install wiring", () => {
  it.each([undefined, false])(
    "keeps first-run launch and readback unchanged for opt-in=%s",
    async (returningInstall) => {
      const profile = makeRoot();
      let captured: Parameters<ElectronLauncher>[0];
      const launched = await launchAuthenticatedDesktopApp({
        userDataDir: profile,
        returningInstall,
        launchElectron: succeedingElectronLauncher(children, (options) => {
          captured = options;
        }),
      });
      try {
        const preload = returningInstallSeedLaunchArgs(false)[1];
        const [key] = Object.keys(
          returningInstallSeedEnv(false, RETURNING_INSTALL_LOCAL_STORAGE_SEED)
        );
        expect(captured?.args).not.toContain(preload);
        expect(captured?.env?.[key]).toBe(process.env[key]);
        expect(readback).not.toHaveBeenCalled();
      } finally {
        await launched.cleanup();
      }
    }
  );

  it("forwards byte-equivalent args and env for absent and false options", async () => {
    const profile = makeRoot();
    const homes = makeRoot();
    const observed: Parameters<ElectronLauncher>[0][] = [];
    for (const returningInstall of [undefined, false]) {
      const launched = await launchAuthenticatedDesktopApp({
        userDataDir: profile,
        harnessHomesRoot: homes,
        returningInstall,
        launchElectron: succeedingElectronLauncher(children, (options) =>
          observed.push(options)
        ),
      });
      await launched.cleanup();
    }
    expect(observed[0]).toEqual(observed[1]);
    expect(readback).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "checks the chosen exact first-frame seed before returning the handle: dashboard=%s",
    async (seedDashboardStorage) => {
      let enter: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let accept: () => void = () => undefined;
      const accepted = new Promise<void>((resolve) => {
        accept = resolve;
      });
      readback.mockImplementation(() => {
        enter();
        return accepted;
      });
      const onReturned = vi.fn();
      let captured: Parameters<ElectronLauncher>[0];
      const pending = launchAuthenticatedDesktopApp({
        userDataDir: makeRoot(),
        returningInstall: !seedDashboardStorage,
        seedDashboardStorage,
        launchElectron: succeedingElectronLauncher(children, (options) => {
          captured = options;
        }),
      });
      pending.then(onReturned);
      await entered;
      try {
        expect(onReturned).not.toHaveBeenCalled();
        const args = captured?.args ?? [];
        const preload = returningInstallSeedLaunchArgs(false)[1];
        expect(args.indexOf(preload)).toBeGreaterThan(0);
        expect(args.indexOf(preload)).toBeLessThan(args.indexOf(MAIN_JS));
        expect(args[args.indexOf(preload) - 1]).toBe("-r");
        const [key] = Object.keys(
          returningInstallSeedEnv(false, RETURNING_INSTALL_LOCAL_STORAGE_SEED)
        );
        const seed = seedSchema.parse(
          JSON.parse(captured?.env?.[key] ?? "null")
        );
        if (seedDashboardStorage) {
          expect(seed).toEqual({
            [dashboardOnboardedStorageKey]: DASHBOARD_FLAG_SET,
            [dashboardTourSeenStorageKey]: DASHBOARD_FLAG_SET,
          });
          expect(seed).not.toHaveProperty(
            desktopGuestGuidedOnboardingStorageKey
          );
        } else {
          expect(seed).toEqual({
            ...RETURNING_INSTALL_LOCAL_STORAGE_SEED,
            [dashboardOnboardedStorageKey]: DASHBOARD_FLAG_SET,
          });
        }
        expect(readback).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          seed,
          60_000,
          expect.anything()
        );
      } finally {
        accept();
        const launched = await pending;
        await launched.cleanup();
      }
    }
  );

  it.each([false, true])(
    "preserves strict readback failure and closes only its child/homes: dashboard=%s",
    async (seedDashboardStorage) => {
      const profile = makeRoot();
      const homes = makeRoot();
      const error = new Error("synthetic canonical seed mismatch");
      readback.mockRejectedValue(error);
      await expect(
        launchAuthenticatedDesktopApp({
          userDataDir: profile,
          harnessHomesRoot: homes,
          returningInstall: !seedDashboardStorage,
          seedDashboardStorage,
          launchElectron: succeedingElectronLauncher(children),
        })
      ).rejects.toBe(error);
      expect(readback).toHaveBeenCalledOnce();
      expect(hasProcessExited(children[0])).toBe(true);
      expect(fs.existsSync(homes)).toBe(false);
      expect(fs.existsSync(profile)).toBe(true);
    }
  );
  it("keeps absent and false Dashboard options byte-equivalent and skips readback", async () => {
    const profile = makeRoot();
    const homes = makeRoot();
    const observed: Parameters<ElectronLauncher>[0][] = [];
    for (const seedDashboardStorage of [undefined, false]) {
      const launched = await launchAuthenticatedDesktopApp({
        userDataDir: profile,
        harnessHomesRoot: homes,
        seedDashboardStorage,
        launchElectron: succeedingElectronLauncher(children, (options) =>
          observed.push(options)
        ),
      });
      await launched.cleanup();
    }
    expect(observed[0]).toEqual(observed[1]);
    expect(readback).not.toHaveBeenCalled();
  });

  it("rejects conflicting seeds before launching a child or creating homes", async () => {
    const profile = makeRoot();
    const homes = path.join(profile, "not-created");
    await expect(
      launchAuthenticatedDesktopApp({
        userDataDir: profile,
        harnessHomesRoot: homes,
        returningInstall: true,
        seedDashboardStorage: true,
        launchElectron: succeedingElectronLauncher(children),
      })
    ).rejects.toThrow("Choose one authenticated first-frame storage seed");
    expect(children).toHaveLength(0);
    expect(readback).not.toHaveBeenCalled();
    expect(fs.existsSync(homes)).toBe(false);
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "authenticated-returning-unit-")
  );
  roots.push(root);
  return root;
}
