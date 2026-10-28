"use client";

import { useCallback, useRef, useState } from "react";
import type { CommentsPaneDraft } from "./comments-pane-model";

export type CommentsPaneWriteError = {
  error: unknown;
  /** The draft or action key that failed, e.g. `new-thread`, `resolve:<threadId>`. */
  key: string;
};

export type SubmitWrite = (
  key: string,
  operation: () => Promise<void> | void,
  options?: SubmitOptions
) => void;

type SubmitOptions = {
  /** Clear the composer draft under `key` once the write lands. */
  clearDraft?: boolean;
};

/**
 * Runs each write once at a time per key. The ref, not the state, is the
 * guard: two clicks in one tick both read the same render's state. Writes
 * that settle after `identity` changed are dropped, so one entity's success
 * can never clear the next entity's draft.
 *
 * "Changed" is a generation, not a value: every identity change starts a new
 * pending set, and a write settles only into the set it started in. Comparing
 * identity values would let A → B → A revive a write from the first visit to
 * A and clear the draft typed on the second.
 */
export function usePendingSubmissions({
  externalPending,
  identity,
  onDraftChange,
  onWriteError,
}: {
  externalPending: readonly string[] | undefined;
  identity: string | undefined;
  onDraftChange: (key: string, draft: CommentsPaneDraft | null) => void;
  onWriteError?: (failure: CommentsPaneWriteError) => void;
}) {
  const pendingRef = useRef(new Set<string>());
  const identityRef = useRef(identity);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingIdentity, setPendingIdentity] = useState(identity);
  if (pendingIdentity !== identity) {
    setPendingIdentity(identity);
    setPending(new Set());
  }
  if (identityRef.current !== identity) {
    identityRef.current = identity;
    pendingRef.current = new Set();
  }

  const submit = useCallback<SubmitWrite>(
    (
      key: string,
      operation: () => Promise<void> | void,
      { clearDraft = true }: SubmitOptions = {}
    ) => {
      if (pendingRef.current.has(key) || externalPending?.includes(key)) {
        return;
      }
      const pendingSet = pendingRef.current;
      pendingSet.add(key);
      setPending(new Set(pendingSet));
      const settle = () => {
        if (pendingRef.current !== pendingSet) {
          return false;
        }
        pendingSet.delete(key);
        setPending(new Set(pendingSet));
        return true;
      };
      const fail = (error: unknown) => {
        // A failed write keeps the draft for the retry, and the host hears about it.
        if (settle()) {
          onWriteError?.({ error, key });
        }
      };
      let result: Promise<void> | void;
      try {
        result = operation();
      } catch (error) {
        fail(error);
        return;
      }
      Promise.resolve(result).then(() => {
        if (settle() && clearDraft) {
          onDraftChange(key, null);
        }
      }, fail);
    },
    [externalPending, onDraftChange, onWriteError]
  );

  const isPending = useCallback(
    (key: string) =>
      pending.has(key) || Boolean(externalPending?.includes(key)),
    [externalPending, pending]
  );

  return { isPending, submit };
}
