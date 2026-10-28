"use client";

import { useUndoKeybindings } from "../hooks/use-undo-keybindings";

/**
 * The headless mount for the undo/redo keybinding layer (ISS-9092).
 *
 * Renders no DOM. It exists so each shell mounts ONE well-named thing inside
 * its own provider stack rather than calling the hook from a component that
 * has another job — and so a shell cannot accidentally mount it twice and bind
 * two listeners to the same chord.
 *
 * Mount it inside the navigation, auth, API and feature-flag ports, and inside
 * {@link UndoStackProvider}; the hook resolves all five itself.
 */
export function UndoKeybindingLayer() {
  useUndoKeybindings();
  return null;
}
