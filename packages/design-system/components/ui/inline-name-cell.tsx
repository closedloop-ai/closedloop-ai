"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { PencilIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CHIP_FOCUS_RING_CLASS } from "./chip";
import { GridContextualAction } from "./grid-interaction-contract";
import {
  assertInlineEditFailureBehavior,
  type InlineEditFailureBehavior,
} from "./inline-edit-failure-behavior";
import { InlineScalarCell } from "./inline-scalar-cell";

/**
 * The grid-table editor for a record's NAME: the value renders as the host's own
 * node — a lead cell's link, a composed lead — beside an edit control revealed
 * on hover or focus, and the field appears only once the user opens it.
 *
 * ## Why this is a second component and not a mode on `InlineScalarCell`
 *
 * It was briefly built as an opt-in `collapsed` prop on that cell. Operator
 * ruling, Marisol Ashgrove, 2026-10-02: *"make it a separate sibling, the LLM won't
 * be able to figure out the gated opt-in; that's an antipattern"* — a mode that
 * switches on because a prop is merely PRESENT is not discoverable, by a reader
 * or by an agent. Two named components say which one you are using.
 *
 * ## Why a name is not a scalar
 *
 * {@link InlineScalarCell} is the champion and this composes it for the whole
 * editing core — draft state, commit ordering, duplicate detection, the
 * blur/Escape interlock, the dirty-edit guard, the focus contract, and the
 * in-field rollback are ALL its, not restated here. Three rules differ, and each
 * is a property of editing a name:
 *
 *  - **A commit is trimmed**, so a stray space is not a rename.
 *  - **A blank or whitespace-only draft is a CANCEL, not an erasure.** This is
 *    the one that stops the two components being one: an always-live scalar
 *    means the OPPOSITE by clearing — an empty draft is how a user unsets an
 *    estimate or a custom text field (clear-to-unset), a capability the operator
 *    chose to preserve in the same ruling. A name has no such reading; the
 *    routes behind one refuse `""`.
 *  - **The field is a lead cell's second control**, so it cannot be always-live:
 *    the lead cell is also the row's only link into the record, and a permanent
 *    text field leaves no link to click. Hence the reveal, and hence
 *    `data-grid-primary-editor` on the control, so a grid entry key (Enter, F2)
 *    opens the editor rather than following whichever control comes first in the
 *    DOM — in a lead cell that is the link, and Enter would navigate away.
 *
 * ## The one thing it owns, and why it must
 *
 * `confirmed` — the last value the host's write ACCEPTED. The resting render
 * reads it while the host still reports the value from which that write began,
 * because a host is not obliged to echo a commit back: a grid fed its rows as
 * props has nothing for an optimistic cache patch to flow through, and a
 * resting render keyed only on `value` then shows the OLD name after a
 * successful rename. Once the host supplies a different authoritative value,
 * that value wins and releases the memo. This made the ISS-8718
 * `CommittedRename` story provable without masking later refetches. It is a
 * memo of what was accepted, not a second commit ledger: ordering, duplicates
 * and refusal all stay with the cell above. With the explicit retained-failure
 * policy, a refused draft remains mounted beside its host-owned error while
 * `confirmed` stays the resting fallback. Escape reveals that fallback.
 */
