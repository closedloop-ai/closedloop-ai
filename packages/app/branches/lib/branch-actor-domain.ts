import type {
  BranchPageDetail,
  BranchSession,
} from "@repo/api/src/types/branch";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import {
  CHART_COLOR_PAIR_TOKEN_INDEXES,
  CHART_COLOR_TOKENS,
  type ChartColorPair,
  chartColorPair,
  chartColorPairForTokenIndex,
} from "@repo/design-system/components/ui/chart-colors";

/**
 * Shared actor → color/label domain for the Branch timeline (E1) and swimlane
 * (E4). A pure, surface-agnostic module (no React) so E1 segments and E4 lanes
 * resolve the SAME color pair for the SAME actor — the parent builds one domain and
 * injects it into both, and even when each builds its own the deterministic
 * ordering guarantees identical colors for an identical actor set.
 *
 * Colors come from the design-system categorical palette (`chartColorPair` →
 * `--chart-1..10`, cycling modulo); this module never defines its own palette.
 * `null`/empty owners coalesce to a single "unattributed" key+label — the v1
 * degraded state (owner attribution is a soft FEA-1899 dependency).
 *
 * FEA-3576 — E1 (per-user cost timeline) and E4 (per-actor swimlane) now segment
 * by DIFFERENT entities (a human user vs a session/model actor), so a shared
 * color between them would falsely read as "same entity." A domain can be built
 * with a `paletteOffset` that shifts additional attributed colors into a
 * distinct band of the palette, while the primary actor stays pinned to the
 * first blue pair. The "unattributed" sentinel is exempt — it means the same
 * thing in both charts, so it keeps one shared color regardless of offset.
 */
export type BranchActorKey = string;

/** Internal sentinel for a null/absent owner — never a real owner string. */
export const UNATTRIBUTED_ACTOR_KEY = "__unattributed__";

/** v1 display label for the unattributed sentinel (one source for E1 + E4). */
export const UNATTRIBUTED_ACTOR_LABEL = "unattributed";

/**
 * Palette offset (FEA-3576) for the E4 session swimlane's actor domain, so its
 * colors sit in a distinct band from the E1 per-user timeline (which uses the
 * default offset 0). Half the attributed palette (9 slots: chart-1..9, with
 * chart-10 reserved for unattributed) maximally separates the two bands for the
 * common small-cardinality case, so a user in E1 and an unrelated actor in E4
 * don't land on the same color and falsely read as linked.
 */
export const ACTOR_SWIMLANE_PALETTE_OFFSET = 5;

export const BranchActorTurnSide = {
  Human: "human",
  Agent: "agent",
} as const;
export type BranchActorTurnSide =
  (typeof BranchActorTurnSide)[keyof typeof BranchActorTurnSide];

export type BranchActorColorDomain = {
  /** Distinct actor keys: explicit primary first, unattributed last, rest alphabetical. */
  readonly ordered: readonly BranchActorKey[];
  /**
   * Representative/base categorical color for an owner. Prefer `colorForTurn`
   * when a mark knows whether it represents human or agent-side activity.
   */
  colorFor(owner: string | null, canonicalIdentity?: string | null): string;
  /** Human/agent color pair for an owner (null/empty → the fallback pair). */
  colorPairFor(
    owner: string | null,
    canonicalIdentity?: string | null
  ): ChartColorPair;
  /** Side-aware actor color for trace turns, activity bars, and swimlane lanes. */
  colorForTurn(
    owner: string | null,
    side: BranchActorTurnSide,
    canonicalIdentity?: string | null
  ): string;
  /** Display label for an owner (verbatim, or "unattributed"). */
  labelFor(owner: string | null): string;
  /** Whether an owner coalesces to the unattributed sentinel. */
  isUnattributed(owner: string | null): boolean;
};

function keyFor(owner: string | null): BranchActorKey {
  return owner == null || owner === "" ? UNATTRIBUTED_ACTOR_KEY : owner;
}

/** Options for {@link buildActorColorDomain}. */
export type BranchActorColorDomainOptions = {
  /**
   * Shift this domain's attributed (non-unattributed) colors by N palette slots,
   * so two domains built over DIFFERENT entity kinds (E1 users vs E4 actors) draw
   * from distinct color bands and don't falsely read as the same entity. Default
   * 0 (no shift) preserves the original single-domain coloring. The unattributed
   * sentinel is never shifted — it shares one color across offsets on purpose.
   */
  paletteOffset?: number;
  /**
   * Actor/user that should receive the first color pair. Branch detail derives
   * this from the primary linked session (`BranchSession.isPrimary`) so the
   * main branch actor is visually stable even when additional actors vary.
   */
  primaryActor?: string | null;
};

/**
 * Build a deterministic actor color domain. `ordered` places the optional
 * primary actor first, sorts the unattributed sentinel last, and everything else
 * alphabetically, so the same actor set yields the same colors regardless of
 * input iteration order (prevents E1↔E4 drift).
 *
 * `paletteOffset` (FEA-3576) shifts additional attributed colors into a distinct
 * palette band so the user timeline (E1) and actor swimlane (E4) — which now
 * segment by different entity kinds — don't share a color language beyond the
 * primary branch actor. The unattributed sentinel is pinned to one shared color
 * (the last palette slot) regardless of offset, since "unattributed" means the
 * same thing in both charts.
 */
