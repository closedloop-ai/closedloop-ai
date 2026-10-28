/**
 * The parameter count at which a Prisma-BUILT statement is REFUSED — an
 * EXCLUSIVE bound, not a width a statement may reach.
 *
 * Load-bearing wherever a predicate's width follows a payload: crossing this is
 * not merely expensive, the statement is refused outright and takes the whole
 * request with it.
 *
 * IT IS PRISMA CLIENT'S OWN PER-STATEMENT BUDGET, NOT A DRIVER `int16`. This
 * docstring used to claim the Postgres driver encodes the count as a SIGNED
 * 16-bit integer, making 32,767 "half the 65,535 the protocol documents". That
 * rationale is wrong: the wire's `Bind` message counts parameters in a UINT16,
 * so a statement passed through VERBATIM (`$queryRaw` / `$executeRaw` /
 * `Prisma.join`) is not subject to this number at all — it reaches the wire and
 * wraps at 65,536. Two different ceilings, and which one applies depends on
 * whether Prisma got to build the statement.
 *
 * MEASURED (ISS-8185, Prisma 7.8 / `@prisma/adapter-pg` / PostgreSQL 16, both
 * directions): a `deleteMany` — which binds nothing of its own — is accepted at
 * 32,766 parameters and refused at 32,767. So the largest count a built
 * statement is actually accepted at is {@link
 * POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS}, and sizing a chunk to reach THIS
 * number produces the first statement the driver rejects. That was the ISS-8185
 * regression.
 *
 * The answer to crossing it is always to CHUNK at the consumer, never to
 * truncate the population: a truncation applied after a facet predicate makes
 * the retained population facet-dependent, which is the defect (ISS-5516).
 *
 * DELIBERATELY A LEAF MODULE WITH NO `server-only` AND NO IMPORTS. It used to
 * live in `app/agent-components/org-population-reads.ts`, whose first line is
 * `import "server-only"`. That was harmless while every consumer was a Next
 * server module, and stopped being harmless when the session-upsert write lanes
 * started reserving against this ceiling: those lanes are reachable from the
 * desktop gateway, which runs under `tsx` OUTSIDE Next, where `server-only`
 * throws on import. `scripts/smoke-desktop-gateway-import.ts` is the gate that
 * catches it. Keep this module dependency-free so importing the number can never
 * drag a server-only runtime behind it.
 */
export const POSTGRES_MAX_BIND_PARAMETERS = 32_767;

/**
 * The largest parameter count a Prisma-BUILT statement is accepted at — the
 * INCLUSIVE twin of {@link POSTGRES_MAX_BIND_PARAMETERS}, which is the count it
 * is refused at.
 *
 * Exists because the two were conflated: `POSTGRES_MAX_BIND_PARAMETERS` reads
 * like a width a statement may reach, and every consumer that sized a chunk to
 * fill it exactly emitted a statement one parameter over the line. Reserve
 * against THIS when the question is "how wide may this statement be".
 *
 * STILL NOT THE WHOLE ANSWER FOR A `findMany`, which binds parameters of its
 * own that no caller can see — see `PRISMA_IMPLICIT_BIND_PARAMETERS` in
 * `app/agent-sessions/service/write-chunking.ts`, which reserves for them.
 */
export const POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS =
  POSTGRES_MAX_BIND_PARAMETERS - 1;

