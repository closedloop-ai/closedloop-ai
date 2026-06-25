"use client";

import { useCallback, useState } from "react";

export type ModalSession = {
  /** Whether the modal is currently visible. */
  open: boolean;
  /**
   * Stable mount key for this open session — bumped each time `openModal`
   * is called. Pass this as `key={...}` on the modal so each open mounts a
   * fresh component instance and React resets internal `useState`/`useRef`
   * values for free, instead of the modal having to imperatively reset
   * itself on close/submit.
   */
  mountKey: number;
  openModal: () => void;
  closeModal: () => void;
  /**
   * Convenience handler shaped like Radix Dialog's `onOpenChange`. Opening
   * bumps `mountKey` so consumers can wire it directly:
   *   `<Dialog onOpenChange={session.onOpenChange} open={session.open} />`.
   */
  onOpenChange: (next: boolean) => void;
};

/**
 * State container for a one-shot modal session.
 *
 * The mount-key pattern means the modal never needs imperative reset logic:
 * `key={mountKey}` on the modal forces React to discard the prior instance
 * and remount fresh on each open. Internal form state, refs, and effects
 * all start from their initial values automatically.
 *
 * Use when a modal has non-trivial internal state (form fields, caches,
 * pre-fill effects) that should not persist across opens.
 */
export function useModalSession(initialOpen = false): ModalSession {
  const [open, setOpen] = useState(initialOpen);
  const [mountKey, setMountKey] = useState(0);

  const openModal = useCallback(() => {
    setMountKey((k) => k + 1);
    setOpen(true);
  }, []);
  const closeModal = useCallback(() => setOpen(false), []);
  const onOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        openModal();
      } else {
        closeModal();
      }
    },
    [openModal, closeModal]
  );

  return { open, mountKey, openModal, closeModal, onOpenChange };
}

export type BooleanModalState = {
  open: boolean;
  setOpen: (next: boolean) => void;
  openModal: () => void;
  closeModal: () => void;
};

/**
 * State container for a simple boolean modal — no mount-key reset semantics.
 *
 * Use this when the modal's internal state is trivial (or owned by a child
 * via `key={...}` on a stable id) and you only need open/close control.
 * For modals that need a fresh mount per open (form-heavy with pre-fill),
 * use `useModalSession` instead.
 */
export function useBooleanModal(initialOpen = false): BooleanModalState {
  const [open, setOpen] = useState(initialOpen);
  const openModal = useCallback(() => setOpen(true), []);
  const closeModal = useCallback(() => setOpen(false), []);
  return { open, setOpen, openModal, closeModal };
}
