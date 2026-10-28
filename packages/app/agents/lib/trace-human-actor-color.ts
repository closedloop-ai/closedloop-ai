import type { TurnItem } from "@repo/api/src/types/agent-session";
import {
  ActorTurnSide,
  actorColorForTurn,
  actorColorPairForSlot,
  UNKNOWN_ACTOR_COLOR_PAIR,
} from "@repo/app/shared/lib/actor-color-domain";

/**
 * This trace's own actor domain holds exactly one human, so that person is its
 * primary actor and takes the authority's primary seat, rather than the per-user
 * hash this trace alone used to speak. An unresolved user takes the authority's
 * neutral instead of a hue, which would claim an identity nothing established.
 *
 * A seat is an ordinal WITHIN a domain, so this deliberately does not reproduce
 * a Branch trace's seat for the same person: there, rank comes from who acted
 * first on that branch, and this page has no branch in hand — a session can
 * belong to none or several. It agrees with the Branch trace when the owner is
 * that branch's earliest actor, and otherwise states this domain's own rank
 * rather than guessing at one it cannot resolve.
 */
export function humanActorColor(hasUser: boolean): string {
  return actorColorForTurn(
    hasUser ? actorColorPairForSlot(0) : UNKNOWN_ACTOR_COLOR_PAIR,
    ActorTurnSide.Human
  );
}

/** Re-seats DB-projected human turns on the shared authority (prompt = human). */
export function withAuthorityHumanActorColor(
  items: readonly TurnItem[] | undefined,
  color: string
): readonly TurnItem[] | undefined {
  if (!items) {
    return items;
  }
  return items.map((item) =>
    item.type === "prompt" ? { ...item, actor: { ...item.actor, color } } : item
  );
}
