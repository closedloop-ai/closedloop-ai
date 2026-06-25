import "server-only";

import { log } from "@repo/observability/log";
import { get } from "@vercel/edge-config";
import { z } from "zod";

/**
 * FEA-1485 — resolve the api-prod deployment uid this app build is pinned to.
 *
 * app-prod's server runtime looks up its own `VERCEL_GIT_COMMIT_SHA` in the
 * Vercel Edge Config `{sha → uid}` store written by the FEA-1484 producer
 * (`scripts/deploy/publish-api-deployment-pin.ts`). The resolved uid is handed
 * to the client (see `app-core-adapters.tsx`) and forwarded as the
 * `x-deployment-id` header on the cross-origin app→api fetch, so an in-flight
 * app build keeps reaching the api deployment it was paired with even after the
 * api-prod alias moves (rollback/hotfix).
 *
 * Fail-open by design: any gap — no SHA, no Edge Config connection (preview /
 * non-prod / local), a missing entry, an unexpected value, or a read error —
 * resolves to `null` so the client sends no header and hits the latest api. A
 * wrong pin is never produced; a missing pin only forfeits skew protection.
 */

// The producer stores the Vercel deployment uid (e.g. "dpl_…") as the value.
const deploymentUidSchema = z.string().min(1);

// Process-level memo of a *successful* resolution only. The {sha → uid} mapping
// is immutable for the life of a build, so it is safe to cache once found. A
// `null` is never cached: the producer upserts the pin in the same deploy that
// promotes this build, so an early request can legitimately precede the write
// and must be free to resolve on a later request.
let memoizedDeploymentPin: string | null = null;

export async function resolveApiDeploymentPin(): Promise<string | null> {
  if (memoizedDeploymentPin) {
    return memoizedDeploymentPin;
  }

  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (!sha) {
    return null;
  }

  // The Edge Config SDK throws when no connection string is configured; off
  // app-prod (preview / non-prod / local) there is none, so short-circuit.
  if (!process.env.EDGE_CONFIG) {
    return null;
  }

  try {
    const parsed = deploymentUidSchema.safeParse(await get(sha));
    if (!parsed.success) {
      return null;
    }
    memoizedDeploymentPin = parsed.data;
    return parsed.data;
  } catch (error) {
    log.warn(
      "Edge Config deployment-pin lookup failed; falling back to no-pin",
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return null;
  }
}
