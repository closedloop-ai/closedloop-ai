"use client";

import {
  focusCellFromRowClick,
  GRID_CELL_SELECTOR,
  GridNavigationKey,
  resolveNextGridCell,
} from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  type KeyboardEvent,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CHIP_FOCUS_RING_CLASS } from "./chip";
import { GridEmptyValue } from "./grid-table-card";
import { InlineDateCell } from "./inline-date-cell";
import {
  assertInlineEditFailureBehavior,
  type InlineEditFailureBehavior,
} from "./inline-edit-failure-behavior";
import {
  InlineEditFeedback,
  refocusInlineEditControlIfOwned,
} from "./inline-edit-feedback";
import { Input } from "./input";
import { useCommitLedger } from "./use-commit-ledger";
import { useDirtyEditGuard } from "./use-dirty-edit-guard";

/**
 * The shared grid cell for a scalar the USER SETS — an estimate, a story-point
 * count, a short note, a due date, a custom TEXT/NUMBER/DATE field.
 *
 * The commit/cancel choreography is the load-bearing part. An inline input
 * commits on blur, and inside a grid Escape reverts *and* hands focus to the
 * cell — a blur — so a naive implementation commits the reverted value on the
 * way out and Escape silently does nothing. `cancelingRef` is the interlock:
 * Escape sets it before focus moves, the blur handler consumes it and skips the
 * commit exactly once.
 *
 * **Commit.** `onCommit` fires only when the draft actually differs from the
 * committed value, so a focus-through never writes. Enter commits; blur
 * commits; Escape reverts and does not commit. A caller that explicitly opts
 * into retained failures keeps the draft active, marks it invalid, and renders
 * the required host error beside it while the ledger keeps the last confirmed
 * value authoritative. Compatibility callers restore that confirmation.
 *
 * **Rejected numeric input never commits.** `<input type="number">` reports an
 * empty `value` for anything it cannot parse (`12e`, `1,5`, `--3`), which is
 * indistinguishable from the user deliberately clearing the field. The commit
 * path consults `validity.badInput` and leaves the draft alone, so a typo is
 * never persisted as an erasure. A host that parses its value out of plain
 * text (a duration, a typed date) refuses a draft the same way through
 * `draftRejection`, and supplies the words.
 *
 * **Render.** A value renders as a borderless `Input` that gains its field
 * chrome only on hover and focus, so a populated grid reads as text, not as a
 * form. No value renders the shared em-dash inside a button named
 * "Set {label}", naming what activating it does rather than what the cell is.
 * `readOnly` renders text (or the em-dash) with no control at all.
 *
 * **Focus (ISS-9490).** Leaving the field never drops focus on `<body>`. Inside
 * a navigable grid, Enter and Escape hand focus back to the owning cell (APG
 * grid: edit mode ends where it began) and Tab / Shift+Tab commit and move to
 * the adjacent cell, leaving the key native at a row edge. Outside a grid the
 * field keeps focus, and when it collapses back to the empty-state button, the
 * button inherits it. An unparseable number keeps focus on Enter, is marked
 * `aria-invalid` (the shared invalid state), and announces the adapter's
 * `invalidMessage` under the field; Tab is never held, because holding it
 * would be a keyboard trap with no words to explain it.
 *
 * Owns no comparator and no filter control: a scalar's ordering belongs to the
 * column that knows what the scalar means.
 *
 * **`date` is a real variant, and it is a `DatePickerPopover`, not an
 * `<input type="date">`** — see {@link InlineDateCell} for why, and for why a
 * popover keeps the same never-commit-a-cancel promise through a different
 * mechanism. It is dispatched to as its own component so a date never runs the
 * text branch's draft/blur hooks and vice versa.
 *
 * **`time` is deliberately absent.** `CustomFieldType`
 * (`packages/api/src/types/custom-field.ts`) has no `Time` member, so there is
 * no contract behind it: adding one is a schema change plus a migration and a
 * product decision, not a cell. Building the control first would put a field on
 * screen that nothing can store.
 *
 * **A host transition is a blur the browser never delivers.** Navigating,
 * paging the rows out, or rolling the gating flag back detaches this handler
 * before the node leaves the tree, and a refresh tears the page down
 * mid-keystroke — so without {@link useDirtyEditGuard} the one draft nobody
 * watches is the one that vanishes. The guard runs the same commit on teardown
 * and, while a draft is uncommitted, lets the browser ask before a refresh.
 *
 * `useInlineEdit` (`packages/app/shared/hooks/use-inline-edit.ts`) keeps the
 * same interlock for an always-mounted TITLE field, and reads the SAME
 * {@link useCommitLedger} and {@link useDirtyEditGuard} rather than restating
 * how commits are ordered, when one is a duplicate, or what a transition owes
 * the user. It keeps a refused save's typing in the field; this cell does so
 * only for a caller that opts into `retainRejectedDraft`, and otherwise
 * restores the confirmed value. A kept draft is still uncommitted, so a later
 * blur or host transition sends it again.
 */
