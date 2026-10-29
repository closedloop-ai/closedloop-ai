import type {
  GitHubClerkLinkClientFailureStage,
  GitHubClerkLinkSyncResponse,
} from "@repo/api/src/types/github";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { resolveGitHubUserIdentity } from "@/lib/github/github-user-credential";
import { FixedWindowEmissionThrottle } from "@/lib/observability/fixed-window-emission-throttle";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * PLN-1742 M3: materialize the caller's GitHub identity right after Clerk
 * verifies the external account. `resolveGitHubUserIdentity`'s Clerk path
 * runs the registry mirror, so a successful call leaves the token-less
 * `GitHubUserConnection` row in place — without this, a freshly linked user
 * reads as unconnected on every status surface until some later GitHub read
 * happens to resolve a credential for them.
 *
 * The denial comes straight back from the identity path. It used to be
 * re-read from Clerk here, because that path discarded the Clerk reason and
 * fell back to the stored connection — which for a first-time linker does not
 * exist, so every failure collapsed to `not_connected` and hid the
 * `insufficient_scope` grant the user had just approved. The M5-tail removal
 * of the stored fallback makes the identity path report the true reason
 * itself, so the second read is gone.
 *
 * Kept out of `service.ts` deliberately: that file is on the grandfathered
 * size list and this concern stands alone.
 */
export async function syncClerkLinkedIdentity(input: {
  organizationId: string;
  userId: string;
  /**
   * The caller has already been through the widen-scope consent round —
   * `GITHUB_CLERK_RELINK_ATTEMPTED_PARAM` on the request. Only the failure
   * record reads it; the returned verdict is the same either way.
   */
  relinkAttempted?: boolean;
  now?: Date;
  /**
   * ISS-12552: runs on the registry row's create, refresh or unlink-marker
   * transaction.
   */
  recordRegistryWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>;
}): Promise<GitHubClerkLinkSyncResponse> {
  const now = input.now ?? new Date();
  const result = await resolveGitHubUserIdentity({
    organizationId: input.organizationId,
    userId: input.userId,
    now,
    ...(input.recordRegistryWrite
      ? { recordRegistryWrite: input.recordRegistryWrite }
      : {}),
  }).catch((error: unknown) => {
    logLinkFailure(input, now, { error });
    throw error;
  });
  if (result.ok) {
    return { linked: true };
  }
  logLinkFailure(input, now, { reason: result.denial });
  return { linked: false, reason: result.denial };
}

/**
 * The only record a failed GitHub link leaves behind (ISS-10459). The route
 * returns the denial to the browser and `no-client-debug-logging` bans a
 * browser-side log on this path, so without this the failure ISS-10411 tried to
 * attribute is captured nowhere an alert can see.
 *
 * Scope is deliberately narrow: `organizationId` and `userId` are opaque
 * internal ids, `reason` is the closed `GitHubAccessDenialReason` set, and the
 * throw contributes only `parseError`'s message. No Clerk token, OAuth code, or
 * GitHub payload is in reach here — `resolveGitHubUserIdentity` keeps the
 * credential behind its own boundary and hands back a verdict. The logger's
 * `redactLogValue` replacer is the backstop on the serialized sinks.
 *
 * No `scheduleLogFlush` here, unlike `lib/auth/cron-secret.ts`: every
 * `withAnyAuth` branch ends in `logRequestCompleted`, which flushes, and this
 * record is buffered before it. `/cron/*` runs under no auth wrapper, which is
 * why that emitter owns its own flush.
 */
