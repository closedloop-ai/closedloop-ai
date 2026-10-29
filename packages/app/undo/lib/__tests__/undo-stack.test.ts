import { DocumentStatus } from "@repo/api/src/types/document";
import {
  type UndoCommandContext,
  UndoEntityType,
  UndoMutationKind,
} from "@repo/api/src/types/undo-command";
import { describe, expect, it } from "vitest";
import {
  commitRedo,
  commitUndo,
  EMPTY_UNDO_STACK,
  pushUndoEntry,
  resolveRedoRequest,
  resolveUndoRequest,
  UNDO_STACK_LIMIT,
  UndoRequestStatus,
  type UndoStackEntry,
} from "../undo-stack";

/**
 * ISS-9092 — cross-surface stack semantics.
 *
 * ONE stack for the session, every entry carrying the scope it was performed
 * on, and a refusal (never a silent skip) when the top entry belongs to a
 * screen the reader is not looking at. "The reader must never undo something
 * they cannot see" is the rule these cases pin.
 */

const SESSIONS_SCOPE = "/acme/sessions";
const DOCUMENT_SCOPE = "/acme/documents/prd-1";

function context(entityId: string): UndoCommandContext {
  return {
    entity: { type: UndoEntityType.Artifact, ids: [entityId] },
    priorValue: { [entityId]: DocumentStatus.Draft },
    newValue: { [entityId]: DocumentStatus.Approved },
  };
}

function entry(id: string, scopeKey: string): UndoStackEntry {
  return {
    id,
    kind: UndoMutationKind.ArtifactStatusChange,
    scopeKey,
    label: `Change status of ${id}`,
    context: context(id),
  };
}

describe("an empty stack", () => {
  it("reports Empty rather than an out-of-scope entry", () => {
    expect(resolveUndoRequest(EMPTY_UNDO_STACK, SESSIONS_SCOPE)).toEqual({
      status: UndoRequestStatus.Empty,
    });
    expect(resolveRedoRequest(EMPTY_UNDO_STACK, SESSIONS_SCOPE)).toEqual({
      status: UndoRequestStatus.Empty,
    });
  });
});

describe("scope decides whether the top entry may be undone", () => {
  it("is Ready when the top entry belongs to the scope in view", () => {
    const state = pushUndoEntry(EMPTY_UNDO_STACK, entry("a", SESSIONS_SCOPE));
    const request = resolveUndoRequest(state, SESSIONS_SCOPE);

    expect(request.status).toBe(UndoRequestStatus.Ready);
  });

  /*
   * The whole reason for the scope check. Reverting a Sessions-board mutation
   * while the reader is looking at a document produces a change with no visible
   * consequence — the classic "my data changed and I do not know what I did".
   */
  it("REFUSES, carrying the entry, when the top entry is on another screen", () => {
    const stranded = entry("a", SESSIONS_SCOPE);
    const state = pushUndoEntry(EMPTY_UNDO_STACK, stranded);
    const request = resolveUndoRequest(state, DOCUMENT_SCOPE);

    expect(request.status).toBe(UndoRequestStatus.OutOfScope);
    // The entry travels with the refusal so ISS-9093 can say WHERE the action
    // happened rather than rendering a dead key.
    expect(request).toHaveProperty("entry", stranded);
  });

  /*
   * It must REFUSE, not search downward. Skipping past the out-of-scope entry to
   * an older in-scope one would undo a mutation the reader did not perform last
   * — and would do it silently.
   */
  it("does not skip past the out-of-scope top entry to an older in-scope one", () => {
    let state = pushUndoEntry(EMPTY_UNDO_STACK, entry("older", DOCUMENT_SCOPE));
    state = pushUndoEntry(state, entry("newer", SESSIONS_SCOPE));

    const request = resolveUndoRequest(state, DOCUMENT_SCOPE);

    expect(request.status).toBe(UndoRequestStatus.OutOfScope);
    expect(request).toHaveProperty("entry.id", "newer");
  });
});

describe("pushing a new mutation", () => {
  /*
   * Once a new mutation lands, the redo entries describe a world that no longer
   * exists; replaying one would assert a prior value nobody measured.
   */
  it("clears the redo future", () => {
    const undone = entry("a", SESSIONS_SCOPE);
    const state = commitUndo(pushUndoEntry(EMPTY_UNDO_STACK, undone), undone);
    expect(state.future).toHaveLength(1);

    const afterPush = pushUndoEntry(state, entry("b", SESSIONS_SCOPE));

    expect(afterPush.future).toEqual([]);
    expect(afterPush.past).toHaveLength(1);
  });
});

