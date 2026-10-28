"use client";

/**
 * The undo/redo keybinding layer (ISS-9092).
 *
 * One `keydown` listener for the signed-in shell, resolving the chord through
 * the canonical `../../shared/lib/undo-keybinding` table, refusing to act while
 * focus is in something that owns its own undo, and dispatching the registry's
 * inverse as real `apps/api` requests.
 *
 * THE FLAG IS READ HERE AND NOWHERE ELSE. This is the site the swap happens at:
 * with the flag off no listener is attached at all, so a user outside the
 * rollout keeps the browser's and the OS's own Cmd+Z behaviour byte for byte.
 * The boolean is never passed on — a consumer that needs it reads it itself.
 *
 * EVERY PORT IS READ OPTIONALLY. The flag, the stack and the API client each
 * degrade to "absent" rather than throwing, because this layer is mounted in
 * each shell's chrome and shared components also render under mount sites that
 * carry none of those ports (Storybook, mini-table tests). A shortcut layer
 * that crashes a subtree is a worse failure than one that is simply not there,
 * and an absent port is indistinguishable from the closed default anyway.
 *
 * THE SCOPE COMES FROM THE SHELL'S OWN ROUTER, not a prop. `usePath()` resolves
 * through the navigation port both shells inject, so "which surface am I on"
 * has one answer per shell rather than one per mount site.
 *
 * WHAT THIS DOES NOT DO. It does not render. A refusal — an empty stack, or a
 * top entry belonging to a screen the reader is not looking at — is returned by
 * the stack and dropped here, because the reader-facing affordance that should
 * say so is ISS-9093 and is blocked on this ticket. Nothing is pushed onto the
 * stack yet either: capture is ISS-9090's. So today this layer resolves an
 * always-empty stack, which is exactly why it is safe to land ahead of both.
 */

