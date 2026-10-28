/**
 * The intra-feed join (ISS-8399): how a delivery row gets a pull-request number.
 *
 * The feed does not give one directly. The `creator` row — the one carrying the
 * LARGE values — has only a bare title and no PR number at all. Only
 * `pull_request_review` rows embed `<owner>/<repo>#<number>`, and the ONLY
 * thing tying the two together is that they share a `url` of the form
 * `/interactions/pull_request/<id>`.
 *
 * So the association is keyed on the PENSERO INTERACTION ID, not on a PR
 * number, and not on a title. Two consequences drive this module's shape:
 *
 * 1. **A creator row may have no reviewer counterpart in its window.** Its
 *    interaction id still exists, and a later segment may supply the number. So
 *    the index is a value that can be MERGED across segments rather than
 *    something rebuilt per response.
 * 2. **An interaction that names two different pull requests is AMBIGUOUS, and
 *    ambiguity does not resolve to "pick the first".** Picking one is how a
 *    pull request ends up carrying another's points.
 *
 * Titles are never a fallback here. They are not unique (two distinct PRs in
 * the sample share a byte-identical creator title), they are lossy (markup
 * stripped, leaving a double space), and they embed unescaped quotes.
 */

import type {
  PenseroDeliveryRow,
  PenseroPullRequestRef,
} from "./delivery-contract";
import { PenseroInteractionKind } from "./delivery-contract";
import { samePullRequestRef } from "./delivery-parse";

/**
 * How a row's pull request was (or was not) established. A closed set, kept
 * SEPARATE from the match outcome against our own records: "the feed could not
 * tell us which PR this is" and "we have no such PR" are different facts, and
 * folding them would hide which half of the pipeline is short.
 */
export const PullRequestResolution = {
  /** This row's own title named the PR (a review row). */
  Direct: "direct",
  /** A sibling row sharing this interaction id named the PR. */
  Interaction: "interaction",
  /** The row names no pull-request interaction (messaging, ticket, unknown). */
  NoInteraction: "no_interaction",
  /** A pull-request interaction with no row anywhere naming a number. */
  NoCounterpart: "no_counterpart",
  /** The interaction id names more than one distinct pull request. */
  Ambiguous: "ambiguous",
} as const;
export type PullRequestResolution =
  (typeof PullRequestResolution)[keyof typeof PullRequestResolution];

/** What one interaction id resolved to across every row seen so far. */
export type InteractionEntry =
  | { readonly kind: "single"; readonly ref: PenseroPullRequestRef }
  | {
      readonly kind: "ambiguous";
      readonly refs: readonly PenseroPullRequestRef[];
    };

/**
 * Interaction id → pull request, accumulated across segments. A plain `Map`
 * rather than an object literal so a provider-supplied id can never collide
 * with `__proto__` or `constructor`.
 */
export type InteractionIndex = ReadonlyMap<string, InteractionEntry>;

/** A row with its pull request resolved (or explicitly not). */
export type ResolvedDeliveryRow = {
  readonly row: PenseroDeliveryRow;
  readonly pullRequest: PenseroPullRequestRef | null;
  readonly resolution: PullRequestResolution;
};

/**
 * Fold rows into an interaction index. Only rows that BOTH name a pull-request
 * interaction and carry a parsed PR ref contribute — a creator row consumes the
 * index, it never populates it.
 *
 * `seed` lets a caller carry an index forward across segments, which is what
 * makes a creator row resolvable from a number that arrived in a different
 * window.
 */
export function buildInteractionIndex(
  rows: readonly PenseroDeliveryRow[],
  seed?: InteractionIndex
): InteractionIndex {
  const observations: InteractionObservation[] = [];
  for (const row of rows) {
    if (
      !row.pullRequest ||
      row.interaction?.kind !== PenseroInteractionKind.PullRequest
    ) {
      continue;
    }
    observations.push({
      interactionId: row.interaction.id,
      ref: row.pullRequest,
    });
  }
  return indexInteractionObservations(observations, seed);
}

/** Merge two indexes, preserving (and creating) ambiguity rather than a winner. */
export function mergeInteractionIndexes(
  left: InteractionIndex,
  right: InteractionIndex
): InteractionIndex {
  const merged = new Map<string, InteractionEntry>(left);
  for (const [id, entry] of right) {
    if (entry.kind === "single") {
      addToIndex(merged, id, entry.ref);
      continue;
    }
    for (const ref of entry.refs) {
      addToIndex(merged, id, ref);
    }
  }
  return merged;
}

/**
 * Resolve one row's pull request against the index.
 *
 * A row's OWN title wins when it has one — it is the most direct evidence — but
 * it is still checked against the index, because an interaction whose siblings
 * disagree is ambiguous for every row on it, including the one that named a PR.
 */
export function resolveDeliveryRow(
  row: PenseroDeliveryRow,
  index: InteractionIndex
): ResolvedDeliveryRow {
  if (row.interaction?.kind !== PenseroInteractionKind.PullRequest) {
    return {
      row,
      pullRequest: null,
      resolution: PullRequestResolution.NoInteraction,
    };
  }
  const entry = index.get(row.interaction.id);
  if (!entry) {
    return {
      row,
      pullRequest: null,
      resolution: PullRequestResolution.NoCounterpart,
    };
  }
  if (entry.kind === "ambiguous") {
    return {
      row,
      pullRequest: null,
      resolution: PullRequestResolution.Ambiguous,
    };
  }
  return {
    row,
    pullRequest: entry.ref,
    resolution: row.pullRequest
      ? PullRequestResolution.Direct
      : PullRequestResolution.Interaction,
  };
}

/** Resolve every row in a batch against one index. */
export function resolveDeliveryRows(
  rows: readonly PenseroDeliveryRow[],
  index: InteractionIndex
): ResolvedDeliveryRow[] {
  return rows.map((row) => resolveDeliveryRow(row, index));
}

/**
 * Record one (interaction id, PR ref) observation. A second, DIFFERENT ref for
 * an id promotes the entry to ambiguous and it never demotes back — once the
 * feed has contradicted itself about an interaction, a later agreeing row does
 * not settle which of the two was right.
 */
/**
 * One (interaction id, pull request) sighting, from any source. The feed is one
 * source; rows a PREVIOUS backfill run already resolved and persisted are
 * another, and both have to enter the index through the same ambiguity rules —
 * a stored ref that contradicts a fresh one is exactly as ambiguous as two
 * contradicting rows in one response.
 */
export type InteractionObservation = {
  readonly interactionId: string;
  readonly ref: PenseroPullRequestRef;
};

/** Fold observations into an index, optionally on top of an existing one. */
export function indexInteractionObservations(
  observations: readonly InteractionObservation[],
  seed?: InteractionIndex
): InteractionIndex {
  const index = new Map<string, InteractionEntry>(seed ?? []);
  for (const observation of observations) {
    addToIndex(index, observation.interactionId, observation.ref);
  }
  return index;
}

function addToIndex(
  index: Map<string, InteractionEntry>,
  id: string,
  ref: PenseroPullRequestRef
): void {
  const existing = index.get(id);
  if (!existing) {
    index.set(id, { kind: "single", ref });
    return;
  }
  if (existing.kind === "single") {
    if (samePullRequestRef(existing.ref, ref)) {
      return;
    }
    index.set(id, { kind: "ambiguous", refs: [existing.ref, ref] });
    return;
  }
  if (existing.refs.some((known) => samePullRequestRef(known, ref))) {
    return;
  }
  index.set(id, { kind: "ambiguous", refs: [...existing.refs, ref] });
}
