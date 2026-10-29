"use client";

import { refocusInlineEditControlIfOwned } from "@repo/design-system/components/ui/inline-edit-feedback";
import { useCommitLedger } from "@repo/design-system/components/ui/use-commit-ledger";
import { useDirtyEditGuard } from "@repo/design-system/components/ui/use-dirty-edit-guard";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export const InlineEditErrorKind = {
  Save: "save",
  Validation: "validation",
} as const;
export type InlineEditErrorKind =
  (typeof InlineEditErrorKind)[keyof typeof InlineEditErrorKind];

type UseInlineEditOptions = {
  /** Stable identity of the entity whose field is being edited. */
  scopeKey: string;
  initialValue: string;
  /**
   * `expectedValue` is the value the server last confirmed, for the optimistic
   * guard the write carries (ISS-11198). `undefined` while an earlier save is
   * still in flight: the ledger's value is optimistic then, so the write goes
   * unguarded rather than assert a value the server may never hold.
   */
  onSave: InlineEditSave;
  onChange?: (newValue: string) => void;
  allowEmpty?: boolean;
  emptyErrorMessage?: string;
  /** Existing product copy shown beside the field when persistence refuses. */
  saveErrorMessage: string;
};

/**
 * The always-mounted sibling of `InlineScalarCell`
 * (`packages/design-system/components/ui/inline-scalar-cell.tsx`): a title or
 * description field that is a live input at all times rather than a grid cell
 * you click into. It reads that cell's `useCommitLedger` and
 * `useDirtyEditGuard` rather than restating how commits are ordered, when one
 * is a duplicate, or what a host transition owes the user.
 *
 * A refusal keeps the user's typing in the field, associates the host-owned
 * error with it, and restores focus for correction. The shared ledger still
 * holds the confirmed value, so Escape returns to authoritative data. That
 * typing remains uncommitted, so a later blur or host transition retries it.
 */
export function useInlineEdit<
  T extends HTMLInputElement | HTMLTextAreaElement,