describe("the stack is bounded", () => {
  /** Push `count` distinct in-scope entries, oldest first. */
  function pushSequence(count: number) {
    let state = EMPTY_UNDO_STACK;
    for (let index = 0; index < count; index += 1) {
      state = pushUndoEntry(state, entry(`e${index}`, SESSIONS_SCOPE));
    }
    return state;
  }

  /*
   * The stack is fed by user input and lives as long as the tab, so an
   * unbounded `past` grows without limit — and each entry retains the captured
   * prior value of every id in its mutation.
   *
   * A MULTI-step sequence is the only thing that can catch this: one push, or
   * any number below the cap, is identical with and without the bound.
   */
  it("evicts the OLDEST entry once the cap is reached", () => {
    const state = pushSequence(UNDO_STACK_LIMIT + 1);

    expect(state.past).toHaveLength(UNDO_STACK_LIMIT);
    // The first push is gone, and it is gone from the BOTTOM: the newest entry
    // is still on top, so the reader's next Cmd+Z is the action they just took.
    expect(state.past.at(0)?.id).toBe("e1");
    expect(state.past.at(-1)?.id).toBe(`e${UNDO_STACK_LIMIT}`);
  });

  /* Below the cap nothing is dropped — the eviction is a bound, not a window. */
  it("keeps every entry while the stack is under the cap", () => {
    const state = pushSequence(UNDO_STACK_LIMIT);

    expect(state.past).toHaveLength(UNDO_STACK_LIMIT);
    expect(state.past.at(0)?.id).toBe("e0");
  });

  /*
   * Eviction must not corrupt redo. `future` refills only from entries that
   * were on `past`, so it is bounded by the same cap — and the push that
   * evicts also empties it, so it can never hold an entry evicted from under
   * it and then replay a forward call for a mutation the stack has forgotten.
   */
  it("leaves redo consistent across an evicting push", () => {
    const overflowing = pushSequence(UNDO_STACK_LIMIT + 1);
    const top = overflowing.past.at(-1) as UndoStackEntry;
    const undone = commitUndo(overflowing, top);
    expect(undone.future).toEqual([top]);

    const afterEvictingPush = pushUndoEntry(
      undone,
      entry("newest", SESSIONS_SCOPE)
    );

    expect(afterEvictingPush.future).toEqual([]);
    expect(afterEvictingPush.past.length).toBeLessThanOrEqual(UNDO_STACK_LIMIT);
    expect(resolveRedoRequest(afterEvictingPush, SESSIONS_SCOPE)).toEqual({
      status: UndoRequestStatus.Empty,
    });
  });
});

describe("committing a move", () => {
  it("moves the entry from past to future on undo, and back on redo", () => {
    const only = entry("a", SESSIONS_SCOPE);
    const pushed = pushUndoEntry(EMPTY_UNDO_STACK, only);

    const undone = commitUndo(pushed, only);
    expect(undone.past).toEqual([]);
    expect(undone.future).toEqual([only]);

    const redone = commitRedo(undone, only);
    expect(redone.past).toEqual([only]);
    expect(redone.future).toEqual([]);
  });

  /*
   * An undo is a real API round trip, so another mutation can land between
   * resolving the request and the inverse completing. Committing "whatever is on
   * top now" would pop an entry whose inverse never ran, leaving the stack
   * claiming a change was reverted that is still in place.
   */
  it("refuses to commit an undo for an entry that is no longer on top", () => {
    let state = pushUndoEntry(EMPTY_UNDO_STACK, entry("a", SESSIONS_SCOPE));
    const raced = state.past[0];
    state = pushUndoEntry(state, entry("b", SESSIONS_SCOPE));

    expect(commitUndo(state, raced)).toEqual(state);
  });

  it("refuses to commit a redo for an entry that is no longer on top", () => {
    const first = entry("a", SESSIONS_SCOPE);
    const second = entry("b", SESSIONS_SCOPE);
    let state = commitUndo(pushUndoEntry(EMPTY_UNDO_STACK, first), first);
    state = commitUndo(pushUndoEntry(state, second), second);

    // `first` is now buried under `second` in the future list.
    expect(commitRedo(state, first)).toEqual(state);
  });
});
