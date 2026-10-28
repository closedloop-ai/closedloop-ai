"use client";

/**
 * The session's undo stack, as a mounted port (ISS-9092).
 *
 * Holds the ONE stack described in `../lib/undo-stack.ts` and exposes what a
 * caller needs: append a performed mutation, ask what a chord would do here,
 * and commit a move once the inverse has actually run.
 *
 * COMMIT IS SEPARATE FROM RESOLVE ON PURPOSE. An undo is a real API round trip,
 * so a provider that popped the entry at resolve time would report the mutation
 * reverted while the request was still in flight — and leave it reported
 * reverted if the request failed. Nothing moves until the caller says the
 * server agreed.
 *
 * IN-MEMORY, AND THAT IS ISS-9090's SEAM. This state does not survive a reload
 * and a second tab has its own; the persisted action log is ISS-9090's ticket.
 * It attaches here in two places and nowhere else: the `useState` initial value
 * would seed `past` from the log instead of {@link EMPTY_UNDO_STACK}, and
 * {@link UndoStackController.push} would write through to it. No port is
 * stubbed for that — an unused interface would be dead code asserting a storage
 * shape ISS-9090 has not chosen.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  commitRedo,
  commitUndo,
  EMPTY_UNDO_STACK,
  pushUndoEntry,
  resolveRedoRequest,
  resolveUndoRequest,
  type UndoRequest,
  type UndoStackEntry,
  type UndoStackState,
} from "../lib/undo-stack";

export type UndoStackController = {
  /** Record a performed mutation. ISS-9090's capture is the caller. */
  push: (entry: UndoStackEntry) => void;
  /** What the undo chord would do on the surface identified by `scopeKey`. */
  resolveUndo: (scopeKey: string) => UndoRequest;
  /** What the redo chord would do on the surface identified by `scopeKey`. */
  resolveRedo: (scopeKey: string) => UndoRequest;
  /** Move `entry` from past to future — only after its inverse succeeded. */
  commitUndo: (entry: UndoStackEntry) => void;
  /** Move `entry` from future to past — only after its forward succeeded. */
  commitRedo: (entry: UndoStackEntry) => void;
};

const UndoStackContext = createContext<UndoStackController | null>(null);

export function UndoStackProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UndoStackState>(EMPTY_UNDO_STACK);

  /**
   * The stack as the RESOLVERS read it.
   *
   * A ref, not the render's `state`, because the keydown listener is bound once
   * per effect run and would otherwise answer from whatever the stack was when
   * that listener was created. Kept in step during render rather than in an
   * effect so a resolve issued in the same commit sees the value the render
   * already has.
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  const resolveUndo = useCallback(
    (scopeKey: string) => resolveUndoRequest(stateRef.current, scopeKey),
    []
  );
  const resolveRedo = useCallback(
    (scopeKey: string) => resolveRedoRequest(stateRef.current, scopeKey),
    []
  );

  const controller = useMemo<UndoStackController>(
    () => ({
      push: (entry) => setState((previous) => pushUndoEntry(previous, entry)),
      resolveUndo,
      resolveRedo,
      commitUndo: (entry) =>
        setState((previous) => commitUndo(previous, entry)),
      commitRedo: (entry) =>
        setState((previous) => commitRedo(previous, entry)),
    }),
    [resolveUndo, resolveRedo]
  );

  return <UndoStackContext value={controller}>{children}</UndoStackContext>;
}

/**
 * The stack, or `null` where no provider is mounted.
 *
 * Optional rather than throwing: each shell mounts the provider beside the
 * keybinding layer, but shared components also render under mount sites that
 * have neither (Storybook, mini-table tests), and a shortcut layer that crashes
 * a story subtree is a worse failure than one that is simply absent there.
 */
export function useUndoStackOptional(): UndoStackController | null {
  return useContext(UndoStackContext);
}
