import {
  type ApiResult,
  failure,
  type JsonObject,
} from "@repo/api/src/types/common";
import type { GitHubBackfillResponse } from "@repo/api/src/types/github";
import { GitHubBackfillMode } from "@repo/api/src/types/github";
import { NextResponse } from "next/server";
import { z } from "zod";
import { githubBackfillService } from "@/app/integrations/github/backfill-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";

const GitHubBackfillRetryErrorCode = {
  Deferred: "GITHUB_BACKFILL_RETRY_DEFERRED",
} as const;

const backfillRequestSchema = z
  .object({
    mode: z.enum(GitHubBackfillMode).optional(),
    repositoryLimit: z.number().int().positive().max(10).optional(),
  })
  .strict();

export const POST = withAnyAuth<
  GitHubBackfillResponse,
  "/integrations/github/backfill"
>(async ({ user }, request) => {
  const { body, errorResponse: parseError } = await parseBody(
    request,
    backfillRequestSchema
  );
  if (parseError) {
    return parseError;
  }

  const mode = body.mode ?? GitHubBackfillMode.DryRun;
  const gate =
    mode === GitHubBackfillMode.Apply
      ? claimBackfillRetry(user.organizationId)
      : null;
  if (gate && !gate.claimed) {
    return backfillRetryDeferredResponse(gate.retryAfterSeconds);
  }

  try {
    const summary = await githubBackfillService.runPostConnectBackfill({
      organizationId: user.organizationId,
      approvedForVisibleWrites: mode === GitHubBackfillMode.Apply,
      repositoryLimit: body.repositoryLimit,
    });
    return successResponse({ summary });
  } finally {
    if (gate?.claimed) {
      releaseBackfillRetry(user.organizationId);
    }
  }
});

export const GET = withAnyAuth<
  GitHubBackfillResponse,
  "/integrations/github/backfill"
>(async ({ user }) => {
  try {
    const summary = await githubBackfillService.getLatestBackfillSummary(
      user.organizationId
    );
    return successResponse({ summary });
  } catch (error) {
    return errorResponse("Failed to summarize GitHub backfill", error);
  }
});

type BackfillRetryGateEntry = {
  inFlightUntil: number;
  cooldownUntil: number;
};

type BackfillRetryClaim =
  | { claimed: true }
  | { claimed: false; retryAfterSeconds: number };

const BACKFILL_RETRY_LEASE_MS = 20 * 60 * 1000;
const BACKFILL_RETRY_COOLDOWN_MS = 30 * 1000;
const BACKFILL_RETRY_MAX_GATE_ENTRIES = 500;
const backfillRetryGate = new Map<string, BackfillRetryGateEntry>();

function claimBackfillRetry(organizationId: string): BackfillRetryClaim {
  const now = Date.now();
  sweepBackfillRetryGate(now);
  const existing = backfillRetryGate.get(organizationId);
  const blockedUntil = Math.max(
    existing?.inFlightUntil ?? 0,
    existing?.cooldownUntil ?? 0
  );
  if (blockedUntil > now) {
    return {
      claimed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
    };
  }
  backfillRetryGate.set(organizationId, {
    inFlightUntil: now + BACKFILL_RETRY_LEASE_MS,
    cooldownUntil: now + BACKFILL_RETRY_COOLDOWN_MS,
  });
  evictBackfillRetryGateOverflow();
  return { claimed: true };
}

function releaseBackfillRetry(organizationId: string): void {
  backfillRetryGate.set(organizationId, {
    inFlightUntil: 0,
    cooldownUntil: Date.now() + BACKFILL_RETRY_COOLDOWN_MS,
  });
  evictBackfillRetryGateOverflow();
}

function backfillRetryDeferredResponse(
  retryAfterSeconds: number
): NextResponse<ApiResult<never>> {
  const details = {
    retryAfterSeconds,
  } satisfies JsonObject;
  return NextResponse.json(
    failure("GitHub backfill retry already running", {
      code: GitHubBackfillRetryErrorCode.Deferred,
      details,
    }),
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    }
  );
}

function sweepBackfillRetryGate(now: number): void {
  for (const [organizationId, entry] of backfillRetryGate) {
    if (entry.inFlightUntil <= now && entry.cooldownUntil <= now) {
      backfillRetryGate.delete(organizationId);
    }
  }
}

function evictBackfillRetryGateOverflow(): void {
  while (backfillRetryGate.size > BACKFILL_RETRY_MAX_GATE_ENTRIES) {
    const oldest = backfillRetryGate.keys().next().value;
    if (!oldest) {
      return;
    }
    backfillRetryGate.delete(oldest);
  }
}
