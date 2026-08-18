import type { RoutinesListResponse } from "@repo/api/src/types/routines";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { successResponse } from "@/lib/route-utils";

/**
 * `GET /routines` (PRD-566 / FEA-4348).
 *
 * Shipped directly (no feature-flag gate) — this repo is not adding new PostHog
 * feature flags (AGENTS.md). Returns the (currently empty) cloud routines list;
 * Routines are authored/run desktop-locally today, so cloud-side persistence is
 * a follow-up. Auth is still required (`withAnyAuth`).
 */
export const GET = withAnyAuth<RoutinesListResponse, "/routines">(() =>
  Promise.resolve(successResponse<RoutinesListResponse>({ routines: [] }))
);