export function buildActorColorDomain(
  actors: readonly (string | null)[],
  { paletteOffset = 0, primaryActor }: BranchActorColorDomainOptions = {}
): BranchActorColorDomain {
  const keys = new Set<BranchActorKey>();
  for (const actor of actors) {
    keys.add(keyFor(actor));
  }
  const primaryKey =
    primaryActor == null || primaryActor === "" ? null : keyFor(primaryActor);
  if (primaryKey != null && primaryKey !== UNATTRIBUTED_ACTOR_KEY) {
    keys.add(primaryKey);
  }
  const sorted = [...keys].sort((a, b) => {
    if (a === UNATTRIBUTED_ACTOR_KEY) {
      return 1;
    }
    if (b === UNATTRIBUTED_ACTOR_KEY) {
      return -1;
    }
    return a.localeCompare(b);
  });
  const ordered =
    primaryKey == null || primaryKey === UNATTRIBUTED_ACTOR_KEY
      ? sorted
      : [primaryKey, ...sorted.filter((key) => key !== primaryKey)];
  // Index only the attributed keys (unattributed gets a pinned shared color), so
  // the offset shifts additional actors/users without disturbing the primary
  // actor or the shared sentinel.
  const indexByKey = new Map<BranchActorKey, number>();
  let attributedIndex = 0;
  for (const key of ordered) {
    if (key === UNATTRIBUTED_ACTOR_KEY) {
      continue;
    }
    indexByKey.set(key, attributedIndex);
    attributedIndex += 1;
  }
  // Pin unattributed to the LAST palette slot, shared across offsets — a stable
  // "no owner" color that never collides with the attributed band's start.
  const unattributedColorPair = chartColorPairForTokenIndex(
    CHART_COLOR_TOKENS.length - 1
  );
  const colorPairForOwner = (
    owner: string | null,
    canonicalIdentity?: string | null
  ): ChartColorPair => {
    const key = keyFor(canonicalIdentity ?? owner);
    if (key === UNATTRIBUTED_ACTOR_KEY) {
      return unattributedColorPair;
    }
    const index = indexByKey.get(key);
    if (index == null) {
      return unattributedColorPair;
    }
    const additionalPairCount = Math.max(
      1,
      CHART_COLOR_PAIR_TOKEN_INDEXES.length - 1
    );
    const shiftedAdditionalIndex =
      ((index - 1 + paletteOffset) % additionalPairCount) + 1;
    const pairIndex = index === 0 ? 0 : shiftedAdditionalIndex;
    return chartColorPair(pairIndex);
  };

  return {
    ordered,
    colorFor(owner, canonicalIdentity) {
      return colorPairForOwner(owner, canonicalIdentity).base;
    },
    colorPairFor(owner, canonicalIdentity) {
      return colorPairForOwner(owner, canonicalIdentity);
    },
    colorForTurn(owner, side, canonicalIdentity) {
      const pair = colorPairForOwner(owner, canonicalIdentity);
      return side === BranchActorTurnSide.Human ? pair.soft : pair.strong;
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

/** Primary session selected by branch membership, falling back deterministically. */
function derivePrimarySession(
  detail: BranchPageDetail
): BranchSession | undefined {
  return (
    detail.sessions.find((session) => session.isPrimary) ?? detail.sessions[0]
  );
}

/** A session's actor: captured `sessionstart` name, else harness, else null. */
export function actorForSession(
  session: BranchSession,
  actorBySession: ReadonlyMap<string, string | null>
): string | null {
  const captured = actorBySession.get(session.sessionId);
  if (captured != null && captured !== "") {
    return captured;
  }
  return session.harness === "" ? null : session.harness;
}

/** Captured `sessionstart.actor.name` by session id from the merged trace. */
export function actorNameBySession(
  detail: BranchPageDetail
): Map<string, string | null> {
  const actorBySession = new Map<string, string | null>();
  for (const item of detail.mergedTrace) {
    if (item.type === "sessionstart") {
      actorBySession.set(item.sessionId, item.actor.name);
    }
  }
  return actorBySession;
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
 * Actors for E4 lanes and merged-trace turn colors. Session actors come from
 * `sessionstart.actor.name`, falling back to `harness` and then unattributed;
 * prompt/say actor names are included too so turn-level trace colors share the
 * same deterministic domain.
 */
export function deriveActorsFromSessions(
  detail: BranchPageDetail
): (string | null)[] {
  const actorBySession = actorNameBySession(detail);
  const actors = detail.sessions.map((session) =>
    actorForSession(session, actorBySession)
  );
  for (const item of detail.mergedTrace) {
    if (item.type === "prompt" || item.type === "say") {
      actors.push(item.actorName);
    }
  }
  return actors;
}

/** Actor for the primary branch session, used to anchor the blue actor pair. */
export function derivePrimaryActorFromSessions(
  detail: BranchPageDetail
): string | null {
  const session = derivePrimarySession(detail);
  if (!session) {
    return null;
  }
  return actorForSession(session, actorNameBySession(detail));
}

/**
 * Human stakeholder/user per session for the FEA-3576 cost timeline. Reads the
 * resolved owner display name (`session.ownerUserName`) each producer plumbs
 * through; a null/empty name coalesces to the shared "unattributed" key so the
 * color domain and the buckets agree on the unattributed bucket. Deliberately
 * NOT the session/model actor — that is `deriveActorsFromSessions` (used by the
 * E4 swimlane, which still lanes by actor).
 */
export function deriveUsersFromSessions(
  detail: BranchPageDetail
): (string | null)[] {
  return detail.sessions.map((session) => {
    const owner = session.ownerUserName;
    return owner == null || owner === "" ? null : owner;
  });
}

/** Human owner for the primary branch session, used to anchor the blue user pair. */
export function derivePrimaryUserFromSessions(
  detail: BranchPageDetail
): string | null {
  const session = derivePrimarySession(detail);
  if (!session) {
    return null;
  }
  const owner = session.ownerUserName;
  return owner == null || owner === "" ? null : owner;
}