export function InlineScalarCell({
  type = "text",
  invalidMessage,
  maxDate,
  draftRejection,
  restingValue,
  restingValueMatches,
  ...rest
}: Readonly<InlineScalarCellProps>) {
  assertInlineEditFailureBehavior(
    rest.retainRejectedDraft,
    rest.saveErrorMessage
  );
  if (type === "date") {
    return <InlineDateCell {...rest} maxDate={maxDate} />;
  }
  // `invalidMessage: string` accepts `""`, and `announcesInvalid` below then
  // reads a blank as "no message" — so the silent numeric refusal the required
  // prop exists to forbid type-checks right back in (whitlockk review, PR #8181).
  if (type === "number" && (invalidMessage ?? "").trim().length === 0) {
    throw new Error(BLANK_NUMERIC_INVALID_MESSAGE_ERROR);
  }
  return (
    <InlineTextScalarCell
      {...rest}
      draftRejection={draftRejection}
      restingValue={restingValue}
      restingValueMatches={restingValueMatches}
      invalidMessage={invalidMessage}
      type={type}
    />
  );
}

type InlineScalarCellBaseProps = {
  /** The committed value. An empty string is "no value". `date` is ISO `yyyy-MM-dd`. */
  value: string;
  /**
   * Called only when the user commits a value different from `value`. Signal a
   * refusal however you like — a rejected promise or thenable, or a synchronous
   * throw. The failure policy below decides whether the draft is retained.
   */
  onCommit: (next: string) => Promise<unknown> | void;
  /**
   * What is being edited ("Estimate", "Story points", "Due date"). Names the
   * control, and builds the empty cell's "Set {label}" action name — an
   * icon-free control whose only text is an em-dash needs it (WCAG 2.4.6).
   */
  label: string;
  /** Renders the value as plain text with no control. */
  readOnly?: boolean;
  /** Right-align under a numeric column. */
  alignEnd?: boolean;
  className?: string;
  /** Called when a retained failed draft returns to the confirmed value. */
  onFailureCleared?: () => void;
  /**
   * Focus the field and select its contents on mount.
   *
   * For a host that mounts this cell ALREADY in edit mode, because the control
   * the user activated was the host's and not this cell's — {@link
   * InlineNameCell} (`./inline-name-cell.tsx`) is the one such host. The focus
   * contract below hands focus to a control that MOUNTS only when this cell's
   * own control had it (`keepsFocusRef`), which a fresh mount cannot have, so
   * without this the field appears unfocused and the user has to click it.
   *
   * Selecting, not just focusing, because a host that opens a field over a
   * resting value is offering to REPLACE it; clicking into a scalar is offering
   * to amend it. Omitted — every existing consumer — nothing changes.
   */
  selectOnMount?: boolean;
} & InlineEditFailureBehavior;

/**
 * `time` is deliberately not supported — see the docstring — and
 * `invalidMessage` is required exactly where it can render.
 *
 * ISS-9590: `validity.badInput` is only ever true for a `number` input, so a
 * `number` cell is the only one that can refuse a draft, and it was the only
 * one that could refuse it SILENTLY — the message was optional and no adapter
 * passed one, while `custom-field-table-cell.tsx` answered the same refusal
 * through `customFieldValueRejectionMessage`. Requiring it here is what makes
 * those two agree: a wordless numeric refusal no longer compiles. `date` and
 * `text` exclude the prop for the same reason — neither can reach the branch
 * that renders it.
 *
 * `string` cannot express "non-blank", so the blank that would slip back
 * through is refused at runtime — {@link BLANK_NUMERIC_INVALID_MESSAGE_ERROR}.
 *
 * The string stays the adapter's, per this package's "no user-visible words"
 * contract; `INLINE_SCALAR_NUMBER_INVALID_MESSAGE` in `packages/app` is the one
 * that resolves it.
 */
