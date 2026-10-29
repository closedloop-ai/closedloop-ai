/**
 * @file agent-component-invocation-ancestry.ts
 * @description ISS-10714: the reconstructed "which call reached this one" for a
 * single component invocation.
 *
 * Kept in its own module rather than inlined next to the read row so a
 * bundle-sensitive client can import the shape without the invocation contract's
 * folds, and so the pure walk below has no dependency on the read layer.
 */

/**
 * How many ancestor hops a walk will follow before it refuses to keep going.
 *
 * A bound is required rather than prudent: the parent edges are reconstructed
 * from transcript evidence that crosses a trust boundary, so the graph is not
 * guaranteed acyclic and an unbounded walk is a hang rather than an error
 * anyone sees. {@link walkInvocationAncestry} also refuses a revisited node
 * directly, so a cycle is caught by whichever fires first; this cap is what
 * bounds a chain that is merely absurd rather than circular.
 */
export const INVOCATION_ANCESTRY_MAX_HOPS = 64;

/**
 * An invocation's place in the call tree.
 *
 * `chain` is ordered NEAREST ANCESTOR FIRST and never contains the invocation
 * itself. `depthFromRootInvocation` is `chain.length`: 0 is a root invocation —
 * nothing recorded a call that reached it — and is a positive claim, which is
 * why the whole object is ABSENT rather than zero-valued when the chain could
 * not be reconstructed. "We could not tell" and "it is a root" are different
 * facts.
 *
 * THE NAME IS LOAD-BEARING and is NOT the desktop `agents.metadata.ancestry`
 * depth. That one counts hops to the MAIN AGENT, so a subagent the main agent
 * spawned is 1 there. Here the main agent has no invocation row to point at, so
 * that same subagent's invocation is a ROOT and reads 0. The two scales differ
 * by one for the same subagent by construction; naming both `depth` invited a
 * consumer to read one and substitute the other (ISS-10714 review).
 */
export type AgentComponentInvocationAncestry = {
  chain: string[];
  depthFromRootInvocation: number;
};

/**
 * Walk one invocation's ancestors through a lookup of
 * `externalInvocationId -> parentExternalInvocationId`, where `null` means the
 * row records no parent and `undefined` means the row is not available.
 *
 * Returns `undefined` when the chain cannot be reconstructed: a parent pointer
 * that resolves to no row, a cycle, or a chain past the hop cap. A partial walk
 * is not published as a shorter chain — a truncated ancestry reads as a shallower
 * call site, which is a wrong answer rather than an incomplete one.
 */
export function walkInvocationAncestry(
  externalInvocationId: string,
  parentByExternalInvocationId: ReadonlyMap<string, string | null>
): AgentComponentInvocationAncestry | undefined {
  const chain: string[] = [];
  const seen = new Set<string>([externalInvocationId]);
  let current = externalInvocationId;
  // One MORE iteration than the cap, deliberately: the extra pass reads the
  // terminating edge of the hop-cap-th ancestor without pushing anything. A
  // loop bounded at the cap exits with `current` sitting on that ancestor and
  // its `null` parent never read, so a COMPLETE chain of exactly
  // INVOCATION_ANCESTRY_MAX_HOPS came back absent — a reconstructable chain
  // reported as unreconstructable (whitlockk review).
  for (let hop = 0; hop <= INVOCATION_ANCESTRY_MAX_HOPS; hop++) {
    if (!parentByExternalInvocationId.has(current)) {
      return undefined;
    }
    const parent = parentByExternalInvocationId.get(current) ?? null;
    if (parent === null) {
      return { chain, depthFromRootInvocation: chain.length };
    }
    if (seen.has(parent)) {
      return undefined;
    }
    if (chain.length >= INVOCATION_ANCESTRY_MAX_HOPS) {
      return undefined;
    }
    seen.add(parent);
    chain.push(parent);
    current = parent;
  }
  return undefined;
}
