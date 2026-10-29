/** Lightweight cross-surface contract for bounded Sessions List reads. */

import type { AgentSessionListItem } from "./agent-session.js";
import type { DisplayedSessionStatus } from "./session-status.js";

/** New producers serve canonical display status; older received wires remain open. */
export type CanonicalAgentSessionListItem = Omit<
  AgentSessionListItem,
  "status"
> & { status: DisplayedSessionStatus };

/**
 * What a producer declares it can do with a paged Sessions read.
 *
 * ISS-9555: the negotiation field, deliberately a value rather than a boolean —
 * a cursor arrives later as a second value without changing the envelope twice.
 * Mirrors `BranchListCapability`; the two contracts are conformant siblings and
 * are NOT merged (PLN-1938 §8 decision 3 stays open).
 */
export const AgentSessionListCapability = {
  ServerPaginationV1: "server_pagination_v1",
} as const;
export type AgentSessionListCapability =
  (typeof AgentSessionListCapability)[keyof typeof AgentSessionListCapability];

/**
 * Which page a Sessions list read ACTUALLY served, as the producer saw it.
 *
 * `offset` is where the returned rows were taken from and `limit` is the page
 * size the producer HONOURED — which is not always the one asked for, and the
 * two producers differ on why. The cloud route REJECTS an over-cap `limit` with
 * a 400 rather than clamping it, so its echo restates the size the request
 * resolved to. The desktop local read CLAMPS one to its own ceiling and floors a
 * fractional value, so its echo can name a size the reader never asked for — as
 * can a version-skewed Desktop build holding a different ceiling. A consumer
 * reads its rendered position off these two instead of re-deriving it from its
 * own request and `total`, which is what let a footer name a page the rows on
 * screen were not from.
 *
 * No `requestedOffset`, unlike the Branches sibling: a Sessions read never moves
 * an out-of-range request onto another page — an offset past the population
 * answers empty at that offset — so the requested value would be a byte-identical
 * copy of `offset`, which is SSOT drift by copy rather than a second fact. The
 * two contracts are conformant siblings and are permitted to differ here.
 *
 * No `now`: the Branches sibling carries one because its list and analytics
 * reads are bound to a single producer clock. Sessions has no such handshake, so
 * a field with nothing to bind would be a clock consumers could only misuse.
 */
export type AgentSessionListPageInfo = {
  capability: typeof AgentSessionListCapability.ServerPaginationV1;
  limit: number;
  offset: number;
};
