/**
 * Cross-surface undo stack semantics (ISS-9092).
 *
 * ## ONE STACK, SCOPED ENTRIES
 *
 * The ruling the ticket demanded: there is ONE stack for the signed-in session,
 * not one per screen, and every entry records the SCOPE it was performed on.
 * Cmd+Z applies the top entry only when that entry's scope is the scope the
 * reader is looking at now. When it is not, the request is REFUSED and names
 * why — it does not silently skip down the stack looking for an in-scope entry,
 * and it does not quietly do nothing.
 *
 * Per-surface stacks were the alternative and are worse for the same reason:
 * "undo" would then mean a different thing on each screen, and an action taken
 * on one screen would become permanently unreachable the moment the reader
 * navigated, with no signal that it had been stranded.
 *
 * ## THE READER MUST NEVER UNDO SOMETHING THEY CANNOT SEE
 *
 * That is the whole reason for the scope check. An artifact whose status the
 * reader changed on the Sessions board, reverted while they are reading a
 * document, produces a mutation with no visible consequence — the classic "my
 * data changed and I do not know what I did" report. So
 * {@link UndoRequestStatus.OutOfScope} is a first-class outcome carrying the
 * entry, so a caller can say WHERE the action happened rather than rendering a
 * dead key. Rendering that refusal is ISS-9093's job; deciding it is this
 * module's.
 *
 * ## WHERE THE PERSISTED LOG ATTACHES (ISS-9090, not yet built)
 *
 * This state is in-memory and therefore session- and window-scoped: it does not
 * survive a reload, and a second tab has its own. That is a deliberate
 * limitation of THIS ticket, not a design: ISS-9090 owns the persisted action
 * log. It attaches at exactly two seams and needs no change to the semantics
 * here, because this module is pure —
 *   1. HYDRATION: `past` is seeded from the log at provider mount instead of
 *      starting empty, and
 *   2. APPEND: each {@link pushUndoEntry} result is written through to the log.
 * Neither seam is stubbed here. An unused port would be dead code that a reader
 * would mistake for a contract ISS-9090 has agreed to, and the storage shape is
 * that ticket's decision to make, not this one's.
 */

import type {
  UndoCommandContext,
  UndoMutationKind,
} from "@repo/api/src/types/undo-command";

/**
 * One performed, undoable mutation.
 *
 * `scopeKey` is the surface the reader was on — an opaque string the shell
 * supplies (a route key). Opaque on purpose: this module compares it and never
 * parses it, so a shell can change how it names a surface without this
 * contract moving.
 *
 * `context` is the registry's {@link UndoCommandContext}, captured BEFORE the
 * forward call ran, because the prior value cannot be re-derived afterwards.
 */
export type UndoStackEntry = {
  readonly id: string;
  readonly kind: UndoMutationKind;
  readonly scopeKey: string;
  readonly label: string;
  readonly context: UndoCommandContext;
};

export type UndoStackState = {
  readonly past: readonly UndoStackEntry[];
  readonly future: readonly UndoStackEntry[];
};

export const EMPTY_UNDO_STACK: UndoStackState = { past: [], future: [] };

/** Why a request can or cannot proceed. */
export const UndoRequestStatus = {
  Ready: "ready",
  Empty: "empty",
  OutOfScope: "out_of_scope",
} as const;
export type UndoRequestStatus =
  (typeof UndoRequestStatus)[keyof typeof UndoRequestStatus];

/**
 * The answer to "what would Cmd+Z do right now".
 *
 * A discriminated union, not an `entry | null`: `null` collapses "there is
 * nothing to undo" into "the thing to undo is somewhere you cannot see", and
 * those owe the reader different sentences.
 */
export type UndoRequest =
  | {
      readonly status: typeof UndoRequestStatus.Ready;
      readonly entry: UndoStackEntry;
    }
  | { readonly status: typeof UndoRequestStatus.Empty }
  | {
      readonly status: typeof UndoRequestStatus.OutOfScope;
      readonly entry: UndoStackEntry;
    };

function resolveTop(
  entries: readonly UndoStackEntry[],
  scopeKey: string
): UndoRequest {
  const entry = entries.at(-1);
  if (!entry) {
    return { status: UndoRequestStatus.Empty };
  }
  if (entry.scopeKey !== scopeKey) {
    return { status: UndoRequestStatus.OutOfScope, entry };
  }
  return { status: UndoRequestStatus.Ready, entry };
}

/**
 * How many performed mutations the session remembers.
 *
 * The stack is fed by user input and lives for as long as the tab does, so an
 * unbounded `past` is the in-memory growth this repo forbids: a long session on
 * a board grows it without limit, and each entry retains its captured
 * {@link UndoCommandContext}, including the prior value of every id in a bulk
 * mutation. The cap is what makes that bounded.
 *
 * Deep enough that the bound is not the thing a reader hits — the honest limit
 * on undo depth is the scope rule, which refuses at the first entry belonging
 * to another screen.
 */
export const UNDO_STACK_LIMIT = 50;

/**
 * Record a performed mutation.
 *
 * Clears `future`, which is the standard and the honest one: once a new
 * mutation lands, the redo entries describe a world that no longer exists, and
 * replaying one would assert a prior value nobody measured.
 *
 * At the cap the OLDEST entry is evicted — dropping the newest instead would
 * silently refuse to record the action the reader just took, so their next
 * Cmd+Z would undo the one before it. Eviction cannot corrupt redo: `future` is
 * emptied by this same push, and it only ever refills from entries that were on
 * `past`, so it is bounded by the same cap and can never hold an entry that has
 * been evicted from underneath it.
 */
export function pushUndoEntry(
  state: UndoStackState,
  entry: UndoStackEntry
): UndoStackState {
  const past = [...state.past, entry];
  return {
    past: past.length > UNDO_STACK_LIMIT ? past.slice(-UNDO_STACK_LIMIT) : past,
    future: [],
  };
}

/** What Cmd+Z would do on the surface identified by `scopeKey`. */
export function resolveUndoRequest(
  state: UndoStackState,
  scopeKey: string
): UndoRequest {
  return resolveTop(state.past, scopeKey);
}

/** What the redo chord would do on the surface identified by `scopeKey`. */
export function resolveRedoRequest(
  state: UndoStackState,
  scopeKey: string
): UndoRequest {
  return resolveTop(state.future, scopeKey);
}

/**
 * Move the top `past` entry onto `future`.
 *
 * Takes the ENTRY the caller acted on, not just the state, and refuses if it is
 * no longer on top. Between resolving a request and the inverse calls
 * completing, another mutation can land; committing "whatever is on top now"
 * would then pop an entry the caller never ran the inverse for, leaving the
 * stack claiming a change was reverted that is still in place.
 */
export function commitUndo(
  state: UndoStackState,
  entry: UndoStackEntry
): UndoStackState {
  if (state.past.at(-1)?.id !== entry.id) {
    return state;
  }
  return {
    past: state.past.slice(0, -1),
    future: [...state.future, entry],
  };
}

/** The mirror of {@link commitUndo}, moving `future` back onto `past`. */
export function commitRedo(
  state: UndoStackState,
  entry: UndoStackEntry
): UndoStackState {
  if (state.future.at(-1)?.id !== entry.id) {
    return state;
  }
  return {
    past: [...state.past, entry],
    future: state.future.slice(0, -1),
  };
}