import {
  isUndoableCommand,
  type UndoApiCall,
  UndoApiMethod,
} from "@repo/api/src/types/undo-command";
import { undoRegistryEntryFor } from "@repo/api/src/types/undo-command-registry";
import { usePath } from "@repo/navigation/use-path";
import { useEffect, useRef } from "react";
import type { ApiClient } from "../../shared/api/create-api-client";
import { useApiClientOptional } from "../../shared/api/use-api-client-optional";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import { isEditableEventTarget } from "../../shared/lib/editable-event-target";
import { UNDO_KEYBINDINGS_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import {
  matchUndoShortcut,
  resolveShortcutPlatform,
  UndoShortcutAction,
} from "../../shared/lib/undo-keybinding";
import { UndoRequestStatus, type UndoStackEntry } from "../lib/undo-stack";
import {
  type UndoStackController,
  useUndoStackOptional,
} from "./use-undo-stack";

type UndoCallDispatcher = (
  client: ApiClient,
  call: UndoApiCall
) => Promise<unknown>;

/**
 * How each method the registry may emit becomes a request.
 *
 * An exhaustive `Record` the table is declared against, so a method added to
 * {@link UndoApiMethod} fails `tsc` here rather than resolving to `undefined`
 * at dispatch — which would throw mid-undo, after some calls in the same
 * inverse had already landed.
 */
const UNDO_CALL_DISPATCHERS = {
  [UndoApiMethod.Post]: (client, call) =>
    client.post(call.path, call.body ?? {}),
  [UndoApiMethod.Put]: (client, call) => client.put(call.path, call.body ?? {}),
  [UndoApiMethod.Delete]: (client, call) => client.delete(call.path),
} as const satisfies Readonly<Record<UndoApiMethod, UndoCallDispatcher>>;

/**
 * Run an entry's calls in order, stopping at the first failure.
 *
 * Sequential, not concurrent: a bulk inverse is several grouped calls over
 * overlapping rows, and issuing them together makes the final state depend on
 * which finished last.
 */
async function dispatchUndoCalls(
  client: ApiClient,
  calls: readonly UndoApiCall[]
): Promise<void> {
  for (const call of calls) {
    await UNDO_CALL_DISPATCHERS[call.method](client, call);
  }
}

/**
 * Build the calls for one direction, or `null` when the entry declares itself
 * un-undoable.
 *
 * A non-undoable kind reaching the stack is a capture bug, not a no-op: the
 * registry says outright that no server-side inverse exists, so this refuses
 * rather than dispatching an empty list that would report a successful undo.
 */
function callsFor(
  entry: UndoStackEntry,
  action: UndoShortcutAction
): readonly UndoApiCall[] | null {
  const registryEntry = undoRegistryEntryFor(entry.kind);
  if (!isUndoableCommand(registryEntry)) {
    return null;
  }
  return action === UndoShortcutAction.Undo
    ? registryEntry.inverse(entry.context)
    : registryEntry.forward(entry.context);
}

async function runShortcut(
  action: UndoShortcutAction,
  stack: UndoStackController,
  client: ApiClient,
  scopeKey: string
): Promise<void> {
  const request =
    action === UndoShortcutAction.Undo
      ? stack.resolveUndo(scopeKey)
      : stack.resolveRedo(scopeKey);
  // Empty and out-of-scope both mean "do nothing to the stack". They are kept
  // apart by `UndoRequest` so ISS-9093 can say which; here they are equally
  // inert.
  if (request.status !== UndoRequestStatus.Ready) {
    return;
  }
  const calls = callsFor(request.entry, action);
  if (!calls) {
    return;
  }
  await dispatchUndoCalls(client, calls);
  // Only now. A failed request throws out of the await above, so the entry
  // stays exactly where it was and the stack never claims a mutation was
  // reverted that the server still holds.
  if (action === UndoShortcutAction.Undo) {
    stack.commitUndo(request.entry);
    return;
  }
  stack.commitRedo(request.entry);
}

export function useUndoKeybindings(): void {
  const enabled = useFeatureFlagEnabledOptional(
    UNDO_KEYBINDINGS_FEATURE_FLAG_KEY
  );
  const stack = useUndoStackOptional();
  const client = useApiClientOptional();
  const scopeKey = usePath();

  /**
   * Whether an inverse is already in flight.
   *
   * An undo is a real API round trip, and the stack does not move until it
   * returns (see {@link runShortcut}). So a HELD chord — which auto-repeats at
   * the OS key-repeat rate — and a second deliberate press both re-resolve the
   * SAME still-uncommitted top entry and launch the inverse again. The identity
   * guard in `commitUndo` stops the duplicate stack MOVE, but it cannot recall
   * the duplicate requests: a bulk inverse is several grouped calls, so the
   * second run re-issues every one of them. Worse, if a new mutation lands
   * during the round trip, the server is reverted twice while `commitUndo`
   * refuses to move the now-buried entry, leaving it on the stack to be undone
   * again — a stack that has lied about what it applied.
   *
   * A ref rather than state: the listener is bound once per effect run and must
   * read the CURRENT value, and this must not re-render anything.
   */
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!(enabled && stack && client)) {
      return;
    }
    // Resolved inside the effect, which runs only in a browser/renderer: this
    // module is imported by SSR-capable shared code, and reading `navigator` at
    // render would run on the server during the initial HTML pass.
    const platform = resolveShortcutPlatform(globalThis.navigator?.platform);

    const onKeyDown = (event: KeyboardEvent) => {
      // FIRST, and before the chord is even matched. A text field, a
      // contenteditable, and the Yjs editor each own their own undo; if focus
      // is in one we neither act nor `preventDefault`, so the keystroke reaches
      // the thing the user is actually typing in.
      if (isEditableEventTarget(event.target)) {
        return;
      }
      const action = matchUndoShortcut(event, platform);
      if (!action) {
        return;
      }
      // Claimed BEFORE the serialization bail below, not after. While the layer
      // is enabled it owns this chord, so a repeat or an overlapping press must
      // be dropped by US — letting either fall through to the browser would
      // hand the OS's native undo a keystroke the app had already claimed, and
      // the reader would see one press do nothing and the next one undo their
      // typing somewhere else entirely.
      event.preventDefault();
      if (event.repeat || inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      runShortcut(action, stack, client, scopeKey)
        .catch(() => {
          // Swallowed deliberately, and narrowly: no client-side logging is
          // permitted in this package, and nothing has been committed, so the
          // entry is still on the stack and the chord can be pressed again. The
          // surface that should TELL the reader an undo failed is ISS-9093's.
        })
        .finally(() => {
          // Released on BOTH paths. Clearing it only on success would wedge the
          // layer permanently on the first failed request — the entry stays on
          // the stack for retry, and nothing would be allowed to retry it.
          inFlightRef.current = false;
        });
    };

    globalThis.document.addEventListener("keydown", onKeyDown);
    return () => globalThis.document.removeEventListener("keydown", onKeyDown);
  }, [enabled, stack, client, scopeKey]);
}
