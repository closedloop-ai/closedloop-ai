"use client";

import { useMemo, useRef } from "react";

/**
 * The out-of-order commit ledger shared by every inline-edit cell.
 *
 * Extracted from `InlineScalarCell` when the `date` variant arrived: a date
 * picker and a text input disagree about almost everything (draft, blur,
 * Escape), but they owe the reader the SAME promise about a refused write, and
 * a second copy of this reasoning is how the two would quietly stop keeping it.
 *
 * **Rollback restores a CONFIRMED value, never an optimistic one.** Commits
 * settle out of order, so the ledger keeps the last accepted value plus every
 * commit still in flight, each carrying a monotonic token, and on each settle
 * re-resolves to the newest fact still standing. A rejection therefore cannot
 * overwrite a newer value that saved, cannot leave behind a value that was
 * itself refused a moment later, and cannot roll back a value the parent has
 * since handed down authoritatively through {@link CommitLedger.reset}. A
 * reset equal to a pending submission is that mutation's own optimistic host
 * echo, and a reset back to the confirmed value while a submission is pending
 * is that host's rollback; neither is a newer fact, so both leave the attempt
 * authoritative until it settles.
 *
 * **The value type is the caller's.** A scalar cell commits a string and a
 * multi-select commits the whole next set; the ledger only ever compares
 * ENTRIES by their token and resolved value by identity, so the element type is
 * the caller's business. A caller committing a fresh array per pick therefore
 * gets exactly the ordering guarantees below, because each submit records its
 * own instance.
 *
 * A lone "is this still the latest commit?" token cannot do this: reject the
 * newer of two commits and it restores the older OPTIMISTIC value, then drops
 * the older commit's own rejection as stale, leaving a value on screen that was
 * never saved.
 */
export function useCommitLedger<T = string>(
  initialValue: T,
  isEqual: (left: T, right: T) => boolean = sameValue
): CommitLedger<T> {
  const nextTokenRef = useRef(0);
  const confirmedRef = useRef<CommitEntry<T>>({ token: 0, value: initialValue });
  const pendingRef = useRef<CommitEntry<T>[]>([]);
  const committedRef = useRef(initialValue);

  return useMemo<CommitLedger<T>>(
    () => ({
      current: () => committedRef.current,

      reset: (value: T) => {
        // A mutation host commonly echoes its own optimistic patch through the
        // value prop before the write settles. That echo is not a newer fact:
        // treating it as one makes the eventual refusal non-authoritative and
        // erases the rejected draft before the field can report the failure.
        // Nor is a host rolling its own optimistic patch back to the confirmed
        // value before this ledger has heard the refusal: nothing newer
        // happened, and superseding would hide that refusal the same way.
        if (
          pendingRef.current.some((entry) => isEqual(entry.value, value)) ||
          (pendingRef.current.length > 0 &&
            isEqual(value, confirmedRef.current.value))
        ) {
          return;
        }
        nextTokenRef.current += 1;
        confirmedRef.current = { token: nextTokenRef.current, value };
        pendingRef.current = [];
        committedRef.current = value;
      },

      replace: (value: T) => {
        nextTokenRef.current += 1;
        confirmedRef.current = { token: nextTokenRef.current, value };
        pendingRef.current = [];
        committedRef.current = value;
      },

      submit: (next, onCommit, onResolved, onSettled) => {
        nextTokenRef.current += 1;
        const entry: CommitEntry<T> = { token: nextTokenRef.current, value: next };
        pendingRef.current = [...pendingRef.current, entry];
        committedRef.current = next;

        const settle = (accepted: boolean) => {
          pendingRef.current = pendingRef.current.filter(
            (candidate) => candidate.token !== entry.token
          );
          if (accepted && entry.token > confirmedRef.current.token) {
            confirmedRef.current = entry;
          }
          const resolvedEntry = highestFact(
            confirmedRef.current,
            pendingRef.current
          );
          const resolved = resolvedEntry.value;
          const authoritative = entry.token === nextTokenRef.current;
          onSettled?.({
            accepted,
            authoritative,
            submitted: entry.value,
          });
          if (resolved === committedRef.current) {
            return;
          }
          // A grid that keeps showing what the server refused is a UI lying
          // about the data, so the field falls back to the newest fact that
          // outlived this commit — another in-flight value, or the last
          // confirmed one.
          committedRef.current = resolved;
          onResolved(resolved);
        };

        try {
          // `Promise.resolve` assimilates every shape `onCommit` can return: a
          // native promise, a cross-realm one (an iframe or a vm context, where
          // `instanceof Promise` is false), any thenable, or a plain `void`.
          // The `try` catches the remaining shape — a synchronous throw, which
          // would otherwise escape with `next` already recorded as committed.
          Promise.resolve(onCommit(next)).then(
            () => settle(true),
            () => settle(false)
          );
        } catch {
          settle(false);
        }
      },
    }),
    [isEqual]
  );
}

export type CommitLedger<T = string> = Readonly<{
  /** The value the field stands behind as of *now*, not as of the last render. */
  current: () => T;
  /**
   * Records a value the parent handed down authoritatively (a refetch, another
   * user's edit) above every commit in flight, so a rejection arriving
   * afterwards can no longer roll it back to what this cell was showing. While
   * a submission is pending, a value equal to it (its optimistic host echo) or
   * to the confirmed value (the host's rollback) does not supersede it.
   */
  reset: (value: T) => void;
  /** Replaces all facts when the host switches to a different entity scope. */
  replace: (value: T) => void;
  /**
   * Records `next` as committed and runs `onCommit`. `onResolved` fires only
   * when a settle changes what the field must show — pass the state update that
   * repaints the cell.
   */
  submit: (
    next: T,
    onCommit: (next: T) => Promise<unknown> | void,
    onResolved: (resolved: T) => void,
    onSettled?: (result: CommitSettlement<T>) => void
  ) => void;
}>;

export type CommitSettlement<T> = Readonly<{
  accepted: boolean;
  /** Whether no later submission or authoritative reset superseded this attempt. */
  authoritative: boolean;
  submitted: T;
}>;

/** One commit, ordered against the others by a monotonic token. */
type CommitEntry<T> = Readonly<{ token: number; value: T }>;

/**
 * The value the field should show: the newest fact still standing. A commit
 * that is still in flight outranks an older confirmation (the user's latest
 * intent is what the field owes them), and a newer confirmation outranks an
 * older in-flight commit (the server has already spoken about a later value).
 */
function highestFact<T>(
  confirmed: CommitEntry<T>,
  pending: CommitEntry<T>[]
): CommitEntry<T> {
  let best = confirmed;
  for (const entry of pending) {
    if (entry.token > best.token) {
      best = entry;
    }
  }
  return best;
}

/**
 * Element-wise equality for the array-valued cells. A host rebuilds its id
 * array on every refetch, so an echo of a pending or confirmed set arrives as
 * a new instance; compared by identity it would read as a newer fact and drop
 * the selection still queued behind it.
 */
export function sameOrderedValues(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameValue<T>(left: T, right: T): boolean {
  return left === right;
}
