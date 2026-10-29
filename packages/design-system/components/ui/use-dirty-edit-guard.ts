"use client";

import { useEffect, useRef } from "react";

/**
 * Holds an inline field's commit-on-blur rule across a HOST transition — a
 * route change, a page of rows swapping out, a flag flipping the cell back to
 * its predecessor, a refresh.
 *
 * None of those deliver the blur that rule is built on. React detaches the
 * handler before the node leaves the tree, and a refresh tears the page down
 * mid-keystroke, so the draft a click elsewhere would have saved is dropped
 * with nothing on screen saying so. This is that same rule on the paths the
 * browser leaves uncovered, not a second rule beside it.
 *
 * **Both inputs are functions, and that is the load-bearing part.** They are
 * asked at teardown and at `beforeunload`, never at render, so neither answer
 * can be a render behind. A commit that changes nothing React is watching —
 * an already-`true` `setEditing`, a clean settle the ledger resolves in
 * silence — produces no re-render at all, and a guard keyed on a RENDERED
 * boolean would go on warning about an edit that saved long ago, for the rest
 * of the session. Read your refs inside these.
 *
 * `hasUncommittedEdit` and `commit` must answer the SAME question — one is
 * whether a commit would fire, the other fires it. Keeping them one predicate
 * is what stops the warning and the write disagreeing.
 *
 * The refresh warning is the browser's own dialog and carries no wording of
 * ours: every engine ignores a supplied string. Electron has no such dialog, so
 * the warning is not armed there; the teardown commit is.
 */
export function useDirtyEditGuard({
  hasUncommittedEdit,
  commit,
}: DirtyEditGuard): void {
  const latestRef = useRef({ hasUncommittedEdit, commit });

  useEffect(() => {
    latestRef.current = { hasUncommittedEdit, commit };
  });

  useEffect(
    () => () => {
      latestRef.current.commit();
    },
    []
  );

  useEffect(() => {
    // A prevented unload in Electron shows nothing: unless the main process
    // handles `will-prevent-unload`, the reload, close, or quit is silently
    // cancelled for as long as a field is dirty.
    if (globalThis.navigator.userAgent.includes("Electron")) {
      return;
    }
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (latestRef.current.hasUncommittedEdit()) {
        event.preventDefault();
      }
    };
    globalThis.window.addEventListener("beforeunload", warnBeforeUnload);
    return () =>
      globalThis.window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);
}

export type DirtyEditGuard = Readonly<{
  /**
   * Whether the field holds typing a commit would send. Asked at the moment it
   * matters, so read refs inside it rather than closing over state.
   */
  hasUncommittedEdit: () => boolean;
  /**
   * Sends that typing. Called once as the field goes away, re-checking the
   * same guards then: a value the live path would have refused — unparseable,
   * empty where empty is not allowed, already sent, cancelled — must not be
   * persisted just because the host moved.
   */
  commit: () => void;
}>;