function logLinkFailure(
  scope: {
    organizationId: string;
    userId: string;
    relinkAttempted?: boolean;
  },
  now: Date,
  outcome: { reason: GitHubAccessDenialReason } | { error: unknown }
): void {
  if (isPreConsentScopeWidening(scope, outcome)) {
    return;
  }
  const decision = githubClerkLinkFailureThrottle.record(
    `${scope.organizationId}|${"reason" in outcome ? outcome.reason : THREW_KEY}`,
    undefined,
    now.getTime()
  );
  if (!decision.emit) {
    return;
  }
  const common = {
    event: GITHUB_CLERK_LINK_FAILED_EVENT,
    organizationId: scope.organizationId,
    userId: scope.userId,
    // Always present, including as `0`, so the monitor's log schema is stable —
    // the same convention `cron_secret_rejected` uses for the same field.
    suppressedSincePreviousEmission: decision.flushedSuppressedCount,
  };
  if ("reason" in outcome) {
    log.warn(GITHUB_CLERK_LINK_FAILED_EVENT, {
      ...common,
      reason: outcome.reason,
    });
    return;
  }
  log.error(GITHUB_CLERK_LINK_FAILED_EVENT, {
    ...common,
    error: parseError(outcome.error),
  });
}

export const GITHUB_CLERK_LINK_FAILED_EVENT = "github_clerk_link_failed";

/** Throttle-key part for the thrown path, which has no denial reason. */
const THREW_KEY = "threw";

/**
 * Any signed-in caller can drive this route, so emission is bounded per
 * (org, outcome) at this choke point — apps/api/AGENTS.md "Emission and Abuse
 * Control". The first failure per key per window always emits, so the
 * monitor's `> 0` still fires every window a link fails in; the rest are
 * folded into the next emission's `suppressedSincePreviousEmission`. Exported
 * so tests can reset it between cases.
 *
 * No `onFlush` and no `drainExpired`, deliberately. The monitor alerts on
 * presence, which the always-emitted first failure guarantees, so what an
 * eviction or a burst-then-quiet drops is only the suppressed count — already a
 * lower bound, and stated as one in the monitor's runbook. Eviction would also
 * need ~1,000 orgs failing inside one window against the 10,000-entry cap.
 */
export const githubClerkLinkFailureThrottle =
  new FixedWindowEmissionThrottle<undefined>();

/**
 * The one denial that is not yet a failed link. Clerk cannot widen an existing
 * grant silently, so the linking page answers a narrow-scope verified account
 * by sending the user through GitHub's consent screen once and calling this
 * route again (`clerk-github-link-client.tsx`, PLN-1742 M5) — the first
 * `insufficient_scope` is a step INSIDE a link that then succeeds, not a
 * customer who could not connect. Recorded, it would page #cl-status-prod on
 * every widened grant, and — because the throttle keys on
 * `(org, reason)` for a window longer than a consent round trip — it would
 * fold away the second, genuinely terminal `insufficient_scope` behind it.
 *
 * So the record waits for the caller to say it has been through consent. A
 * caller that omits the marker under-reports rather than paging on a link that
 * worked, which is the safe half for a version-skewed client.
 */
function isPreConsentScopeWidening(
  scope: { relinkAttempted?: boolean },
  outcome: { reason: GitHubAccessDenialReason } | { error: unknown }
): boolean {
  return (
    "reason" in outcome &&
    outcome.reason === GitHubAccessDenialReason.InsufficientScope &&
    scope.relinkAttempted !== true
  );
}

