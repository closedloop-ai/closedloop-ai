"use client";

/**
 * @file guided-onboarding-event-support.ts
 * @description Which transition events the API this client is talking to has
 * REFUSED OUTRIGHT, so a browser one deploy ahead of the API stops re-posting a
 * command that build can never accept (PLN-1875 Step 9).
 *
 * `defer_tour` is new on the wire. `apps/app` and `apps/api` are separate Vercel
 * projects, so a browser holding this build can reach an API that predates it —
 * whose `onboardingEventInputSchema` rejects the event before any handler runs,
 * answering 400. The client's own `onError` then invalidates and re-reads the
 * UNCHANGED run, which leaves it parked on `dashboard_tour`, so the tour arms
 * again on the next visit and defers again, and again: exactly the trap Step 9
 * exists to close, re-entered through version skew. The repo's cross-repo rule
 * is that an unknown or rejected contract value degrades to a safe default and
 * never to a retry loop, and the safe default here is to post nothing and leave
 * the tour owed — never `finish_tour`, which would retire a tour the reader was
 * never shown.
 *
 * A 400 FROM THIS ENDPOINT IS ALWAYS WORTH LATCHING, both ways it is produced. A
 * schema refusal is the skew above and is permanent until the API rolls forward.
 * The other is the server's own `unreachable_state` verdict, and the command the
 * next visit would compose is the same shape against the same run — so retrying
 * it buys a second identical 400. Neither is a transport failure: a 409, a 5xx,
 * or a dropped connection says nothing about whether the command is acceptable,
 * and none of them latches.
 *
 * SCOPE, stated because it bounds the fix. This is a browser-session answer, not
 * a durable one: a reload re-probes, which is the correct behaviour when the
 * thing being probed is a server that may have rolled forward mid-session. So a
 * skewed client posts at most one refused command per page load rather than one
 * per dashboard visit. The set is keyed by {@link OnboardingEvent}, a closed
 * union, so it cannot grow past that union's size no matter what a server
 * answers — it takes no keys from external input.
 */

import type { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import { ApiError } from "../../shared/api/api-error";

/** The lowest status this endpoint uses to refuse a command outright. */
const COMMAND_REFUSED_STATUS = 400;

const refusedEvents = new Set<OnboardingEvent>();

/**
 * Whether `error` is the API refusing the command itself, rather than failing to
 * carry it. Keyed on the exact status the transition route answers for a payload
 * it will not accept; a 409 is a stale revision the client reconciles from, and
 * anything else is transport.
 */
export function isGuidedOnboardingCommandRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === COMMAND_REFUSED_STATUS;
}

/** Record that this API build will not accept `event`. */
export function markGuidedOnboardingEventRefused(event: OnboardingEvent): void {
  refusedEvents.add(event);
}

/** Whether posting `event` again in this browser session is known to be futile. */
export function isGuidedOnboardingEventRefused(
  event: OnboardingEvent
): boolean {
  return refusedEvents.has(event);
}

/**
 * Drop every recorded refusal.
 *
 * Module-level state outlives a suite's own fixtures, so a test that drives a
 * refusal primes every later one in the same worker — the case then passes in
 * file order and fails run alone. Suites that touch this call it in `beforeEach`.
 */
export function clearGuidedOnboardingEventRefusals(): void {
  refusedEvents.clear();
}

/**
 * Whether `error` left this command's fate UNDECIDED — the transport failed, so
 * nothing about the command was answered.
 *
 * Deliberately wider than {@link isGuidedOnboardingCommandRefusal} and not its
 * inverse. A 400 refusal, a 409 stale revision and a 401 are all the server
 * answering ABOUT the command, and a caller that treats one as a lost write
 * keeps a position the server has already ruled on. Only a 5xx, or a request
 * that never got an answer at all — `createApiClient` mints a network failure
 * or a client deadline as an `ApiError` at status 0 — leaves the client
 * entitled to assume nothing was written.
 *
 * A non-`ApiError` is not one either: the only one this mutation throws is the
 * client-side machine's own rejection, which is the most determinate answer
 * there is.
 */
export function isGuidedOnboardingTransportFailure(error: unknown): boolean {
  return error instanceof ApiError && !error.isClientError();
}
