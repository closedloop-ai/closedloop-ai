import { log } from "@repo/observability/log";
import type { OrgAdminDenialReason } from "@/lib/auth/org-admin-denial";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";

export const ORG_ADMIN_GATE_DENIED_EVENT = "org_admin_gate_denied";

/**
 * Which admin gate refused. The org-policy-WRITE gates only — see the scope
 * note on {@link ORG_ADMIN_GATE_DENIED_EVENT}.
 *
 * `route`/`method` alone would claim route scope for gate scope: the
 * organization route has more than one 403 exit, so without a discriminator a query
 * that saw no line could not tell "no denial" from "a gate that does not
 * report". Values are unique across ALL routes, not just within one, because
 * this is also a throttle key part.
 */
export const OrgAdminGate = {
  /** `PUT /organizations/[id]` — an admin-only org field was in the body. */
  AdminOnlyField: "admin_only_field",
  /** `PUT /organizations/[id]` — the body changed the org slug. */
  SlugChange: "slug_change",
  /** `PUT /settings/frustration`. */
  FrustrationSetting: "frustration_setting",
} as const;
export type OrgAdminGate = (typeof OrgAdminGate)[keyof typeof OrgAdminGate];

type GateSite = {
  method: "PUT" | "DELETE";
  route: string;
};

/**
 * Where each gate lives. Derived from the gate rather than passed in, so a call
 * site cannot label its own line with someone else's route, and the `Record`
 * is exhaustive so a new gate fails `tsc` until it is placed.
 */
const ORG_ADMIN_GATE_SITES: Record<OrgAdminGate, GateSite> = {
  [OrgAdminGate.AdminOnlyField]: {
    method: "PUT",
    route: "/organizations/[id]",
  },
  [OrgAdminGate.SlugChange]: { method: "PUT", route: "/organizations/[id]" },
  [OrgAdminGate.FrustrationSetting]: {
    method: "PUT",
    route: "/settings/frustration",
  },
};

/** Composite-key delimiter. No key part is free text that could contain it. */
const KEY_DELIMITER = "|";

/**
 * The bound on emission: what is stable about a denial, and nothing a caller
 * can vary. `clerkUserId` and `fields` are deliberately OUT of the key —
 * including either would make the keyspace churn with membership or with the
 * body the caller chose to send, so cycling them would evict every entry before
 * it was reused and the emission stream would never close (the hole #5209
 * found). Both still ride on the emitted line; they just do not buy budget.
 *
 * `gate` is globally unique, so it carries route scope into the key without
 * `route` needing to be a separate part.
 */
type OrgAdminDenialScope = {
  clerkOrgId: string;
  gate: OrgAdminGate;
  reason: OrgAdminDenialReason;
};

export type OrgAdminDenialContext = OrgAdminDenialScope & {
  clerkUserId: string;
  /**
   * Field NAMES the refused body named, where the gate knows them. Names only —
   * a denied value is unaccepted caller input. Omitted (not `null`) by gates
   * whose refusal is not field-scoped.
   */
  fields?: readonly string[];
};

/**
 * WHY THIS IS THROTTLED. `apps/api/AGENTS.md` ("Emission and Abuse Control"):
 * an alert emitted per denied request is an amplification vector whenever an
 * authenticated caller can drive the path. Any authenticated member can drive
 * one denial per request at every one of these gates — `withAuth` bounds
 * neither request count nor emission — so an unbounded `log.warn` here is a log
 * stream a member can open at will, and now one that reaches a monitor.
 *
 * `FixedWindowEmissionThrottle` supplies both bounds the rule needs: at most
 * one line per (org, gate, reason) per window plus one aggregate rollup, and a
 * hard max-entry LRU cap on the keyspace, since an in-memory map keyed on
 * caller-reachable input would just trade a log leak for a memory leak (root
 * `AGENTS.md`).
 *
 * WHAT THE SUPPRESSED COUNT IS WORTH (#5508 review, whitlockk). A suppressed count
 * is materialised by an event, never by a clock. Three events can do it here:
 * the next occurrence on the SAME key rolling its window over, an LRU eviction,
 * and {@link drainOrgAdminDenials} — which `withAuth`'s `finally` runs on every
 * authenticated request, so a burst followed by quiet AT THAT GATE is flushed
 * by the next request through any gated route rather than waiting for the
 * attacker to come back. What remains, and is not fixable in process memory: an
 * instance that takes the burst and then serves nothing at all before freezing
 * still loses its terminal window. `sum(occurrences)` is consequently a
 * lower-bounded eventual total, not a live exact one, and a count-over-window
 * monitor on it should alert on a floor being crossed rather than treat the
 * number as the true denial volume. Making it exact needs durable state or
 * external aggregation, which is out of this module's scope.
 *
 * Process-local and best-effort per serverless instance. Exported so tests can
 * reset it between cases; production code must not reach into it.
 */
