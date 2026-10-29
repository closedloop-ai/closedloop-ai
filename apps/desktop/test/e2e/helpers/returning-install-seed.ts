import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { z } from "zod";

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
const SEED_ENV_KEY = "CLOSEDLOOP_BRIDGE_TAB_LOCAL_STORAGE_SEED";

/** Installs an additive session preload before the built app creates its window. */
export function returningInstallSeedLaunchArgs(
  keepFirstRunState: boolean | undefined
): string[] {
  return keepFirstRunState === true
    ? []
    : ["-r", path.join(helpersDir, "returning-install-seed-main-preload.cjs")];
}

/** Reuses the sidecar seed contract without changing any production preload API. */
export function returningInstallSeedEnv(
  keepFirstRunState: boolean | undefined,
  seed: Readonly<Record<string, string>>
): Record<string, string> {
  return keepFirstRunState === true
    ? {}
    : { [SEED_ENV_KEY]: JSON.stringify(seed) };
}

/** Read back every required key before returning the usable initial shell. */
export async function assertReturningInstallSeed(
  page: Page,
  seed: Readonly<Record<string, string>>,
  timeoutMs: number,
  app?: ElectronApplication
): Promise<void> {
  const mismatches = await page.evaluate(
    (expected) =>
      Object.entries(expected)
        .map(([key, expectedValue]) => ({
          key,
          expected: expectedValue,
          actual: localStorage.getItem(key),
        }))
        .filter(
          ({ expected: expectedValue, actual }) => actual !== expectedValue
        ),
    seed
  );
  if (mismatches.length > 0) {
    const initial =
      app === undefined
        ? undefined
        : seedReceiptSchema.safeParse(
            await app.evaluate(() =>
              Reflect.get(globalThis, "__returningInstallSeedReceipt")
            )
          );
    throw new Error(
      `returning-install preload seed was not applied: ${mismatches.map(({ key }) => key).join("; ")}; readback=${JSON.stringify(
        {
          mismatches,
          initial: initial?.success ? initial.data : null,
          ownership:
            app === undefined
              ? null
              : await app.evaluate(() =>
                  Reflect.get(globalThis, "__returningInstallSeedOwnership")
                ),
        }
      )}`
    );
  }
  await expect(page.locator("main")).toBeVisible({ timeout: timeoutMs });
}

const seedReceiptSchema = z.object({
  url: z.string(),
  readyState: z.string(),
  bodyPresent: z.boolean(),
  seed: z.record(z.string(), z.string().nullable()),
  error: z.string().optional(),
});