/**
 * THE OTHER CEILING: the parameter count at which a statement passed through
 * VERBATIM is refused — `$queryRaw`, `$executeRaw`, and anything assembled with
 * `Prisma.join`. An EXCLUSIVE bound, exactly like {@link
 * POSTGRES_MAX_BIND_PARAMETERS}, and its inclusive twin is {@link
 * POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS}.
 *
 * THE TWO PAIRS READ IDENTICALLY ON PURPOSE (ISS-8239, whitlockk review). This
 * constant first shipped as `65_535` while its own docstring called it the
 * refusal threshold and recorded the refusal at 65,536 — the value said
 * "inclusive maximum", the name and the prose said "exclusive bound", and the
 * two siblings then carried opposite bound semantics under the same naming
 * shape. That is the ISS-8185 fencepost with a second chance to happen: the next
 * raw-query chunker reads one sibling and reserves against the other. So the
 * verbatim pair now mirrors the built pair — `MAX_*` is the count that is
 * REFUSED, `MAX_ACCEPTED_*` is the width a chunk may actually reach.
 *
 * Prisma never inspects such a statement, so {@link
 * POSTGRES_MAX_BIND_PARAMETERS} — which is Prisma Client's own per-statement
 * budget — does not apply to it. It reaches the wire, where the `Bind` message
 * counts parameters in a UINT16 and wraps here. MEASURED (ISS-8185/ISS-8239,
 * Prisma 7.8 / `@prisma/adapter-pg` / PostgreSQL 16): accepted at 65,535,
 * refused at 65,536 with `08P01`.
 *
 * WHICH CONSTANT A CONSUMER WANTS IS DECIDED BY ONE QUESTION — did Prisma get to
 * build the statement? A `findMany`/`createMany`/`deleteMany` predicate reserves
 * against the BUILT pair above; a hand-written `INSERT ... ON CONFLICT` issued
 * through `$executeRaw` reserves against this one. Sizing a verbatim statement
 * against the built ceiling is not an overflow bug, only wasted headroom — but
 * it is the same duplicated-literal drift, so both kinds are named here rather
 * than redeclared privately at each consumer (ISS-8239, item 1).
 *
 * `scripts/lint/rules/no-private-postgres-bind-ceiling.ts` is the gate that
 * keeps a private redeclaration of either ceiling from coming back.
 */
export const POSTGRES_MAX_VERBATIM_BIND_PARAMETERS = 65_536;

/**
 * The largest parameter count a VERBATIM statement is accepted at — the
 * INCLUSIVE twin of {@link POSTGRES_MAX_VERBATIM_BIND_PARAMETERS}, and what a
 * `$queryRaw`/`$executeRaw`/`Prisma.join` chunker reserves against.
 *
 * Stands in the same relation to its ceiling as {@link
 * POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS} does to {@link
 * POSTGRES_MAX_BIND_PARAMETERS}, so "how wide may this statement be" is
 * answered by the `MAX_ACCEPTED_*` member of whichever pair applies, and never
 * by reading a bound off the other pair.
 */
export const POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS =
  POSTGRES_MAX_VERBATIM_BIND_PARAMETERS - 1;

/**
 * ISS-7271: how many bind parameters a built `where` spends, counted off the
 * PREDICATE ITSELF rather than restated beside it.
 *
 * A chunker has to hold back the binds the rest of its statement spends, and
 * every reserve that hand-counts them is a restatement that can go stale while
 * the predicate moves. It did: the agent-component usage rollup reserved a fixed
 * 767 slots for "the facets", then grew a `?search=` arm per name-matched
 * identity — two binds each, up to 5,000 identities — and started building
 * statements past the ceiling. Counting the object about to be issued is what
 * makes a later facet free.
 *
 * Every predicate shape this repo binds is a scalar, an `in`/`notIn` list, or an
 * `AND`/`OR`/`NOT` of such fragments, so the width is the count of leaf values.
 * A list needs no branch of its own — an array is walked like any other object,
 * which counts each of its elements.
 *
 * DELIBERATELY CONSERVATIVE WHEREVER IT CANNOT BE EXACT, because OVER-counting
 * costs one extra round trip while UNDER-counting costs the whole request:
 *   - a `null` compiles to `IS NULL` and binds nothing, but still counts one;
 *   - a `Date` counts as the scalar it is rather than being walked as an object;
 *   - `mode: "insensitive"` selects `ILIKE` over `LIKE` and binds nothing, but
 *     still counts one. Telling that modifier apart from a column genuinely
 *     NAMED `mode` is not possible from the object alone, and a rule that
 *     guessed would under-count the column — so neither is special-cased. It
 *     costs one slot per string filter, and this repo's widest predicate carries
 *     exactly one.
 *
 * NOT a substitute for the reserve a caller cannot see — Prisma's own implicit
 * binds are invisible to any predicate walk and are still reserved separately
 * (`PRISMA_IMPLICIT_BIND_PARAMETERS` in
 * `app/agent-sessions/service/write-chunking.ts`).
 */
export function countPredicateBindParameters(predicate: unknown): number {
  if (predicate === undefined) {
    return 0;
  }
  if (
    predicate === null ||
    typeof predicate !== "object" ||
    predicate instanceof Date
  ) {
    return 1;
  }
  let total = 0;
  for (const nested of Object.values(predicate)) {
    total += countPredicateBindParameters(nested);
  }
  return total;
}
