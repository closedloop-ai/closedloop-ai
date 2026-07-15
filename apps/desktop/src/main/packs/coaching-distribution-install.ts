/**
 * @file coaching-distribution-install.ts
 * @description Downloads + extracts an org-distributed coaching-pack asset zip
 * and installs it via `installCoachingPackFromDistribution`, honoring the
 * override-precedence invariant (`shouldHonorDistributionDefault`).
 *
 * This is the `installCoachingDistribution` callback body for
 * `RequiredPluginInstaller` (FEA-2923 batch 5). It is the ONLY place the
 * coaching distribution slice performs I/O:
 *   1. GET the presigned `assetDownloadUrl` (15-min TTL) → zip bytes.
 *   2. Extract the zip into a temp directory.
 *   3. Call `installCoachingPackFromDistribution(sourceDir, packsDir, activate)`
 *      which copies + (first-seed-only) activates the pack, never clobbering a
 *      recorded user choice.
 *
 * Kept transport-agnostic: the fetch impl, extractor, and installer are all
 * injectable so this is unit-testable without electron or the network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DistributionDto } from "@repo/api/src/types/distribution";
import type { CoachingPackInfo } from "../../shared/coaching-pack-contract.js";
import { gatewayLog } from "../gateway-logger.js";
import type { CoachingInstallOutcome } from "./required-plugin-installer.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;

export type CoachingDistributionInstallDeps = {
  /** Absolute path to the managed coaching-packs store (userData/coaching-packs). */
  packsDir: string;
  /** Derive the pack slug from a CatalogItem name (coachingPackSlug). */
  coachingPackSlug: (name: string) => string | null;
  /** Override-precedence gate: true when the distribution default may be applied. */
  shouldHonorDistributionDefault: (
    packsDir: string,
    packSlug: string
  ) => boolean;
  /**
   * Extract a zip buffer into `destDir`. Injected so the extractor (adm-zip) is
   * not a hard dependency of the test surface.
   */
  extractZip: (zipBytes: Buffer, destDir: string) => void;
  /** Copy + (first-seed) activate the extracted pack; returns the pack info. */
  installCoachingPackFromDistribution: (
    sourceDir: string,
    packsDir: string,
    activate?: boolean
  ) => CoachingPackInfo | null;
  /** Injectable fetch (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Injectable temp-dir factory (defaults to os.tmpdir mkdtemp). */
  makeTempDir?: () => string;
};

/**
 * Install a coaching-pack distribution end-to-end. Returns a
 * `CoachingInstallOutcome` the installer maps to a cloud status report.
 */
export async function installCoachingDistribution(
  dist: DistributionDto,
  deps: CoachingDistributionInstallDeps
): Promise<CoachingInstallOutcome> {
  const url = dist.assetDownloadUrl;
  if (!url) {
    return { status: "failed", failureReason: "no asset download URL" };
  }
  const slug = dist.catalogItem.name
    ? deps.coachingPackSlug(dist.catalogItem.name)
    : null;
  if (!slug) {
    return { status: "failed", failureReason: "invalid coaching pack name" };
  }

  // Override precedence: if the user has already recorded a choice AND the pack
  // is not already present, skip (do not clobber). This pre-download check keys
  // on the CATALOG-ITEM-derived `slug` (above), whereas the actual install keys
  // on the MANIFEST-derived slug (`installCoachingPackFromDistribution` derives
  // its slug from the extracted `manifest.name`). That is intentional:
  //   - The manifest is only available AFTER download+extract, so the pre-check
  //     — whose whole purpose is to avoid a needless download — cannot use it.
  //   - The catalog-item name is authoritative and MUST equal the pack's
  //     manifest name; the cloud CatalogItem is minted from the same pack.
  //   - `installCoachingPackFromDistribution` re-enforces the same
  //     override-precedence invariant against the manifest slug (the source of
  //     truth), so a name mismatch can never clobber a recorded user choice —
  //     the pre-check is only a fast-path optimization, never the guard.
  if (!deps.shouldHonorDistributionDefault(deps.packsDir, slug)) {
    return { status: "skipped" };
  }

  let zipBytes: Buffer;
  try {
    zipBytes = await downloadAsset(url, deps.fetch ?? fetch);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "failed", failureReason: `download failed: ${msg}` };
  }

  const tempDir = deps.makeTempDir
    ? deps.makeTempDir()
    : mkdtempSync(path.join(tmpdir(), "coaching-dist-"));
  try {
    deps.extractZip(zipBytes, tempDir);
    const installed = deps.installCoachingPackFromDistribution(
      tempDir,
      deps.packsDir,
      true
    );
    if (!installed) {
      return {
        status: "failed",
        failureReason: "extracted asset is not a valid coaching pack",
      };
    }
    return { status: "installed", installedVersion: installed.version ?? null };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "failed", failureReason: `install failed: ${msg}` };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error: unknown) {
      gatewayLog.warn(
        "coaching-distribution-install",
        `temp cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

async function downloadAsset(
  url: string,
  fetchImpl: typeof fetch
): Promise<Buffer> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
