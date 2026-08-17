/**
 * @file branch-read-facades.ts
 * @description ISS-5957 — the ONE canonical composite of the named Branch read
 * facades on the db-host invoke surface.
 *
 * Both the contract (`sqlite-contract.ts`) and the admission-lane registry
 * (`db-host/db-host-op-lane-registry.ts`) compose Branch reads through THIS type
 * and nowhere else. That shared seam is what makes the registry's exhaustiveness
 * guard bite on an ADDITION: an earlier revision intersected the two leaf
 * interfaces independently in each place, so a THIRD facade composed into
 * `SqliteAgentDatabase` reached the proxy while the registry — still exhausting
 * only the two interfaces it happened to name — kept compiling. Adding a facade
 * here fails `tsc` in the registry until someone declares its lane.
 *
 * What that does NOT buy, stated plainly: it is a convention, not an
 * impossibility. This composite is one of three top-level bundles intersected
 * into `SqliteAgentDatabase`, and the guard exhausts only this one. A future
 * Branch facade intersected there directly — mirroring its `StoreHealthMethods`
 * and `DiagnosticsMethods` neighbours instead of landing here — is callable by
 * name through the proxy with no declared lane and `tsc` exits 0. The note at
 * that intersection points the next author here; nothing enforces it. Read the
 * "What the guard does NOT cover" header of `db-host-op-lane-registry.ts` for
 * the guard's real scope.
 *
 * Only facades whose methods are callable by NAME through the db-host proxy
 * belong in this composite. The raw Branch corpus reads in `branch-reads.ts`
 * arrive as `prisma.client.*` paths, are not `keyof`-enumerable, and are out of
 * scope here — see the header of `db-host-op-lane-registry.ts`.
 */

import type { BranchCanonicalActivityReadMethods } from "./branch-activity-read.js";
import type { BranchMetricEventEvidenceMethods } from "./branch-metric-event-provenance.js";

/** Every named Branch read facade the db-host exposes as a top-level op. */
export type BranchReadFacadeMethods = BranchCanonicalActivityReadMethods &
  BranchMetricEventEvidenceMethods;
