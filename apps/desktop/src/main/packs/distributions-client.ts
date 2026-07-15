/**
 * @file distributions-client.ts
 * @description Desktop client for the distributions endpoints:
 *   GET /desktop/distributions/assigned — fetch org distributions assigned to
 *     this compute target (auto_install + opt_in), authenticated via the first-
 *     party Desktop session JWT.
 *   POST /desktop/distributions/status — report per-distribution install/enable
 *     status back to the cloud after `RequiredPluginInstaller.reconcile()`.
 *
 * Both calls use the first-party `withAnyAuth` Bearer token, not the gateway
 * auth token — they are user-scoped desktop→cloud calls, not agent→gateway.
 *
 * FEA-2923 (T-16.9)
 */

import type {
  DistributionDto,
  DistributionStatusReport,
} from "@repo/api/src/types/distribution";
import { z } from "zod";
import {
  type SessionFetchOptions,
  unwrapApiEnvelope,
} from "../api-response-utils.js";
import { fetchJsonAndParse } from "../fetch-json-and-parse.js";
import { gatewayLog } from "../gateway-logger.js";

// ---------------------------------------------------------------------------
// Zod schemas for response parsing
// ---------------------------------------------------------------------------

// Parses just the fields needed from the catalogItem sub-object. Extra fields
// from the server are passed through (Zod strips unknowns by default per passthrough).
const catalogItemSchema = z.object({
  id: z.string(),
  targetKind: z.string(),
  name: z.string(),
  source: z.string(),
  // FEA-2923 batch 5: coaching packs route through the coaching install path.
  // Optional + defaults false for back-compat with responses that omit it.
  coaching: z.boolean().optional().default(false),
});

const distributionDtoSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  catalogItemId: z.string(),
  catalogItem: catalogItemSchema,
  mode: z.string(), // DistributionMode: "auto_install" | "opt_in"
  targetingType: z.string(), // DistributionTargetingType: "all" | "specific"
  desiredEnabled: z.boolean().default(true),
  targetingEntries: z.array(z.unknown()).default([]),
  targetStatuses: z.array(z.unknown()).default([]),
  assetDownloadUrl: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const assignedDistributionsSchema = z.array(distributionDtoSchema);

// ---------------------------------------------------------------------------
// Request timeout
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type DistributionsClientOptions = SessionFetchOptions;

/**
 * GET /desktop/distributions/assigned?computeTargetId=...
 *
 * Returns the list of CatalogItem distributions targeting this compute target.
 * Each auto_install distribution includes a presigned S3 asset download URL
 * (15-min TTL) when a zip asset exists. Returns an empty array on any error
 * so callers can fall back gracefully without disrupting the boot sequence.
 */
export async function getAssignedDistributions(
  options: DistributionsClientOptions,
  computeTargetId: string
): Promise<DistributionDto[]> {
  let accessToken: string | null;
  try {
    accessToken = await options.getAccessToken();
  } catch {
    return [];
  }
  const apiOrigin = options.getApiOrigin();
  if (!(accessToken && apiOrigin)) {
    return [];
  }

  const path = `/desktop/distributions/assigned?computeTargetId=${encodeURIComponent(computeTargetId)}`;
  const result = await fetchJsonAndParse(path, assignedDistributionsSchema, {
    apiOrigin,
    token: accessToken,
    unwrap: unwrapApiEnvelope,
    sentinel: null,
    timeoutMs: REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetch,
  });

  if (result === null) {
    gatewayLog.info(
      "distributions-client",
      `getAssigned: no data returned for computeTargetId=${computeTargetId}`
    );
    return [];
  }

  return result as DistributionDto[];
}

/**
 * POST /desktop/distributions/status
 *
 * Reports per-distribution install/enable status to the cloud. Best-effort:
 * failures are logged but never throw so the caller (RequiredPluginInstaller)
 * can continue with remaining distributions.
 */
export async function reportDistributionStatus(
  options: DistributionsClientOptions,
  computeTargetId: string,
  reports: DistributionStatusReport[]
): Promise<void> {
  if (reports.length === 0) {
    return;
  }

  let accessToken: string | null;
  try {
    accessToken = await options.getAccessToken();
  } catch {
    gatewayLog.warn(
      "distributions-client",
      "reportStatus: could not get access token"
    );
    return;
  }
  const apiOrigin = options.getApiOrigin();
  if (!(accessToken && apiOrigin)) {
    return;
  }

  let url: URL;
  try {
    url = new URL("/desktop/distributions/status", apiOrigin);
  } catch {
    gatewayLog.warn(
      "distributions-client",
      `reportStatus: invalid apiOrigin: ${apiOrigin}`
    );
    return;
  }

  const fetchFn = options.fetch ?? fetch;
  try {
    const response = await fetchFn(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ computeTargetId, reports }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      gatewayLog.warn(
        "distributions-client",
        `reportStatus: HTTP ${response.status}: ${body.slice(0, 200)}`
      );
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    gatewayLog.warn(
      "distributions-client",
      `reportStatus: network error: ${msg}`
    );
  }
}