/**
 * ISS-11244: the browser's half of {@link GITHUB_CLERK_LINK_FAILED_EVENT}.
 *
 * The GitHub hand-off leg (`user.createExternalAccount`, `existing.destroy()`)
 * never reaches this API at all, so a refusal there was recorded nowhere: the
 * sync leg above emits, the hand-off leg emitted nothing, and
 * `no-client-debug-logging` correctly forbids the browser from logging it
 * itself. That is why the failure reported on 2026-09-26 could not be named
 * from outside the reporter's browser.
 *
 * Same event name, same throttle and the same narrow scope as the server-side
 * record, so one monitor sees both halves and triage does not need a second
 * query. `clerkErrorCode` is a Clerk vocabulary string, not a credential or a
 * token; `source` is what separates the halves, including when a server 5xx makes
 * both of them fire for one failure.
 *
 * `stage` is always present and is what makes a report actionable on its own:
 * three of the four client-observed paths resolve WITHOUT an error of any kind,
 * so they would otherwise all arrive as a bare "a browser failed". `apiErrorCode`
 * and `apiErrorStatus` come from the shared client's `ApiError`, which carries no
 * `errors[]` array — before them a sync-leg deadline, an expired session and a
 * refused POST were one indistinguishable codeless record, which is the leg this
 * ticket most needed named.
 *
 * Emits `warn` rather than `error`: a browser-reported refusal is a customer who
 * could not connect, which is the same severity the denial half already carries.
 *
 * THE KEY DELIBERATELY EXCLUDES THE CODE. The sync leg can safely key on its
 * reason because that is the closed `GitHubAccessDenialReason` set; this half's
 * code is a string a browser chose, so keying on it would hand any signed-in
 * caller a fresh key — and therefore an unthrottled emission — on every request,
 * which is the amplification `apps/api/AGENTS.md` "Emission and Abuse Control"
 * exists to stop. Keyed per (org, source) the bound holds whatever is sent, and
 * because it holds, the number of distinct codes that can reach the monitor's
 * facet is bounded too. The cost is that a second DIFFERENT code for one org in
 * one window folds into the suppressed count rather than emitting; the monitor
 * alerts on presence, so that was already a lower bound.
 */
export function recordClerkLinkClientFailure(input: {
  organizationId: string;
  userId: string;
  stage: GitHubClerkLinkClientFailureStage;
  clerkErrorCode?: string;
  apiErrorCode?: string;
  apiErrorStatus?: number;
  now?: Date;
}): void {
  const now = input.now ?? new Date();
  const decision = githubClerkLinkFailureThrottle.record(
    `${input.organizationId}|${CLIENT_SOURCE}`,
    undefined,
    now.getTime()
  );
  if (!decision.emit) {
    return;
  }
  log.warn(GITHUB_CLERK_LINK_FAILED_EVENT, {
    event: GITHUB_CLERK_LINK_FAILED_EVENT,
    organizationId: input.organizationId,
    userId: input.userId,
    source: CLIENT_SOURCE,
    stage: input.stage,
    // Omitted rather than `null` when the report carried no code, so each
    // monitor facet counts only values something actually reported.
    ...(input.clerkErrorCode
      ? { clerkErrorCode: normalizeClerkErrorCode(input.clerkErrorCode) }
      : {}),
    ...(input.apiErrorCode
      ? { apiErrorCode: normalizeClerkErrorCode(input.apiErrorCode) }
      : {}),
    ...(input.apiErrorStatus === undefined
      ? {}
      : { apiErrorStatus: input.apiErrorStatus }),
    suppressedSincePreviousEmission: decision.flushedSuppressedCount,
  });
}

/**
 * A browser-supplied code reaches a log attribute a monitor facets on, so it is
 * held to the same shape Clerk and the shared API client both already use — a lowercase snake_case identifier — before it is
 * emitted. Anything else becomes {@link UNRECOGNIZED_CLERK_ERROR_CODE} rather
 * than being refused at the route: a report this API cannot otherwise make is
 * worth more than the exact spelling of a code that was not Clerk's, and
 * refusing it would return the browser-only observation to the silence this
 * whole path exists to end.
 */
function normalizeClerkErrorCode(code: string): string {
  return CLERK_ERROR_CODE_SHAPE.test(code)
    ? code
    : UNRECOGNIZED_CLERK_ERROR_CODE;
}

/** Clerk error codes, and `ApiError.code`, are lowercase snake_case identifiers. */
const CLERK_ERROR_CODE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/** Stands in for a reported code that was not Clerk-shaped. */
const UNRECOGNIZED_CLERK_ERROR_CODE = "unrecognized";

/** Which half of the link emitted: this browser-reported one, not the sync leg. */
const CLIENT_SOURCE = "client";