export type InlineScalarCellProps = InlineScalarCellBaseProps &
  (
    | {
        type?: "text";
        invalidMessage?: never;
        maxDate?: never;
        draftRejection?: InlineScalarDraftRejection;
        restingValue?: string;
        restingValueMatches?: (draft: string) => boolean;
      }
    | {
        type: "date";
        invalidMessage?: never;
        /** The last ISO `yyyy-MM-dd` day the picker offers. */
        maxDate?: string;
        draftRejection?: never;
        restingValue?: never;
        restingValueMatches?: never;
      }
    | {
        type: "number";
        /**
         * Announced under the field while the draft is unparseable. A blank
         * one throws rather than announcing nothing.
         */
        invalidMessage: string;
        maxDate?: never;
        draftRejection?: InlineScalarDraftRejection;
        /**
         * The host's formatted text for the committed value ("$1,234.50",
         * "12%"), drawn over the field while it is unfocused and holds that
         * value. Editing still starts from the bare `value`.
         */
        restingValue?: string;
        /**
         * Whether a draft is the value `restingValue` formats, for a host
         * whose drafts have more than one spelling ("1234.50" for 1234.5).
         * Defaults to equality with `value`.
         */
        restingValueMatches?: (draft: string) => boolean;
      }
  );

/**
 * Why the host refuses to send a typed draft, in its own words, or `null` to
 * let the commit through.
 *
 * For a host whose value is parsed out of the text (a duration typed as
 * "1h 12m", a date typed as `yyyy-MM-dd`), where `validity.badInput` cannot
 * see the refusal because the input is plain text. The draft is never sent:
 * the field keeps it, is marked `aria-invalid`, and announces the message
 * under itself until the user edits or presses Escape, the same promise the
 * unparseable-number rule keeps. A draft that still equals the confirmed value
 * is not a commit, so it is never asked about.
 */
export type InlineScalarDraftRejection = (draft: string) => string | null;