>({
  initialValue,
  scopeKey,
  onSave,
  onChange,
  allowEmpty = false,
  emptyErrorMessage,
  saveErrorMessage,
}: UseInlineEditOptions) {
  const feedbackOwnerMountedRef = useRef(true);
  useEffect(() => {
    feedbackOwnerMountedRef.current = true;
    return () => {
      feedbackOwnerMountedRef.current = false;
    };
  }, []);
  const [value, setValue] = useState(initialValue);
  const [inputValue, setInputValueState] = useState(initialValue);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<InlineEditError | null>(null);
  const errorMessageId = useId();
  const inputRef = useRef<T>(null);
  // Every reset here (Escape or a prop sync) lands a render away. A host that
  // dismisses on that same Escape unmounts the field in the same batch, so the
  // reset never renders and a teardown reading state would commit what Escape
  // discarded. This is what is true by then.
  const draftRef = useRef(initialValue);
  const setInputValue = (next: string) => {
    draftRef.current = next;
    setInputValueState(next);
    if (
      error?.kind === InlineEditErrorKind.Validation ||
      (error !== null && next.trim() === ledger.current())
    ) {
      setError(null);
    }
  };
  // handleCancel blurs the field to dismiss it, which fires the onBlur=>save
  // handler before the reset setInputValue has flushed. This flag tells that
  // save to no-op so Escape cancels instead of committing the edited value.
  const cancellingRef = useRef(false);
  // Enter saves without blurring, so the blur that follows saves again while
  // the first mutation is still in flight and `value` still holds the old
  // title. The ledger records the submitted value NOW, which is the only thing
  // the second pass can compare against without waiting for a round trip.
  const ledger = useCommitLedger(initialValue);
  // Saves not yet settled. While one is, `ledger.current()` is that save's
  // optimistic value, and guarding the next save on it would refuse that save
  // whenever the first one fails or reaches the row after it (marisolashgrove
  // review, PR #7924). A count, because a reset does not settle a save.
  const savesInFlightRef = useRef(0);
  const scopeKeyRef = useRef(scopeKey);
  const scopeVersionRef = useRef(0);
  const nextAcceptedTokenRef = useRef(0);
  const latestAcceptedTokenRef = useRef(0);
  const scopeOnSaveRef = useRef(onSave);

  // One mounted host can navigate from entity A to entity B. Draft, refusal
  // and pending ownership belong to A and must be reset together before the
  // field can commit through B's mutation closure.
  useLayoutEffect(() => {
    if (scopeKeyRef.current === scopeKey) {
      scopeOnSaveRef.current = onSave;
      return;
    }
    const departingDraft = draftRef.current;
    if (
      isUncommittedInlineEdit(
        departingDraft,
        value,
        allowEmpty,
        ledger.current()
      )
    ) {
      const expectedValue =
        savesInFlightRef.current === 0 ? ledger.current() : undefined;
      scopeOnSaveRef
        .current(departingDraft.trim(), expectedValue)
        .catch(ignoreDepartedSaveFailure);
    }
    scopeKeyRef.current = scopeKey;
    scopeOnSaveRef.current = onSave;
    scopeVersionRef.current += 1;
    nextAcceptedTokenRef.current = 0;
    latestAcceptedTokenRef.current = 0;
    savesInFlightRef.current = 0;
    cancellingRef.current = false;
    ledger.replace(initialValue);
    draftRef.current = initialValue;
    setValue(initialValue);
    setInputValueState(initialValue);
    setIsPending(false);
    setError(null);
  }, [allowEmpty, initialValue, ledger, onSave, scopeKey, value]);

  // Sync with prop changes (e.g., from server updates). The ledger decides
  // whether the value is an optimistic echo of its own pending submission or
  // a newer authoritative value that supersedes that submission.
  //
  // It replaces the FIELD only while the user is editing it — focused, with
  // typing a save would send (ISS-9589): replacing it mid-edit threw that
  // typing away. Held, the new value is what Escape returns to and what the
  // ledger falls back on when a save is refused, while the next save sends the
  // typing over it. Focus is part of the question because a refusal may leave
  // its typing in an unfocused field when the user has already moved
  // elsewhere; holding there would pin a field nobody is editing against every
  // later update. "Would send" compares TRIMMED, as the save does: a draft
  // that differs only by whitespace is no change, and holding it would let the
  // blur write the old value back over the new one.
  // The save that sends the typing carries the held value as its expected
  // value, so the server does not refuse it; only a value this field was never
  // handed is refused (ISS-11198). A save made while another is in flight
  // carries no expected value at all (`savesInFlightRef`).
  //
  // A LAYOUT effect, because a passive one can flush after the next Enter or
  // blur (whitlockk review, PR #7836): that save advances the ledger to the draft,
  // the typing then reads as sent, and the field shows the value it was typed
  // over while the typing is what was saved.
  useLayoutEffect(() => {
    const input = inputRef.current;
    const draft = draftRef.current;
    const holdsTyping =
      input !== null &&
      input.ownerDocument.activeElement === input &&
      draft !== ledger.current() &&
      draft.trim() !== ledger.current();
    latestAcceptedTokenRef.current = ++nextAcceptedTokenRef.current;
    ledger.reset(initialValue);
    setValue(initialValue);
    if (!holdsTyping) {
      draftRef.current = initialValue;
      setInputValueState(initialValue);
    }
  }, [initialValue, ledger]);

  // A refused save re-opens the active correction point after the pending
  // state releases the disabled input only while focus still belongs to this
  // edit. A later response must not steal focus from another control.
  useLayoutEffect(() => {
    if (error?.kind === InlineEditErrorKind.Save && !isPending) {
      refocusInlineEditControlIfOwned(inputRef.current);
    }
  }, [error, isPending]);

  const submit = (trimmedValue: string, save: InlineEditSave = onSave) => {
    const submissionScope = scopeVersionRef.current;
    const recoverableErrorOwner = () =>
      feedbackOwnerMountedRef.current &&
      scopeVersionRef.current === submissionScope;
    const acceptedToken = ++nextAcceptedTokenRef.current;
    setIsPending(true);
    setError(null);
    const expectedValue =
      savesInFlightRef.current === 0 ? ledger.current() : undefined;
    savesInFlightRef.current += 1;
    ledger.submit(
      trimmedValue,
      (next) =>
        save(next, expectedValue, recoverableErrorOwner).finally(() => {
          if (scopeVersionRef.current !== submissionScope) {
            return;
          }
          savesInFlightRef.current -= 1;
          setIsPending(false);
        }),
      keepTheUsersTyping,
      ({ accepted, authoritative, submitted }) => {
        if (scopeVersionRef.current !== submissionScope) {
          return;
        }
        if (accepted && acceptedToken > latestAcceptedTokenRef.current) {
          latestAcceptedTokenRef.current = acceptedToken;
          setValue(submitted);
          onChange?.(submitted);
        }
        if (accepted && authoritative) {
          setError(null);
        } else if (authoritative) {
          setError({
            kind: InlineEditErrorKind.Save,
            message: saveErrorMessage,
          });
        }
      }
    );
  };

  const handleSave = (nextFocus?: EventTarget | null) => {
    // A blur triggered by handleCancel must not commit the edit.
    if (cancellingRef.current) {
      cancellingRef.current = false;
      return;
    }

    const trimmedValue = inputValue.trim();

    // Validation: prevent empty values when not allowed
    if (!(trimmedValue || allowEmpty)) {
      if (emptyErrorMessage) {
        setError({
          kind: InlineEditErrorKind.Validation,
          message: emptyErrorMessage,
        });
      }
      if (nextFocus == null || nextFocus === inputRef.current) {
        refocusInlineEditControlIfOwned(inputRef.current);
      }
      return;
    }

    if (trimmedValue === ledger.current()) {
      setError(null);
      return;
    }

    submit(trimmedValue);
  };

  // Both resets go to the LEDGER's value, not `value`. Enter saves without
  // blurring, so the field can still be focused while that save is in flight
  // and `value` still holds the title before it; reverting to that would put an
  // older title in the draft, and the teardown would then write it back over
  // the one that saved.
  const handleCancel = () => {
    cancellingRef.current = true;
    setError(null);
    setInputValue(ledger.current());
    inputRef.current?.blur();
  };

  // Navigating away, or the host swapping this field out, unmounts the input
  // without ever firing the blur that would have saved it. A cancelled edit is
  // already back to `value` by then and so reads as clean, which is how Escape
  // keeps meaning Escape across the same transition.
  //
  // Both questions below start from RAW equality against the value this field
  // was handed. Comparing a trimmed draft to it instead would call a title that
  // merely arrived with a stray space dirty before anyone touched the page —
  // arming the refresh warning and PATCHing a trim on the way out, on every
  // visit. `normalizeTitle` collapses newlines and never trims, and nothing
  // else on the write path does either, so such titles are ordinary.
  // One predicate for the warning and the write, reading the ref so neither is
  // a render behind. Raw equality against the value this field was handed
  // comes FIRST; the trimmed checks then ask exactly what a blur asks — would
  // this actually save? Get that order wrong in either direction and the
  // warning stops being clearable: trim the left side alone and a title that
  // merely arrived with a stray space is dirty before anyone touches the page,
  // compare raw alone and a trailing space typed onto an otherwise unchanged
  // title warns forever, because the blur that would clear it declines to save.
  const hasUncommittedEdit = () => {
    const draft = draftRef.current;
    return isUncommittedInlineEdit(draft, value, allowEmpty, ledger.current());
  };

  useDirtyEditGuard({
    hasUncommittedEdit,
    commit: () => {
      if (hasUncommittedEdit()) {
        submit(draftRef.current.trim(), scopeOnSaveRef.current);
      }
    },
  });

  return {
    value,
    inputValue,
    setInputValue,
    inputRef,
    isPending,
    error,
    errorMessageId,
    handleSave,
    handleCancel,
  };
}

export type InlineEditError = Readonly<{
  kind: InlineEditErrorKind;
  message: string;
}>;

function keepTheUsersTyping() {
  // The draft is the user's unsaved input, while the ledger restores its own
  // confirmed baseline. Keeping the DOM draft lets the next blur retry it and
  // Escape still returns to the ledger's authoritative value.
}

function isUncommittedInlineEdit(
  draft: string,
  confirmedValue: string,
  allowEmpty: boolean,
  ledgerValue: string
): boolean {
  const trimmedValue = draft.trim();
  return (
    draft !== confirmedValue &&
    Boolean(trimmedValue || allowEmpty) &&
    trimmedValue !== ledgerValue
  );
}

function ignoreDepartedSaveFailure() {
  // Entity B must not render entity A's late settlement.
}

type InlineEditSave = (
  trimmedValue: string,
  expectedValue: string | undefined,
  recoverableErrorOwner?: () => boolean
) => Promise<unknown>;