export const orgAdminDenialThrottle =
  new FixedWindowEmissionThrottle<OrgAdminDenialScope>({
    onFlush: (scope, suppressedCount, cause) =>
      emitAggregate(scope, suppressedCount, cause),
  });

/**
 * Emit one admin-denial record, bounded. ONE emitter for all four routes, so
 * they cannot drift into reporting different names or different shapes — the
 * drift ISS-7350 exists to prevent.
 *
 * Never throws: this runs on the refusal path, and a failure to REPORT a denial
 * must not also change whether the denial happened.
 */
export function reportOrgAdminDenial(context: OrgAdminDenialContext): void {
  const scope: OrgAdminDenialScope = {
    clerkOrgId: context.clerkOrgId,
    gate: context.gate,
    reason: context.reason,
  };

  try {
    const decision = orgAdminDenialThrottle.record(
      buildKey(scope),
      scope,
      Date.now()
    );
    if (decision.flushedSuppressedCount > 0) {
      emitAggregate(
        scope,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (!decision.emit) {
      return;
    }
    log.warn(ORG_ADMIN_GATE_DENIED_EVENT, {
      ...scope,
      ...ORG_ADMIN_GATE_SITES[scope.gate],
      clerkUserId: context.clerkUserId,
      ...(context.fields === undefined ? {} : { fields: context.fields }),
      occurrences: 1,
    });
  } catch (error) {
    log.warn("[org-admin-gate] Failed to report an admin denial", {
      event: ORG_ADMIN_GATE_DENIED_EVENT,
      clerkOrgId: context.clerkOrgId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Flush the rollup for any gate whose window has closed with denials still
 * pending, instead of holding them until that exact key is hit again.
 *
 * Wired into `withAuth`'s `finally`, which already runs `logRequestCompleted`
 * on every authenticated request — a terminal path that exists, rather than a
 * timer a frozen serverless instance would never fire. O(1) when nothing has
 * expired, so it costs nothing on the hot path.
 *
 * Never throws: this is reporting, and a failure to report must not disturb a
 * response that has already been produced.
 */
export function drainOrgAdminDenials(now: number = Date.now()): void {
  try {
    orgAdminDenialThrottle.drainExpired(now);
  } catch (error) {
    log.warn("[org-admin-gate] Failed to drain suppressed admin denials", {
      event: ORG_ADMIN_GATE_DENIED_EVENT,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildKey(scope: OrgAdminDenialScope): string {
  return [scope.clerkOrgId, scope.gate, scope.reason].join(KEY_DELIMITER);
}

/**
 * The rollup for denials a closed window suppressed, emitted as ONE line
 * carrying their total. It omits `clerkUserId` and `fields` — the suppressed
 * denials did not necessarily share either — and carries `aggregated` so a
 * query can tell a rollup from a first occurrence.
 *
 * `flushedBy` is not decoration: a rollup arriving by `eviction` says the
 * keyspace cap was hit, which is a different operational story from a quiet key
 * being drained by `expiry` or a busy one rolling over by `window`.
 */
function emitAggregate(
  scope: OrgAdminDenialScope,
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(ORG_ADMIN_GATE_DENIED_EVENT, {
    ...scope,
    ...ORG_ADMIN_GATE_SITES[scope.gate],
    occurrences,
    aggregated: true,
    flushedBy,
  });
}
