import type {
  BranchPageDetail,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { chartColor } from "@repo/design-system/components/ui/chart-colors";

/**
 * Shared actor → color/label domain for the Branch timeline (E1) and swimlane
 * (E4). A pure, surface-agnostic module (no React) so E1 segments and E4 lanes
 * resolve the SAME color for the SAME actor — the parent builds one domain and
 * injects it into both, and even when each builds its own the deterministic
 * ordering guarantees identical colors for an identical actor set.
 *
 * Colors come from the design-system categorical palette (`chartColor` →
 * `--chart-1..5`, cycling modulo); this module never defines its own palette.
 * `null`/empty owners coalesce to a single "unattributed" key+label — the v1
 * degraded state (owner attribution is a soft FEA-1899 dependency).
 */
export type BranchActorKey = string;

/** Internal sentinel for a null/absent owner — never a real owner string. */
export const UNATTRIBUTED_ACTOR_KEY = "__unattributed__";

/** v1 display label for the unattributed sentinel (one source for E1 + E4). */
export const UNATTRIBUTED_ACTOR_LABEL = "unattributed";

export type BranchActorColorDomain = {
  /** Distinct actor keys, deterministically ordered: unattributed last, else alphabetical. */
  readonly ordered: readonly BranchActorKey[];
  /** Categorical color for an owner (null/empty → the unattributed color). */
  colorFor(owner: string | null): string;
  /** Display label for an owner (verbatim, or "unattributed"). */
  labelFor(owner: string | null): string;
  /** Whether an owner coalesces to the unattributed sentinel. */
  isUnattributed(owner: string | null): boolean;
};

function keyFor(owner: string | null): BranchActorKey {
  return owner == null || owner === "" ? UNATTRIBUTED_ACTOR_KEY : owner;
}

/**
 * Build a deterministic actor color domain. `ordered` sorts the unattributed
 * sentinel last and everything else alphabetically, so the same actor set yields
 * the same colors regardless of input iteration order (prevents E1↔E4 drift).
 */
export function buildActorColorDomain(
  actors: readonly (string | null)[]
): BranchActorColorDomain {
  const keys = new Set<BranchActorKey>();
  for (const actor of actors) {
    keys.add(keyFor(actor));
  }
  const ordered = [...keys].sort((a, b) => {
    if (a === UNATTRIBUTED_ACTOR_KEY) {
      return 1;
    }
    if (b === UNATTRIBUTED_ACTOR_KEY) {
      return -1;
    }
    return a.localeCompare(b);
  });
  const indexByKey = new Map(ordered.map((key, index) => [key, index]));

  return {
    ordered,
    colorFor(owner) {
      return chartColor(indexByKey.get(keyFor(owner)) ?? 0);
    },
    labelFor(owner) {
      const key = keyFor(owner);
      return key === UNATTRIBUTED_ACTOR_KEY ? UNATTRIBUTED_ACTOR_LABEL : key;
    },
    isUnattributed(owner) {
      return keyFor(owner) === UNATTRIBUTED_ACTOR_KEY;
    },
  };
}

/** Distinct owners across `hourBuckets[].byActor` ∪ top-level `byActor`. */
export function deriveActorsFromUsage(
  usage: BranchUsageSummary
): (string | null)[] {
  const out: (string | null)[] = [];
  for (const bucket of usage.hourBuckets) {
    for (const actor of bucket.byActor) {
      out.push(actor.owner);
    }
  }
  for (const actor of usage.byActor) {
    out.push(actor.owner);
  }
  return out;
}

/**
 * Actor per session for E4 lanes. `BranchSession` carries no `owner`, so the
 * actor comes from the session's `sessionstart.actor.name` in the merged trace,
 * falling back to `harness` (so CI vs local separate) and finally to
 * unattributed when the harness is empty.
 */
export function deriveActorsFromSessions(
  detail: BranchPageDetail
): (string | null)[] {
  const actorBySession = new Map<string, string | null>();
  for (const item of detail.mergedTrace) {
    if (item.type === "sessionstart") {
      actorBySession.set(item.sessionId, item.actor.name);
    }
  }
  return detail.sessions.map((session) => {
    const captured = actorBySession.get(session.sessionId);
    if (captured != null && captured !== "") {
      return captured;
    }
    return session.harness === "" ? null : session.harness;
  });
}