/** The typed-text branch: an `Input` with the blur/Escape interlock. */
function InlineTextScalarCell({
  value,
  onCommit,
  label,
  type,
  readOnly = false,
  alignEnd = false,
  className,
  invalidMessage,
  saveErrorMessage,
  retainRejectedDraft = false,
  onFailureCleared,
  selectOnMount = false,
  draftRejection,
  restingValue,
  restingValueMatches,
}: Readonly<
  InlineScalarCellBaseProps & {
    type: "number" | "text";
    invalidMessage?: string;
    draftRejection?: InlineScalarDraftRejection;
    restingValue?: string;
    restingValueMatches?: (draft: string) => boolean;
  }
>) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // The host's words for a draft it refused to send, or null. Read through a
  // ref too, so Enter knows within the same keystroke whether to hand focus on.
  const [draftRefusal, setDraftRefusal] = useState<string | null>(null);
  const draftRefusalRef = useRef<string | null>(null);
  const invalidMessageId = useId();
  const draftRefusalId = useId();
  const saveErrorMessageId = useId();
  const restingValueId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  // True while this cell's control holds focus. Removing a focused node fires no
  // blur, so it is still set when the field collapses to the empty-state button
  // (or the button opens the field), and the control that mounts inherits focus
  // instead of it falling to `<body>`.
  const keepsFocusRef = useRef(false);
  const takeFocusOnMount = useCallback((node: HTMLElement | null) => {
    if (node && keepsFocusRef.current) {
      node.focus();
    }
  }, []);
  // Mount is the only time this runs, which is the point: re-selecting on every
  // keystroke would make the next character replace the whole draft.
  const mountedFocusedRef = useRef(false);
  const attachField = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (node === null) {
        // A field removed while focused fires no blur (the empty draft's
        // collapse to the Set button), so focus is cleared here too.
        setFocused(false);
      }
      if (selectOnMount && node && !mountedFocusedRef.current) {
        mountedFocusedRef.current = true;
        keepsFocusRef.current = true;
        node.focus();
        node.select();
        return;
      }
      takeFocusOnMount(node);
    },
    [selectOnMount, takeFocusOnMount]
  );
  const cancelingRef = useRef(false);
  // The commit path reads `validity` off the live input. A teardown commit runs
  // after React has detached that ref, so the last verdict is kept here or the
  // unparseable-number rule stops holding on exactly the path nobody watches.
  const badInputRef = useRef(false);
  // Escape reverts through `setDraft`, which is a RENDER away. A host that
  // dismisses on that same Escape — a dialog, a popover, any ancestor listening
  // for it — unmounts this cell in the same batch, so the revert never renders
  // and a teardown reading `draft` would commit exactly what Escape discarded.
  const draftRef = useRef(value);
  // Every draft write goes through here. A bare `setDraft` that skipped the ref
  // would hand the teardown a value the field has stopped showing — including
  // one the server has just REFUSED, which the next unmount would then send
  // again.
  const refuseDraft = (message: string | null) => {
    draftRefusalRef.current = message;
    setDraftRefusal(message);
  };
  const applyDraft = (next: string, badInput = false) => {
    draftRef.current = next;
    badInputRef.current = badInput;
    setDraft(next);
    setInvalid(badInput);
    refuseDraft(null);
  };
  // Enter commits and then, in a grid, blurs to the cell, and the blur handler
  // commits too. The `value` prop cannot have come back from the parent by then
  // (React has not even flushed the state update the first commit triggered),
  // so comparing against the prop would fire `onCommit` twice for one
  // keystroke. The ledger holds the committed value as of *now*, not as of the
  // last render.
  const ledger = useCommitLedger(value);
  const failedDraftRef = useRef<string | null>(null);

  const refocusIfOwned = () => {
    const field = inputRef.current;
    refocusInlineEditControlIfOwned(field);
  };

  // One predicate, asked from the warning, the teardown and a live update,
  // reading refs rather than the rendered `draft`: `commit()` below can submit
  // without any re-render at all (an already-`true` `setEditing`, then a clean
  // settle the ledger resolves in silence), and a rendered boolean would go on
  // warning about that saved edit forever.
  //
  // It asks the LEDGER, not the `value` prop, so a consumer that accepts a
  // commit without echoing a new `value` still goes quiet. The warning
  // therefore ends at DISPATCH rather than at confirmation — `submit` records
  // the value synchronously — and `useInlineEdit` ends there too, through the
  // same ledger read. That is deliberate on both: an in-flight write is the
  // mutation layer's business, as it is everywhere else in the app, and
  // nothing else on the page warns about one.
  const hasUncommittedEdit = () =>
    !(readOnly || badInputRef.current) &&
    draftRef.current !== ledger.current();

  // A committed value that changes underneath us (another user, a refetch) is
  // authoritative, so the ledger records it above every commit in flight: a
  // rejection that arrives afterwards can no longer roll the refetched value
  // back to what this cell was optimistically showing.
  //
  // It replaces the draft only when `hasUncommittedEdit` says the user holds no
  // typing a commit would send. Replacing a dirty draft threw the user's typing
  // away mid-edit (ISS-9589). Held, the new value is what Escape returns to and
  // what a refused commit falls back on, while a commit sends the typing over
  // it. Nothing server-side refuses that write today: the cell sends no base
  // value, so it is last-writer-wins until ISS-9486 carries a precondition.
  //
  // A LAYOUT effect, because a passive one can flush after the next Enter or
  // blur (whitlockk review, PR #7836): that commit advances the ledger to the
  // draft, the typing then reads as sent, and the reset below drops the commit
  // the user just made in favour of the value it was typed over.
  useLayoutEffect(() => {
    const holdsTyping = hasUncommittedEdit();
    ledger.reset(value);
    if (!holdsTyping) {
      failedDraftRef.current = null;
      setSaveFailed(false);
      applyDraft(value);
    }
  }, [value, ledger]);

  // Above the early returns below, because a hook cannot sit behind one — which
  // is also why this carries its own guards instead of reaching for `commit`,
  // declared further down.
  useDirtyEditGuard({
    hasUncommittedEdit,
    commit: () => {
      if (
        hasUncommittedEdit() &&
        (draftRejection?.(draftRef.current) ?? null) === null
      ) {
        ledger.submit(draftRef.current, onCommit, nothingToRepaint);
      }
    },
  });

  if (readOnly) {
    if (!value) {
      return <GridEmptyValue alignEnd={alignEnd} title={`No ${label}`} />;
    }
    return (
      <span
        className={cn(
          "truncate text-sm",
          type === "number" && "tabular-nums",
          alignEnd && "ml-auto",
          className
        )}
      >
        {restingValue ?? value}
      </span>
    );
  }

  if (!(editing || value)) {
    return (
      <button
        aria-label={`Set ${label}`}
        // Same box as the filled state: the empty cell is the one that most
        // needs to read as "you can type here", and a bare em-dash button is a
        // ~20px target, under the 24px minimum (WCAG 2.5.8).
        className={cn(
          "flex h-7 w-full items-center rounded-md px-1.5 text-left hover:bg-muted",
          CHIP_FOCUS_RING_CLASS,
          alignEnd && "justify-end",
          className
        )}
        onBlur={() => {
          keepsFocusRef.current = false;
        }}
        onClick={() => {
          keepsFocusRef.current = true;
          setEditing(true);
        }}
        ref={takeFocusOnMount}
        type="button"
      >
        <GridEmptyValue title={`Set ${label}`} />
      </button>
    );
  }

  const commit = () => {
    // The browser blanks a number input it cannot parse, so an empty draft here
    // may be a typo rather than a clear. Never persist the difference.
    if (inputRef.current?.validity.badInput) {
      return;
    }
    if (draft === ledger.current()) {
      setEditing(Boolean(draft));
      if (failedDraftRef.current !== null) {
        failedDraftRef.current = null;
        setSaveFailed(false);
        onFailureCleared?.();
      }
      return;
    }
    const refusal = draftRejection?.(draft) ?? null;
    refuseDraft(refusal);
    if (refusal !== null) {
      setEditing(true);
      return;
    }
    setEditing(Boolean(draft));
    failedDraftRef.current = null;
    setSaveFailed(false);
    ledger.submit(
      draft,
      onCommit,
      (resolved) => {
        if (failedDraftRef.current !== null) {
          setEditing(true);
          refocusIfOwned();
          return;
        }
        applyDraft(resolved);
        setEditing(Boolean(resolved));
      },
      ({ accepted, authoritative, submitted }) => {
        if (accepted && authoritative) {
          failedDraftRef.current = null;
          setSaveFailed(false);
        } else if (authoritative && retainRejectedDraft) {
          failedDraftRef.current = submitted;
          setSaveFailed(true);
          setEditing(true);
          refocusIfOwned();
        }
      }
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const field = event.currentTarget;
    if (event.key === "Enter") {
      // Nothing is saved, so the field keeps focus and `aria-invalid` says why.
      if (field.validity.badInput) {
        return;
      }
      commit();
      if (failedDraftRef.current === null && draftRefusalRef.current === null) {
        returnFocusToGridCell(field);
      }
      return;
    }
    if (event.key === "Escape") {
      // The LEDGER's value, not the `value` prop. Escape discards what you
      // typed since the last commit; reverting to a prop the host has not
      // caught up on would put an older value in the draft, and the
      // teardown would then WRITE it back over the one that saved. Whether
      // the field collapses reads the ledger too, or an empty cell's first
      // saved value hides behind the empty-state button until the echo.
      applyDraft(ledger.current());
      failedDraftRef.current = null;
      setSaveFailed(false);
      // Set before focus moves: the blur that move fires must skip its commit.
      cancelingRef.current = true;
      if (!returnFocusToGridCell(field)) {
        cancelingRef.current = false;
        setEditing(Boolean(ledger.current()));
      }
      return;
    }
    const nextCell = adjacentGridCellForTab(event);
    if (nextCell) {
      // The blur this fires is the commit.
      event.preventDefault();
      nextCell.focus();
    }
  };

  // The host's formatted text stands in for the bare value only while nothing
  // about the field needs the reader's attention: unfocused, at the committed
  // value, and with no refusal or failure to show.
  const showsResting =
    restingValue !== undefined &&
    !focused &&
    (restingValueMatches ? restingValueMatches(draft) : draft === value) &&
    !invalid &&
    !saveFailed &&
    draftRefusal === null;
  const announcesInvalid = invalid && Boolean(invalidMessage);
  const describedBy = [
    showsResting ? restingValueId : null,
    announcesInvalid ? invalidMessageId : null,
    draftRefusal === null ? null : draftRefusalId,
    saveFailed && saveErrorMessage ? saveErrorMessageId : null,
  ]
    .filter(Boolean)
    .join(" ");
  // The save error sits directly under the field: operator ruling, Daveth
  // Oakhurst, 2026-10-20 (PRD-722 manual QA, HUMAN-1 and HUMAN-2).
  // Always wrapped, so the message appearing never remounts the focused field.
  // The message is one 12px line under the 28px field, so a 44px grid row
  // holds both; its `title` gives the full sentence back when it truncates.
  return (
    <div className="relative flex w-full min-w-0 flex-col">
      {showsResting ? (
        <span
          aria-hidden="true"
          id={restingValueId}
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 flex h-7 items-center truncate px-1.5 text-sm",
            type === "number" && "tabular-nums",
            alignEnd && "justify-end"
          )}
        >
          {restingValue}
        </span>
      ) : null}
      <Input
        aria-describedby={describedBy || undefined}
        aria-valuetext={
          showsResting && type === "number" ? restingValue : undefined
        }
        aria-invalid={
          invalid || saveFailed || draftRefusal !== null || undefined
        }
        aria-label={label}
        className={cn(
          "h-7 min-w-0 border-transparent bg-transparent px-1.5 text-sm shadow-none hover:bg-muted focus-visible:bg-background",
          type === "number" && "tabular-nums",
          alignEnd && "text-right",
          showsResting && "text-transparent",
          className
        )}
        onBlur={() => {
          keepsFocusRef.current = false;
          setFocused(false);
          // Escape already reverted the draft and is on its way out through
          // this same blur. Consume the flag and skip the commit exactly once,
          // otherwise Escape writes the value it just undid.
          if (cancelingRef.current) {
            cancelingRef.current = false;
            setEditing(Boolean(ledger.current()));
            return;
          }
          commit();
        }}
        onChange={(event) => {
          const next = event.target.value;
          applyDraft(next, event.target.validity.badInput);
          if (failedDraftRef.current !== null && next === ledger.current()) {
            setSaveFailed(false);
          }
        }}
        onInput={(event) => {
          // React skips `onChange` when a number's `value` stays "" — empty to
          // `e` and back — so validity is re-read on every native input too.
          const { badInput } = event.currentTarget.validity;
          badInputRef.current = badInput;
          setInvalid(badInput);
        }}
        onFocus={() => {
          keepsFocusRef.current = true;
          setFocused(true);
        }}
        onKeyDown={handleKeyDown}
        ref={attachField}
        type={type}
        value={draft}
      />
      {announcesInvalid ? (
        <InlineEditFeedback
          // Follows the field's alignment. `alignEnd` exists for numeric
          // columns and `number` is the only variant that can render this, so a
          // left-aligned message under a right-aligned field is the DEFAULT
          // pairing, not an edge (#visual-qa, ISS-9590).
          alignEnd={alignEnd}
          id={invalidMessageId}
          message={invalidMessage ?? ""}
          truncate
        />
      ) : null}
      {draftRefusal === null ? null : (
        <InlineEditFeedback
          alignEnd={alignEnd}
          id={draftRefusalId}
          message={draftRefusal}
          truncate
        />
      )}
      {saveFailed && saveErrorMessage ? (
        <InlineEditFeedback
          alignEnd={alignEnd}
          id={saveErrorMessageId}
          message={saveErrorMessage}
          truncate
        />
      ) : null}
    </div>
  );
}

