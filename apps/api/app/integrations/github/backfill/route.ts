import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  type ApiResult,
  failure,
  type JsonObject,
} from "@repo/api/src/types/common";
import type {
  GitHubBackfillAcceptedResponse,
  GitHubBackfillResponse,
} from "@repo/api/src/types/github";
import {
  GitHubBackfillMode,
  GitHubBackfillRetryErrorCode,
  GitHubBackfillStatus,
} from "@repo/api/src/types/github";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { GitHubBackfillStart } from "@/app/integrations/github/backfill-service";
import { githubBackfillService } from "@/app/integrations/github/backfill-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  recordNoOpUnlessRecorded,
  recordOrganizationWrite,
} from "@/lib/organization-write-receipt";
import {
  acceptedResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

/**
 * Apply mode hands the sweep to `waitUntil` rather than awaiting it (ISS-7408),
 * but the platform still bounds that lane by the function's own ceiling, so the
 * declaration stays load-bearing: without it the background run is killed at
 * the default mid-sweep. What changed is who waits — the response returns in
 * claim latency instead of the 90s-180s the awaited sweep used to cost on a
 * route a customer hits while onboarding.
 */
export const maxDuration = 300;

const backfillRequestSchema = z
  .object({
    mode: z.enum(GitHubBackfillMode).optional(),
    repositoryLimit: z.number().int().positive().max(10).optional(),
  })
  .strict();

export const POST = withAnyAuth<
  GitHubBackfillAcceptedResponse | GitHubBackfillResponse,
  "/integrations/github/backfill"
>(
  withOperationReceipts<
    GitHubBackfillAcceptedResponse | GitHubBackfillResponse,
    "/integrations/github/backfill"
  >(
    OperationKind.OrganizationWrite,
    async ({ user }, request, _params, receipts) => {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        backfillRequestSchema
      );
      if (parseError) {
        return parseError;
      }

      const mode = body.mode ?? GitHubBackfillMode.DryRun;
      const { organizationId } = user;

      // Dry run stays on the request path. It writes nothing, and the diff it
      // computes IS its product — a caller handed a 202 would have no way to read
      // the preview it asked for. It is a manual diagnostic with nobody onboarding
      // behind it, which is exactly what Apply below is not.
      if (mode !== GitHubBackfillMode.Apply) {
        const summary = await githubBackfillService.runPostConnectBackfill({
          organizationId,
          approvedForVisibleWrites: false,
          repositoryLimit: body.repositoryLimit,
        });
        return successResponse({ summary });
      }

      const gate = claimBackfillRetry(organizationId);
      if (!gate.claimed) {
        return backfillRetryDeferredResponse(gate.retryAfterSeconds);
      }

      // The DURABLE claim is awaited here, on the request path, and only the sweep
      // goes to `waitUntil` (ISS-7408). Handing the claim to the background lane
      // too would let this 202 outrun the gate write, and a status poll that beat
      // it would read the previous run's terminal status and stop polling for good
      // — the exact "still arriving read as settled" failure this route exists to
      // remove. By the time the response is written, the next read reports running.
      let start: GitHubBackfillStart;
      try {
        // ISS-12552: the receipt commits with the lease claim, so
        // it records the request; the sweep's own writes come later and carry
        // none. A dry run passes no callback and records none.
        start = await githubBackfillService.startPostConnectBackfill(
          {
            organizationId,
            approvedForVisibleWrites: true,
            repositoryLimit: body.repositoryLimit,
          },
          recordOrganizationWrite(receipts)
        );
      } catch (error) {
        // The in-memory claim above holds a 20-minute lease, and nothing else
        // releases it on this path: a transient failure in the durable claim would
        // otherwise leave this warm instance 429-ing the org for the rest of it,
        // long after the condition cleared (#5689 review).
        releaseBackfillRetry(organizationId);
        return errorResponse("Failed to start GitHub backfill", error);
      }

      if (!start.claimed) {
        // Another instance already holds the durable lease, so a run IS in flight.
        // The caller asked for a backfill and is getting one; reporting a failure
        // would be false. Release only this instance's in-memory claim.
        releaseBackfillRetry(organizationId);
        await recordNoOpUnlessRecorded(receipts);
        return acceptedResponse(
          withOperationReceipt(runningResponse(), receipts)
        );
      }

      waitUntil(
        start.completion
          .catch((error: unknown) => {
            // Nothing is left to return this to, so the failure reaches an operator
            // here or nowhere. Whatever the run wrote before failing stays readable
            // through the persisted summary the GET below serves.
            log.error("github.backfill.background_run_failed", {
              error,
              organizationId,
            });
          })
          .finally(() => releaseBackfillRetry(organizationId))
      );

      return acceptedResponse(
        withOperationReceipt(runningResponse(), receipts)
      );
    }
  )
);

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

function runningResponse(): GitHubBackfillAcceptedResponse {
  return { accepted: true, status: GitHubBackfillStatus.Running };
}