export function InlineNameCell(props: Readonly<InlineNameCellProps>) {
  assertInlineEditFailureBehavior(
    props.retainRejectedDraft,
    props.saveErrorMessage
  );
  const { value, onCommit, label, renderValue, className } = props;
  const [editing, setEditing] = useState(false);
  const [confirmed, setConfirmed] = useState<AcceptedName | null>(null);
  const preventCollapseRef = useRef(false);
  const feedbackOwnerRef = useRef(false);
  const latestDraftRef = useRef(value);
  const latestCommitTokenRef = useRef(0);
  const latestAcceptedTokenRef = useRef(0);
  const shown = confirmed?.source === value ? confirmed.accepted : value;
  feedbackOwnerRef.current = editing && Boolean(props.retainRejectedDraft);

  useEffect(() => {
    if (confirmed && confirmed.source !== value) {
      setConfirmed(null);
    }
  }, [confirmed, value]);
  useEffect(() => {
    feedbackOwnerRef.current = editing && Boolean(props.retainRejectedDraft);
    return () => {
      feedbackOwnerRef.current = false;
    };
  }, [editing, props.retainRejectedDraft]);

  const commit = (next: string) => {
    const trimmed = next.trim();
    latestDraftRef.current = next;
    // A cleared name is a cancel, and so is a draft that only differs by
    // whitespace the trim already discarded.
    if (trimmed.length === 0 || trimmed === shown) {
      preventCollapseRef.current = false;
      feedbackOwnerRef.current = false;
      setEditing(false);
      return;
    }
    latestCommitTokenRef.current += 1;
    const commitToken = latestCommitTokenRef.current;
    if (!props.retainRejectedDraft) {
      // Without the retained-failure policy the editor closes on commit, as it
      // always has; the cell above restores the confirmed name on a refusal.
      feedbackOwnerRef.current = false;
      setEditing(false);
      return Promise.resolve(onCommit(trimmed, shown)).then(() => {
        recordAccepted(commitToken, trimmed);
      });
    }
    preventCollapseRef.current = true;
    return Promise.resolve()
      .then(() => onCommit(trimmed, shown, () => feedbackOwnerRef.current))
      .then(
        () => {
          recordAccepted(commitToken, trimmed);
          if (commitToken === latestCommitTokenRef.current) {
            preventCollapseRef.current = false;
            if (latestDraftRef.current.trim() === trimmed) {
              feedbackOwnerRef.current = false;
              setEditing(false);
            }
          }
        },
        (error: unknown) => {
          preventCollapseRef.current = false;
          throw error;
        }
      );
  };

  const recordAccepted = (commitToken: number, accepted: string) => {
    if (commitToken > latestAcceptedTokenRef.current) {
      latestAcceptedTokenRef.current = commitToken;
      setConfirmed({ accepted, source: value });
    }
  };

  if (editing) {
    const editor = props.retainRejectedDraft ? (
      <InlineScalarCell
        className={className}
        label={label}
        onCommit={commit}
        onFailureCleared={() => {
          preventCollapseRef.current = false;
          feedbackOwnerRef.current = false;
          setEditing(false);
        }}
        retainRejectedDraft
        saveErrorMessage={props.saveErrorMessage}
        selectOnMount
        type="text"
        value={shown}
      />
    ) : (
      <InlineScalarCell
        className={className}
        label={label}
        onCommit={commit}
        selectOnMount
        type="text"
        value={shown}
      />
    );
    // BUBBLE phase, deliberately: the cell's own handlers sit on the input and
    // so run FIRST — blur commits, Escape reverts and arms the interlock — and
    // only then does the event reach here to collapse. Capture phase would
    // unmount the cell before its handler ran, turning a blur into a lost edit.
    //
    // This is what keeps the composition free of a second seam in the cell: it
    // need not report that the user left the field, because leaving the field
    // IS a DOM event. It also covers the case `onCommit` cannot — a blur with
    // an unchanged draft, where the cell early-returns without calling it, and
    // the editor must still close.
    return (
      <div
        data-inline-editor-open=""
        onBlur={() => {
          if (!preventCollapseRef.current) {
            feedbackOwnerRef.current = false;
            setEditing(false);
          }
        }}
        onChange={(event) => {
          latestDraftRef.current =
            event.currentTarget.querySelector<HTMLInputElement>("input")
              ?.value ?? latestDraftRef.current;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            preventCollapseRef.current = false;
            feedbackOwnerRef.current = false;
            setEditing(false);
          }
        }}
      >
        {editor}
      </div>
    );
  }

  // SPANS, not divs: a host may put this inside an `<h1>`, which takes phrasing
  // content only (Session detail does). `display: flex` is unaffected by the
  // element name, so the layout is identical either way.
  return (
    <span className="group/inline-name flex min-w-0 items-center">
      <span className={cn("min-w-0", className)}>
        {renderValue ? renderValue(shown) : shown}
      </span>
      <GridContextualAction asChild legacyReveal="inlineName">
        <button
          aria-label={label}
          // Revealed on hover AND whenever it holds focus, so it is reachable by
          // keyboard with no pointer ever over the row. `cursor-pointer` because
          // this is the control that OPENS the editor, so it takes the pointer
          // every other activating control takes.
          className={cn(
            "ml-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
            // The measured token, not a hand-rolled ring: the contrast harness can
            // only see the shared class (`no-hand-rolled-focus-ring`).
            CHIP_FOCUS_RING_CLASS
          )}
          data-grid-primary-editor=""
          onClick={() => {
            latestDraftRef.current = shown;
            setEditing(true);
          }}
          type="button"
        >
          <PencilIcon aria-hidden className="size-3.5" />
        </button>
      </GridContextualAction>
    </span>
  );
}

export type InlineNameCellProps = {
  /** The authoritative name as the host last knows it. */
  value: string;
  /**
   * Called only for a commit that is neither blank nor unchanged, with the name
   * already TRIMMED. `expectedValue` is what this cell was showing, for a route
   * that takes an optimistic precondition. Signal a refusal by rejecting or
   * throwing. The failure policy decides whether the draft remains mounted;
   * compatibility callers restore the last confirmed name.
   */
  onCommit: (
    next: string,
    expectedValue: string,
    recoverableErrorOwner?: () => boolean
  ) => Promise<unknown> | void;
  /**
   * Names the edit control and the field. The host owns the words; this package
   * authors none.
   */
  label: string;
  /**
   * The resting render, given the name to show. A lead cell returns its link.
   * Omitted, the name renders as text.
   */
  renderValue?: (shown: string) => ReactNode;
  className?: string;
} & InlineEditFailureBehavior;

type AcceptedName = {
  accepted: string;
  source: string;
};
