/**
 * ISS-5474: this module used to also own `getStatusMessage`, the human copy
 * ("Executing plan and creating PR...", "Generation failed", …) rendered by the
 * generation-status banner and indicator. Those surfaces are gone along with
 * the rest of the user-facing Loop/run-state UI, so the copy went with them.
 * What is left gates ACTIONS, not presentation.
 */
import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/document";

/**
 * Per-command disabled predicate for run-loop menu items.
 *
 * Returns true (disabled) when:
 * - A local mutation is pending (`localMutationPending`), OR
 * - The generation-status fetch is still loading (`isLoading`), OR
 * - The generation-status poll reports an active loop matching `targetCommand`.
 *
 * Unrelated commands (active loop for command A does NOT disable command B).
 */
export function isCommandDisabled(opts: {
  generationStatus: GenerationStatus | undefined;
  isLoading: boolean;
  targetCommand: GenerationStatus["command"];
  localMutationPending?: boolean;
}): boolean {
  const {
    generationStatus,
    isLoading,
    targetCommand,
    localMutationPending = false,
  } = opts;

  return (
    localMutationPending ||
    isLoading ||
    isRunInFlightForCommand({ generationStatus, targetCommand })
  );
}

/**
 * ISS-5508: the ONE of {@link isCommandDisabled}'s three causes that a user can
 * be told about honestly — the poll reports a run of `targetCommand` still going.
 *
 * Kept separate from the disabled predicate on purpose. The other two causes are
 * a pending local mutation (transient, resolves in a round trip) and a
 * still-loading status fetch (says nothing about whether a run exists). Driving
 * an explanation off `isCommandDisabled` would assert an in-flight run on both,
 * which is exactly the lie the ticket is about, in the other direction.
 *
 * This is a gate on an ACTION, not a presentation of run state: it exposes no
 * run identity, status, outcome, or link.
 *
 * Deliberately does NOT also exclude `isLoading`, and that rests on an invariant
 * worth stating: `useDocumentGenerationStatus` is a plain `useQuery`, so its
 * loading flag is true only while `data` is undefined. A populated
 * `generationStatus` therefore implies the fetch has landed, and the two causes
 * cannot both hold. A caller that swapped in a source which stays loading with
 * data present would reintroduce the conflation this split exists to prevent.
 */
export function isRunInFlightForCommand(opts: {
  generationStatus: GenerationStatus | undefined;
  targetCommand: GenerationStatus["command"];
}): boolean {
  const { generationStatus, targetCommand } = opts;

  return (
    generationStatus != null &&
    generationStatus.command === targetCommand &&
    isActiveGenerationStatus(generationStatus.status)
  );
}

/**
 * {@link isRunInFlightForCommand} without the command check: is there a run
 * going at all, whatever it is.
 *
 * Deliberately a sibling in this module rather than a second predicate declared
 * next to its one consumer — the two differ by a single clause, and two
 * run-in-flight predicates in two modules drift.
 *
 * Unlike its sibling this one IS allowed to drive presentation: it gates the
 * artifact in-flight treatment, which is a flagged surface built to show run
 * state, not a control whose disabled-ness has to be explained. What the
 * treatment may then CLAIM is a separate question the copy answers — the active
 * set spans `PENDING | QUEUED | RUNNING`, so "there is a run" is the most this
 * predicate ever establishes, and never that work has begun.
 */
export function isRunInFlight(
  generationStatus: GenerationStatus | undefined
): boolean {
  return (
    generationStatus != null &&
    isActiveGenerationStatus(generationStatus.status)
  );
}
