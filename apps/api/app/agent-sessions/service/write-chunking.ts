import { POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";

/**
 * ISS-8185: statement-level bounds for the session-upsert write lanes.
 *
 * Crossing the bind-parameter ceiling is not a slow query — the statement is
 * rejected outright, the surrounding session-upsert transaction rolls back, and
 * the desktop retries the identical, permanently-failing payload forever. What
 * gets bounded here is the WRITE, never the input: every caller still persists
 * every row it was handed, just across as many statements as the driver allows.
 * All of these run inside the caller's interactive transaction, so a chunked
 * write is still all-or-nothing — mirroring `token-event-persistence.ts`, which
 * chunks the same way.
 *
 * THE CEILING IS 32,767, NOT PostgreSQL's documented 65,535, and it is this
 * repo's existing {@link POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS} rather than a
 * second copy of the number. That 32,767 is Prisma Client's OWN per-statement
 * budget; it is NOT a driver `int16`, and the older docstrings that said so were
 * wrong. A statement passed through VERBATIM (`$executeRaw` / `Prisma.join`)
 * never meets it — it reaches the wire, where the `Bind` message counts
 * parameters in a uint16 and wraps at 65,536. Crossing the built-statement
 * budget surfaces as the opaque "query parameter limit supported by your
 * database is exceeded".
 *
 * THE REGRESSION WAS AN EXCLUSIVE BOUND READ AS AN INCLUSIVE ONE. 32,767 is the
 * count a statement is REFUSED at, not the widest it may be, so a slice sized to
 * fill it exactly emitted the first rejected statement. The budget therefore
 * starts from {@link POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS}. That correction
 * alone is what turns the ceiling suite green.
 *
 * {@link PRISMA_IMPLICIT_BIND_PARAMETERS} is then subtracted on top as MEASURED
 * HEADROOM, not as a second fix: without it the component-usage lookup sits at
 * exactly the last count its statement kind is accepted at, with no tolerance
 * for the extra parameter a `findMany` spends the moment it grows a `take`.
 *
 * Callers still declare their own `where` binds explicitly, because those the
 * helper genuinely cannot know. `INVENTORY_USAGE_ID_CHUNK_SIZE` in
 * `agent-components/usage-bind-budget.ts` makes a reservation of the same shape.
 *
 * CHUNKING IS ONLY SOUND FOR A PREDICATE THAT UNIONS over its items (`in`, an
 * `OR` of independent branches, a multi-row `VALUES`). The intersective case —
 * a per-group `notIn` — cannot be bounded by slicing at all; see
 * `pruneStaleBranchBuckets` in `component-usage-writes.ts`, which binds a fixed
 * six parameters via `unnest` instead.
 */

/**
 * Rows one statement may carry when every row costs the same number of bind
 * parameters.
 *
 * `fixedBindParameters` is the statement's own non-per-row binds — the session
 * id, the compute target id, a constant `componentKind`. It is a required
 * argument rather than an optional one because leaving it out is exactly the
 * defect this bound exists to stop: a slice sized against the whole ceiling
 * goes one parameter over as soon as the enclosing `where` binds anything.
 *
 * Floors at 1 so a pathologically wide row still makes progress one row at a
 * time instead of the caller emitting empty statements forever.
 */
export function bindParameterChunkSize(
  bindParametersPerRow: number,
  fixedBindParameters: number
): number {
  return Math.max(
    1,
    Math.floor(bindParameterBudget(fixedBindParameters) / bindParametersPerRow)
  );
}

/**
 * Bind parameters PRISMA adds to a built statement that no caller can see or
 * count, so the helper reserves them on every caller's behalf.
 *
 * MEASURED (ISS-8185, Prisma 7.8 / `@prisma/adapter-pg` / PostgreSQL 16), by
 * driving each statement kind to its exact refusal point with an `OR` list of
 * known width. Counting only the parameters the CALLER can see:
 *   - `deleteMany` is accepted at 32,766 and refused at 32,767, so it adds
 *     nothing of its own — which is what fixes 32,767 as the wall itself;
 *   - `findMany` is refused at 32,766, so it spends ONE parameter of its own;
 *   - `findMany` with a `take` is refused at 32,765, so it spends TWO.
 *
 * Two, therefore: the widest overhead measured across the kinds this helper
 * bounds, so a lane that later grows a `take` does not silently cross the line.
 * It is NOT the caller's `where` binds — those stay an explicit argument,
 * because only the caller knows them.
 *
 * `updateMany` was measured refused at 32,764 — it binds its `data` payload too,
 * so this reserve does NOT cover it. No lane bounded here uses it; teach this
 * constant about it before one does.
 */
export const PRISMA_IMPLICIT_BIND_PARAMETERS = 2;

/**
 * What is left of the ceiling for the variable part of a statement once the
 * binds Prisma adds and the caller's own fixed binds are both reserved. Floors
 * at 1 so a caller that somehow reserves the whole ceiling still emits
 * progress-making statements rather than empty ones.
 */
function bindParameterBudget(fixedBindParameters: number): number {
  return Math.max(
    1,
    POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS -
      PRISMA_IMPLICIT_BIND_PARAMETERS -
      fixedBindParameters
  );
}
