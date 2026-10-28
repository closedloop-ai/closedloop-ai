import "server-only";

import type { PinnedFeatureFlags } from "@repo/analytics/feature-flag-value";
import {
  PINNED_FEATURE_FLAGS_ROUTE_PATH,
  pinnedFeatureFlagsResponseSchema,
} from "@repo/api/src/types/feature-flag-snapshot";
import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { resolveApiOrigin } from "@/lib/api-origin";

/**
 * ISS-12048: the production flag snapshot a `$vibe` preview environment pins,
 * read once per server render so the browser's first frame already shows the
 * pinned values rather than PostHog's live ones.
 *
 * Only in a Vercel PREVIEW deployment, so production and stage renders never
 * make the request. The API is the authority on whether a snapshot is active
 * (it answers `null` unless its own schema is a preview schema that stores one),
 * and the read goes to the same server-side API origin the shell's other
 * server reads use. Fail-open: any failure pins nothing and flags stay live.
 */
export async function resolvePinnedFeatureFlags(
  vercelEnv: string | undefined = process.env.VERCEL_ENV
): Promise<PinnedFeatureFlags | null> {
  if (vercelEnv !== PREVIEW_VERCEL_ENV) {
    return null;
  }
  try {
    const { getToken } = await auth();
    const token = await getToken();
    if (!token) {
      return null;
    }
    const response = await fetch(
      `${resolveApiOrigin()}${PINNED_FEATURE_FLAGS_ROUTE_PATH}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
    );
    if (!response.ok) {
      return null;
    }
    const parsed = pinnedEnvelopeSchema.safeParse(await response.json());
    return parsed.success ? (parsed.data.data.snapshot?.flags ?? null) : null;
  } catch (error) {
    log.warn("feature_flag_snapshot.pinned_read_failed", {
      error: parseError(error),
    });
    return null;
  }
}

const PREVIEW_VERCEL_ENV = "preview";

const pinnedEnvelopeSchema = z.object({
  success: z.literal(true),
  data: pinnedFeatureFlagsResponseSchema,
});