/**
 * Thrown when a `number` cell is handed a blank `invalidMessage`.
 *
 * Exported so a caller's test can pin the guard without holding a second copy
 * of the sentence. It is a programmer diagnostic for the error boundary, not
 * copy any user is meant to read.
 */
export const BLANK_NUMERIC_INVALID_MESSAGE_ERROR =
  "InlineScalarCell: a `number` cell needs a non-blank `invalidMessage`; a blank one refuses the draft in silence.";

function nothingToRepaint() {
  // A teardown commit settles after the cell has left the tree, so a refusal
  // has no field to roll back. The mutation that owns the write is what tells
  // the user, exactly as it does for a refusal the cell is still mounted for.
}

/**
 * Hand focus from a field back to the grid cell it sits in. False outside a
 * navigable grid, or when the cell would not take focus, so the caller keeps
 * the field's own focus rather than letting it fall to `<body>`.
 */
function returnFocusToGridCell(field: HTMLElement): boolean {
  const cell = focusCellFromRowClick(field);
  return cell != null && field.ownerDocument.activeElement === cell;
}

/**
 * The cell an unmodified Tab / Shift+Tab advances to, or `null` to leave the
 * key native — outside a grid, or at the row's edge, where Tab moves on out of
 * the grid as it would from the cell itself.
 */
function adjacentGridCellForTab(
  event: KeyboardEvent<HTMLInputElement>
): HTMLElement | null {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) {
    return null;
  }
  const cell = event.currentTarget.closest<HTMLElement>(GRID_CELL_SELECTOR);
  if (!cell) {
    return null;
  }
  return resolveNextGridCell(
    cell,
    event.shiftKey ? GridNavigationKey.ArrowLeft : GridNavigationKey.ArrowRight
  );
}
