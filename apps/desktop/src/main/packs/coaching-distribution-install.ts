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
import { gatewayLog } from "../logging/gateway-logger.js";
import { requireHttps } from "../util/require-https.js";
import type { CoachingInstallOutcome } from "./required-plugin-installer.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Ceiling on the coaching-pack asset body we will buffer into memory before
 * handing the bytes to adm-zip. `assetDownloadUrl` is a presigned URL an
 * attacker can influence (a compromised cloud response or a downgraded asset
 * host), and this download auto-fires on every cloud-online reconcile, so an
 * unbounded `response.arrayBuffer()` could return a multi-GB body and OOM/crash
 * the Electron main process. Like every other network-body ingest in main
 * (gateway-dispatch, otlp-http-receiver), we cap it. Coaching packs are a few
 * KB; this ceiling is generous while staying bounded.
 */
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

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
  /** Max asset bytes to buffer (defaults to `MAX_ASSET_BYTES`). Injectable for tests. */
  maxAssetBytes?: number;
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
    zipBytes = await downloadAsset(
      url,
      deps.fetch ?? fetch,
      deps.maxAssetBytes ?? MAX_ASSET_BYTES
    );
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
  fetchImpl: typeof fetch,
  maxBytes: number
): Promise<Buffer> {
  // The presigned URL is attacker-influenceable — require https so a downgraded
  // asset host cannot serve the pack over cleartext http.
  requireHttps(url, "asset download URL");

  // The https check above only vets the ORIGINAL url; a 3xx would let the asset
  // host redirect us to http or an internal address (169.254.169.254, a private
  // range) and fetch would silently follow it, defeating the guard. Refuse to
  // follow any redirect, matching the presigned-download fetches in
  // transcript-read-cache.ts / loop-finalizer.ts.
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  // Reject early on an advertised over-cap Content-Length, then enforce the
  // same ceiling on the bytes actually received (the header is untrusted).
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`asset exceeds max size (${declared} > ${maxBytes} bytes)`);
  }

  return await readCappedBody(response, maxBytes);
}

/**
 * Stream `response` into a Buffer, aborting as soon as the accumulated body
 * exceeds `maxBytes`. Prevents a lying/absent Content-Length from OOM-ing the
 * main process the way an unbounded `arrayBuffer()` would.
 */
async function readCappedBody(
  response: Response,
  maxBytes: number
): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    // No streamable body — fall back to a buffered read, itself bounded by the
    // already-checked Content-Length, and re-verify the received length.
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(
        `asset exceeds max size (${arrayBuffer.byteLength} > ${maxBytes} bytes)`
      );
    }
    return Buffer.from(arrayBuffer);
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        // Stop pulling the (attacker-sized) body instead of draining it.
        await reader.cancel();
        throw new Error(`asset exceeds max size (> ${maxBytes} bytes)`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Deterministically drop the lock on every path (normal completion, an
    // over-cap throw, or a mid-stream read rejection such as the timeout abort).
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
