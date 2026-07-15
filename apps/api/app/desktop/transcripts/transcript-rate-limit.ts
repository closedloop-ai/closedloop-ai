/**
 * Fixed-window rate limiter for the desktop transcript control-plane routes,
 * sharing the {@link FixedWindowRateLimiter} implementation with the
 * agent-sessions and analytics surfaces. It keys on a stable principal
 * (computeTargetId); serverless instances are ephemeral, so this only throttles
 * a hot single instance — abuse control, not a correctness gate.
 */
import { FixedWindowRateLimiter } from "@/lib/fixed-window-rate-limiter";

export class TranscriptRateLimiter extends FixedWindowRateLimiter {}

/** Shared limiter instance for the transcript routes. */
export const transcriptRateLimiter = new TranscriptRateLimiter();
