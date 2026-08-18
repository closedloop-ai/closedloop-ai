/**
 * @file parse-maintenance-progress.ts
 * @description ISS-6241: validate the post-boot maintenance phase at the IPC
 * boundary, now that it carries NUMBERS the splash renders as "N of M".
 *
 * WHY THIS EXISTS. `getRuntimeStatus()` is typed `Promise<unknown>`
 * (`desktop-api.d.ts`) and `parseMaintenance` used to be a bare cast — fine
 * while the payload was two booleans nobody did arithmetic on. It is not fine
 * for a counter: a version-skewed or malformed `{processed, total}` reaching the
 * splash is how a denominator the pass cannot substantiate gets on screen, which
 * is the whole defect class ISS-5932 was filed for (a `100%` derived from a
 * `0/0`) and FEA-4156 before it (a rail that retreated when the denominator
 * moved).
 *
 * The rule this file enforces: the counts are present TOGETHER or not at all,
 * and "not at all" is a first-class, honest state — the Compute step renders as
 * indeterminate rather than inventing a total. Anything that does not validate
 * degrades to that state; nothing partial is ever published.
 *
 * Same boundary and the same reasoning as `parse-cloud-read-readiness.ts`.
 */

import { z } from "zod";
import {
  isCountablePopulation,
  MaintenancePhase,
  type MaintenanceProgressPayload,
  type MaintenanceProgressWireKey,
} from "../../shared/maintenance-progress-contract";

/**
 * The renderer's name for the shared wire payload
 * (`shared/maintenance-progress-contract.ts`), which the PRODUCER
 * (`main/dashboard/maintenance-progress-state.ts`) publishes under its own
 * alias.
 *
 * ISS-6241 (wongk review): this used to be an independent declaration that
 * merely "mirrored" the producer's, so a field added on the producer side still
 * compiled and the schema below silently stripped it — the exact drift the
 * keys-covered guard claims to prevent. One declaration, both sides derived, and
 * the guard now bites on the producer's own shape.
 */
export type MaintenanceProgress = MaintenanceProgressPayload;

/**
 * A real, countable population: a positive integer that fits in exact
 * floating-point integer arithmetic. `0` is deliberately rejected rather than
 * accepted-and-special-cased downstream — a zero total is not a population, and
 * admitting it is what lets a `0/0` reach a ratio.
 */
/**
 * `.catch(undefined)` is load-bearing, not decoration: a bad COUNT must degrade
 * the count alone, never the payload. Without it a single malformed number fails
 * the whole object, `parseMaintenanceProgress` returns `null`, and the splash
 * loses the phase label too — freezing the Compute step on a stale value. That
 * is the same failure mode as a `.strict()` rejection, arriving through the
 * numbers instead of through an unknown key.
 */
const populationTotal = z.number().int().positive().safe();
const populationProcessed = z.number().int().nonnegative().safe();

const maintenanceShape = {
  active: z.boolean(),
  // Derived from the shared vocabulary, not re-typed: a phase the producer adds
  // is admitted here the moment it exists, and cannot be forgotten into the
  // `null` fallback.
  //
  // ISS-6241 (shafty023 review): `.catch(null)` is the VERSION-SKEW degrade.
  // Unknown FIELDS are forward-compatible above, but the phase VOCABULARY is
  // not: a newer main process reporting a phase this build has never heard of
  // used to fail the union, take the whole payload down with it, and leave the
  // banner reading maintenance as inactive and eligible to collapse — turning
  // live maintenance into "finished". Now the unsupported phase DETAIL alone
  // degrades to `null`; `active` is untouched and still decides liveness.
  phase: z.union([z.enum(MaintenancePhase), z.null()]).catch(null),
  processed: populationProcessed.optional().catch(undefined),
  total: populationTotal.optional().catch(undefined),
} satisfies Record<MaintenanceProgressWireKey, z.ZodTypeAny>;

/**
 * The `satisfies` above is the load-bearing part: it is a compile-time
 * keys-covered guard over the PRODUCER's own type, so the next field added to
 * `MaintenanceProgressPayload` fails `tsc` here instead of being silently
 * dropped at runtime by a boundary that never learned about it.
 *
 * Non-strict on purpose. A NEWER main process may send fields this build has
 * never heard of, and `.strict()` would reject the entire payload over one
 * unknown key — taking the phase label down with it and freezing the splash on
 * a stale value. Unknown keys are ignored; known keys are validated.
 */
const maintenanceSchema = z.object(maintenanceShape);

/**
 * Validate one maintenance payload.
 *
 * Returns `null` for an absent or unusable payload (the caller treats that as
 * "no maintenance"), and otherwise a value whose counts are either both present
 * and mutually consistent, or both absent.
 */
export function parseMaintenanceProgress(
  maintenance: unknown
): MaintenanceProgress | null {
  const parsed = maintenanceSchema.safeParse(maintenance);
  if (!parsed.success) {
    return null;
  }
  const { active, phase, processed, total } = parsed.data;
  if (!active) {
    // Nothing is running, so there is no phase to name and nothing to count.
    return { active: false, phase: null };
  }
  if (phase !== MaintenancePhase.Rebuild) {
    // ISS-6241 (shafty023 review): the counts are dropped because this phase
    // does not OWN them. `rebuild` is the only pass with a progress channel, so
    // a `{processed, total}` arriving beside `artifact-links` — or beside the
    // `null` an unknown, newer phase degraded to — is another population
    // mislabelled, and used to render as real progress next to Links. Validating
    // the numbers was never enough; the phase has to earn them.
    return { active: true, phase };
  }
  if (
    processed === undefined ||
    total === undefined ||
    !isCountablePopulation(processed, total)
  ) {
    // Either half missing, or a pair that cannot be rendered honestly (a
    // numerator outrunning its denominator would read as more-than-complete).
    // Drop BOTH: a lone `processed` has nothing to be out of, and a lone `total`
    // would have to pair with a fabricated zero. The phase itself is still good,
    // so the step stays live and simply reads as indeterminate.
    return { active: true, phase };
  }
  return { active: true, phase, processed, total };
}
