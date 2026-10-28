import { POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";

// ---------------------------------------------------------------------------
// The bind budget every agent-component usage read sizes its chunks against.
//
// ISS-8932: these two constants used to live in `./org-population`, which sits at
// the TOP of this surface's import graph (`plugin-child-usage` →
// `detail-usage-reads` → `org-population-reads` → `org-population`). Bounding the
// two remaining unbounded `OR` predicates put the sibling lanes in
// `org-population-reads` and `plugin-child-usage` in need of the same budget, and
// importing it from `org-population` would have closed a cycle. A leaf module is
// the only shape that lets all four lanes reserve against ONE number instead of
// re-deriving it, which is the drift `postgres-bind-parameters.ts` already exists
// to prevent one level down.
// ---------------------------------------------------------------------------

/**
 * Bind slots held back from every chunk for the part of the usage statement no
 * caller enumerates — the org id the rollup applies itself, and the parameters
 * Prisma spends building a statement that nobody can see or count
 * (`PRISMA_IMPLICIT_BIND_PARAMETERS`, measured in ISS-8185). A deliberately
 * generous reserve: erring large costs one extra round trip while erring small
 * costs the whole request.
 *
 * ISS-7271: IT NO LONGER COVERS THE REQUEST'S FACETS, and could not. It used to
 * claim one slot per `?search=` OR arm, but that arm count follows the request:
 * `usageSearchWhere` emits `2N + 1` binds, where N is the facet's
 * `nameMatchedIdentities` — bounded, at the time, only by the 5,000-identity
 * population cap ISS-6891 has since removed. A broad search over a large org
 * therefore asked for up to 10,001 slots against this 767-slot reserve and built
 * a statement past the driver's bind limit. That statement is refused outright,
 * and that lane is deliberately NOT fail-open (see `runUsageGroupByChunked`), so
 * the rejection propagated and 500ed the Agents catalog request — the exact
 * failure the chunking was added to prevent (ISS-5516). The facet width is now
 * MEASURED off the predicate and subtracted on top of this
 * (`inventoryUsageIdChunkSize`), so what is left here is only the statement's
 * fixed, uncountable remainder plus margin, which is what a constant can honestly
 * hold.
 *
 * Exported so the chunking coverage can express the budget an emitted statement
 * must fit inside, rather than restating this number beside it.
 */
export const BIND_PARAMETERS_RESERVED_PER_STATEMENT = 767;

/**
 * The WIDEST `agentComponentId: { in: … }` predicate the FK usage lane may emit,
 * and the exact width it emits for a request carrying no facets. Every other
 * usage lane on this surface sizes its own chunk against the same number, so
 * "how wide may one of these statements be" has a single answer.
 *
 * ISS-7271: no longer the width of every chunk. A request's own facets are
 * measured and subtracted from this by `inventoryUsageIdChunkSize`, which is what
 * actually sizes the slice — read that, not this, when the question is "how many
 * ids does a chunk carry". The reasoning below is about how far this upper bound
 * may sit from the ceiling, and is unchanged.
 *
 * ISS-5516: the id list reaching `loadUsageGroupsForInventory` became genuinely
 * unbounded when the org population reads dropped their raw-row ceiling — that
 * ceiling was derived from `POSTGRES_MAX_BIND_PARAMETERS` precisely BECAUSE those
 * ids are bound one parameter each, and a statement past that limit is refused
 * outright rather than merely slowed. Truncating the population to fit was the
 * defect (a cap applied after the facet predicate makes the retained population
 * facet-dependent), so the bind bound is answered at the read, exactly as
 * `SESSION_LOC_ID_CHUNK_SIZE` and `SESSION_USAGE_BRANCH_ID_CHUNK_SIZE` already
 * answer it for the same shape of id list.
 *
 * Sized AT the driver's budget rather than at a round number, because chunk size
 * trades directly against round trips inside an interactive transaction with a
 * fixed timeout (`USAGE_SNAPSHOT_TX_TIMEOUT_MS`, and its detail-side twin). At
 * this value every org whose inventory fits the old row ceiling issues exactly
 * ONE statement for a facet-free request — the same query count it issues today —
 * so removing the ceiling adds no round trip to any org that currently works, and
 * only an org genuinely past the driver limit pays a second chunk. A smaller
 * chunk would multiply round trips for every large org to buy headroom the
 * reserve above already provides.
 *
 * ISS-8239: reserved against {@link POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS}, the
 * last width a built statement is ACCEPTED at, not against
 * `POSTGRES_MAX_BIND_PARAMETERS`, the first width it is REFUSED at. Subtracting
 * the reserve from the refusal count modelled a full chunk at exactly 32,767
 * parameters — one over the line, the identical fencepost ISS-8185 shipped and
 * #6093 fixed in the sibling writers. Nothing has ever failed there, because a
 * full chunk only arises for an org with more than 32,000 inventory components
 * and Prisma re-splits an over-wide `in` of its own accord before the statement
 * reaches the wire; the model was wrong regardless, and a consumer that reads
 * this constant as "the width a chunk may reach" would inherit the error.
 */
export const INVENTORY_USAGE_ID_CHUNK_SIZE =
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS -
  BIND_PARAMETERS_RESERVED_PER_STATEMENT;

/**
 * ISS-8932: how many arms of a repeated `OR` predicate one statement may carry,
 * given what the rest of that statement already binds.
 *
 * The shape it answers for is the one both remaining unbounded predicates on this
 * surface have — an `OR` whose arm count follows the org's data rather than a
 * constant, which {@link INVENTORY_USAGE_ID_CHUNK_SIZE} cannot narrow its way out
 * of because narrowing the OTHER half of the statement does not shrink the arms.
 *
 * `armBindWidth` is MEASURED off a representative arm by the caller rather than
 * restated here, for the reason `countPredicateBindParameters` exists: a hand
 * count of "three binds per arm" goes stale the moment the arm grows a term.
 *
 * `shares` is how many independently-chunked lists divide this budget. A lane
 * whose arm loop MULTIPLIES with a second chunk loop (the FK usage lane, whose id
 * list is chunked inside each search pass) passes 2, for the reason
 * `identityKeyChunks` splits evenly: handing the arms everything but one slot
 * leaves the id chunking floored at a single id and turns the lane into one
 * statement per inventory row inside a bounded interactive transaction. A lane
 * with a single loop passes 1.
 *
 * FLOORS AT ONE ARM, and that floor is a LIVENESS guard rather than a bind bound
 * — a statement carrying one arm is still refused if `otherBindCount` alone
 * crossed the ceiling. It is reachable only if some OTHER term of the same
 * statement is itself unbounded, which is why each caller measures
 * `otherBindCount` off the predicate it is about to issue instead of assuming it
 * small: the number then shrinks honestly, and the one lane where an unbounded
 * sibling term is KNOWN OPEN (the detail lane's `contentScope.contentHashes`, see
 * `identityKeyChunks`) is not silently masked by a floor that pretends otherwise.
 */
export function orArmsPerStatement(
  otherBindCount: number,
  armBindWidth: number,
  shares: number
): number {
  const available = Math.floor(
    (INVENTORY_USAGE_ID_CHUNK_SIZE - otherBindCount) / shares
  );
  return Math.max(1, Math.floor(available / armBindWidth));
}
