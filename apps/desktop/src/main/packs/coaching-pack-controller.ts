/**
 * @file coaching-pack-controller.ts
 * @description The desktop coaching-pack slice: the two feature-flag reads that
 * gate it, the userData packs directory, the seed-once-per-process copy of the
 * bundled packs, and the org-distribution install. Lifted out of the
 * grandfathered `app.ts`, which held it only because the IPC layer reads it
 * through the application object — the slice itself needs nothing from the app
 * beyond a flag reader and the userData path, so it belongs beside
 * `coaching-distribution-install.ts`, the install path it drives.
 */

import path from "node:path";
import type { DistributionDto } from "@repo/api/src/types/distribution";
import {
  DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY,
  DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY,
  type FlagKey,
} from "../../shared/feature-flags.js";
import {
  coachingPackSlug,
  getActiveCoachingPack,
  installCoachingPackFromDistribution,
  resolveBundledCoachingPacksDir,
  seedBundledCoachingPacks,
  shouldHonorDistributionDefault,
} from "../agent-monitor/agent-coaching-packs.js";
import { isDesktopMainFeatureFlagEnabled } from "../auth/desktop-feature-flag-assignment.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { installCoachingDistribution } from "./coaching-distribution-install.js";
import type { CoachingInstallOutcome } from "./required-plugin-installer.js";

export type CoachingPackController = {
  /** userData directory the installed coaching packs live in. */
  packsDir: () => string;
  isTipsEnabled: () => boolean;
  isPacksEnabled: () => boolean;
  getActivePackSeeded: () => ReturnType<typeof getActiveCoachingPack>;
  installDistribution: (
    dist: DistributionDto
  ) => Promise<CoachingInstallOutcome>;
};

export function createCoachingPackController(deps: {
  getFlag: (key: FlagKey) => boolean;
  getUserDataDir: () => string;
}): CoachingPackController {
  // Seed-once guard: bundled coaching packs are copied into userData the first
  // time the active pack is read this process, then left alone (so a user's
  // later pack choice is never re-seeded over).
  let seeded = false;

  const packsDir = (): string =>
    path.join(deps.getUserDataDir(), "coaching-packs");

  // ISS-8792: `agentCoachingTips` is read by the RENDERER too
  // (`sessions-v2-view.tsx`), so it must have ONE verdict. That verdict is the
  // signed-in account's PostHog assignment, the same source the renderer
  // resolves — reading the persisted setting here let main and the surface
  // disagree about one account. Read at the branch it steers, per call, so an
  // assignment that lands after boot simply opens the next read; nothing is
  // snapshotted.
  const isTipsEnabled = (): boolean =>
    isDesktopMainFeatureFlagEnabled(
      DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY
    );

  // Coaching packs ride on top of coaching tips: the override only applies when
  // BOTH the tips feature and the packs flag are on. Off → built-in signals.
  //
  // `agentCoachingPacks` stays a persisted Labs SETTING deliberately: no
  // renderer surface reads it, so it is a desktop-local main-process capability
  // and there is no second answer for it to diverge from.
  const isPacksEnabled = (): boolean =>
    isTipsEnabled() &&
    deps.getFlag(DESKTOP_AGENT_COACHING_PACKS_FEATURE_FLAG_KEY);

  const getActivePackSeeded = (): ReturnType<typeof getActiveCoachingPack> => {
    const dir = packsDir();
    if (!seeded) {
      try {
        seedBundledCoachingPacks(dir, resolveBundledCoachingPacksDir());
      } catch (error) {
        gatewayLog.warn(
          "agent-coaching",
          `coaching pack seeding failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      seeded = true;
    }
    return getActiveCoachingPack(dir);
  };

  /**
   * Install an org-distributed coaching-pack (FEA-2923 batch 5) via the
   * distribution/install path. Downloads + extracts the presigned asset zip and
   * copies/activates it through `installCoachingPackFromDistribution`, honoring
   * override precedence. Extraction uses adm-zip (loaded lazily so it never
   * costs anything on the seed/local path).
   */
  const installDistribution = async (
    dist: DistributionDto
  ): Promise<CoachingInstallOutcome> => {
    if (!isPacksEnabled()) {
      // Feature-flag off: the device's coaching state did NOT converge, so we
      // must NOT report "installed" (which `skipped` maps to). Report a distinct
      // `disabled` outcome that the installer maps to `pending`, matching the
      // "runtime not ready"/"not wired" precedent — the cloud only sees
      // "installed" when the pack genuinely landed.
      return { status: "disabled" };
    }
    const { default: AdmZip } = await import("adm-zip");
    return installCoachingDistribution(dist, {
      packsDir: packsDir(),
      coachingPackSlug,
      shouldHonorDistributionDefault,
      installCoachingPackFromDistribution,
      extractZip: (zipBytes, destDir) => {
        new AdmZip(zipBytes).extractAllTo(destDir, true);
      },
    });
  };

  return {
    packsDir,
    isTipsEnabled,
    isPacksEnabled,
    getActivePackSeeded,
    installDistribution,
  };
}
