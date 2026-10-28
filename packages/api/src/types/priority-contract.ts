import { ArtifactStatusEditSurface } from "./artifact-status-contract.ts";
import { Priority } from "./common.ts";

/**
 * The canonical priority contract, shared by `apps/api` and the product UI.
 *
 * The vocabulary itself is {@link Priority}; this module owns what an
 * untrusted value is allowed to become. "No priority" has three spellings and
 * exactly one meaning: `null` on the wire and in the row model,
 * `PRIORITY_UNSET_VALUE` (`"NONE"`) in the `:priority` search grammar, and
 * `NO_PRIORITY_LABEL` on screen. Each is imported from its owner; none is
 * re-spelled here.
 *
 * The semantic RANK is not declared here — `@repo/design-system` cannot import
 * this package, so the sort rank lives in `@repo/design-system/lib/priority-order`
 * (most urgent first, unset last) and the wire/SQL ordinal lives in
 * `./search-query` (low→high, so `:priority>=medium` reads as written). They
 * are exact inverses by contract, pinned by the reconciliation test in
 * `@repo/app/shared/lib/__tests__`, which is the one place both are visible.
 */

/**
 * Exhaustive by type: a member added to {@link Priority} fails typecheck here
 * rather than being silently rejected as unknown by every boundary that calls
 * {@link isPriority}.
 */
const PRIORITY_MEMBERS: Readonly<Record<Priority, true>> = {
  [Priority.Low]: true,
  [Priority.Medium]: true,
  [Priority.High]: true,
  [Priority.Urgent]: true,
};

/** `Object.hasOwn`, not `in`, so prototype keys are not members. */
export function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && Object.hasOwn(PRIORITY_MEMBERS, value);
}

/**
 * NO FOLD ONTO `Priority | null` IS EXPORTED HERE, deliberately.
 *
 * Such a helper looks like the natural companion to {@link isPriority}, and a
 * serialization mapper is where it would get used. That is exactly where it must
 * not be: the artifact mappers agree to pass the stored column through untouched
 * (`priority-serialization-agreement.test.ts` — "one artifact, one priority, at
 * every serialization point"), so a mapper folding an unrecognized member to
 * `null` would answer "no priority" where its four siblings answer the value,
 * re-creating the ISS-9665 defect one enum member later.
 *
 * The input has three states — a member, absent, and a member only a newer peer
 * knows — while `Priority | null` has two, so any fold discards one of them.
 * `priorityLabel` in `@repo/design-system/lib/priority-order` separates all
 * three, so a surface that must tell them apart tests `value == null` and
 * {@link isPriority} itself, which keeps `PRIORITY_LABEL_UNKNOWN` reachable.
 */

/**
 * WHICH SURFACES CAN WRITE A PRIORITY (ISS-9443).
 *
 * Priority has no vocabulary of its own here: a surface is a surface, and
 * {@link ArtifactStatusEditSurface} already names every production write path.
 * Re-spelling three of those strings under a priority name would be one
 * vocabulary declared twice, so this derives from that one instead — the same
 * choice `./artifact-priority-mutation.ts` makes when it imports the status
 * module's `ArtifactsNotFound` literal rather than re-typing it.
 *
 * What priority does NOT share is the applicable SET. A kanban column is a
 * status, so no board drag writes a priority; `row_action` is the projects
 * table's archive/unarchive item on `PUT /projects/[id]`, which writes no
 * artifact priority either. Counting an event under either would put a number
 * on a bar nobody can click.
 *
 * The table below is the whole reason this is a table and not a three-member
 * list: a list compiles with a member missing, so a sixth edit surface would
 * join the union, take the `false` branch by omission, and be silently
 * uncounted. `satisfies Record<ArtifactStatusEditSurface, boolean>` makes that
 * a typecheck failure instead, and the type, the predicate and the value list
 * below are all derived from it so none of them can disagree with it.
 */
const PRIORITY_EDIT_SURFACE_APPLICABILITY = {
  [ArtifactStatusEditSurface.Detail]: true,
  [ArtifactStatusEditSurface.InlineCell]: true,
  [ArtifactStatusEditSurface.Bulk]: true,
  [ArtifactStatusEditSurface.Board]: false,
  [ArtifactStatusEditSurface.RowAction]: false,
} as const satisfies Readonly<Record<ArtifactStatusEditSurface, boolean>>;

/** The members of {@link ArtifactStatusEditSurface} that write a priority. */
export type ArtifactPriorityEditSurface = {
  [K in ArtifactStatusEditSurface]: (typeof PRIORITY_EDIT_SURFACE_APPLICABILITY)[K] extends true
    ? K
    : never;
}[ArtifactStatusEditSurface];

/**
 * Whether a named edit surface can have originated a priority write.
 *
 * Takes an already-validated {@link ArtifactStatusEditSurface} rather than
 * `unknown`: the wire boundary is the Zod schema, and a value that never named
 * a real surface must be refused there, not narrowed here.
 */
export function isArtifactPriorityEditSurface(
  value: ArtifactStatusEditSurface
): value is ArtifactPriorityEditSurface {
  return PRIORITY_EDIT_SURFACE_APPLICABILITY[value];
}

/** Derived, never hand-listed — see the table above. */
export const ARTIFACT_PRIORITY_EDIT_SURFACE_VALUES: readonly ArtifactPriorityEditSurface[] =
  Object.values(ArtifactStatusEditSurface).filter(
    isArtifactPriorityEditSurface
  );

/**
 * What a priority telemetry event says about the write it describes.
 *
 * Exactly one member, matching `ArtifactStatusCommitResult` (ISS-9436) and for
 * the same reason: every event that exists today describes a write that
 * COMMITTED, because a no-op re-apply is suppressed before the emit and a
 * refused write never reaches it. Whether a REFUSED attempt earns a receipt at
 * all is an open PRODUCT question, filed as ISS-10176 and deliberately not
 * answered here — so there is no `refused` or `failed` member to reach for.
 * The property is still emitted rather than implied, because absent and
 * `committed` are different claims and only one of them is a measurement.
 */
export const ArtifactPriorityCommitResult = {
  Committed: "committed",
} as const;
export type ArtifactPriorityCommitResult =
  (typeof ArtifactPriorityCommitResult)[keyof typeof ArtifactPriorityCommitResult];
