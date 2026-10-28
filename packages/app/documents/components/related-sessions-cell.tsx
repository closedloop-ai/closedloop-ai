"use client";

import { SessionStatusBadge } from "@repo/app/agents/components/session-status-badges";
import { UNKNOWN_OWNER_LABEL } from "@repo/app/agents/lib/session-timeline-stacks";
import { CommentAvatar } from "@repo/app/shared/components/comment-avatar";
import { formatTimeOfDayOrMonthDay } from "@repo/app/shared/lib/date-utils";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";

/**
 * ISS-7235 — one related session, in a shape that names no domain type.
 *
 * Deliberately structural: the cell is promoted for reuse (a GridTable column,
 * the artifact detail field), so its contract is strings and a timestamp rather
 * than `RelatedSessionSummary`. Callers own the mapping, which keeps the label
 * vocabulary (`PROVENANCE_RELATIONSHIP_KIND_LABELS`) with its canonical owner
 * instead of copied into this render.
 */
export type RelatedSessionsCellItem = {
  id: string;
  /** What the reader reads — a session name, falling back to its slug. */
  label: string;
  ownerName: string | null;
  ownerAvatarUrl: string | null;
  /**
   * The session's lifecycle status, rendered through {@link SessionStatusBadge}.
   * A value outside the vocabulary folds to Active there, so producers on this
   * path must send an already-projected displayed status rather than a raw
   * column — which is what `toSessionListItem` does.
   */
  status: string;
  /** ISO-8601 of this session's most recent contributing interaction. */
  occurredAt: string;
  /** How the session related — already resolved to its canonical label. */
  relationshipLabel: string;
  /** Long-form timestamp, shown in the row's disclosure. */
  occurredAtLabel: string;
};

/** Why the cell is empty, on the sentinel's own hover/assistive text. */
export const RELATED_SESSIONS_EMPTY_TITLE = "No related sessions";

export type RelatedSessionsCellProps = {
  items: readonly RelatedSessionsCellItem[];
  /**
   * Eligible sessions the reader could reach if the cap were lifted. Greater
   * than `items.length` exactly when the cap truncated the list. Omitted means
   * "no truncation claimed" — never inferred.
   */
  total?: number;
  /** Injectable clock so the today/earlier boundary is pinnable. */
  now?: Date | number;
};

/**
 * A READ-ONLY provenance cell: which sessions wrote, revised, or commented on
 * an artifact, newest contribution first.
 *
 * Read-only is a correctness property here, not a styling choice — an editable
 * provenance field would let a reader assert a relationship that never
 * happened. So this renders no WRITE affordance: no input, no
 * `data-grid-primary-editor`, nothing that mutates a relationship. The
 * `count-cell` / `mono-id-cell` precedent for a derived value ("do not add
 * inline editing") is the same rule.
 *
 * Each row IS a `<button>`, and that is not a contradiction: it is a
 * disclosure, the only way to reach the owner and full timestamp without a
 * mouse (see {@link RelatedSessionRow}). It opens a popover and writes nothing.
 * "Read-only" constrains what the reader can CHANGE, not whether they can
 * operate the field — a field only a mouse can read is not read-only, it is
 * unreachable.
 *
 * NOT NAVIGABLE EITHER, and that is a gap rather than a decision: ISS-7235's
 * AC5 asks that activating a row open the artifact's Sessions tab at this
 * session's most recent contributing interaction. That destination does not
 * exist in this repo — there is no artifact→sessions tab and no per-interaction
 * anchor — so nothing here links, and no substitute was invented. The data the
 * link needs is already carried (`occurredAt`); only the destination is
 * missing. `related-sessions-cell.stories.tsx` pins the inertness so this stays
 * visible instead of reading as finished.
 *
 * A GridTable consumes it from `renderCell`, which is the only editability seam
 * either grid table has; returning inert content through it is what makes the
 * column non-editable.
 */
export function RelatedSessionsCell({
  items,
  total,
  now,
}: Readonly<RelatedSessionsCellProps>) {
  if (items.length === 0) {
    // The house empty-cell sentinel, carrying its reason. Returning it (rather
    // than a sentence) is what lets `GridTableCard` drop the row on a narrow
    // surface instead of stacking a "Related Sessions —" line; a detail field
    // that wants a sentence renders its own, because a bare dash under a
    // section heading reads as broken rather than as empty.
    return <GridEmptyValue title={RELATED_SESSIONS_EMPTY_TITLE} />;
  }
  const hidden = total === undefined ? 0 : Math.max(0, total - items.length);

  // No container pill per row. The status badge is the one pill each item
  // carries, so the row does not nest a bordered 24px pill inside a bordered
  // 28px one; the wide `gap-x-5` against the tight in-row `gap-2` is what
  // separates items instead of a border. Same plain-row treatment the session
  // detail header uses for owner + name + status.
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {items.map((item) => (
        <li key={item.id}>
          <RelatedSessionRow item={item} now={now} />
        </li>
      ))}
      {hidden > 0 ? (
        <li className="text-muted-foreground text-xs">
          {`+${hidden} more`}
          <span className="sr-only">
            {` ${relatedSessionNoun(hidden)} not shown`}
          </span>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The relationship word is VISIBLE, not hover-only. It is the single fact this
 * field exists to state, so it renders rather than hiding behind a disclosure.
 *
 * What the row does NOT show — the owner and the full timestamp — is reached
 * through a REAL disclosure: a `<button>` Popover, not a tooltip on a bare
 * span. A tooltip trigger that is not focusable is a hover secret, which is one
 * two thirds of input methods never had: it opens for a mouse, and for nobody
 * navigating by keyboard or touching a screen (whitlockk review). That is the same
 * call ISS-5282 settled for `session-linked-chips-cell`'s overflow, and a
 * Popover rather than a focusable Tooltip because Radix tooltips do not open on
 * tap at all, so a tooltip would have left touch users exactly where they were.
 *
 * WCAG 2.1 §1.3.1 (Info and Relationships) and §2.1.1 (Keyboard): information
 * conveyed visually must be available to assistive tech, and all functionality
 * must be operable by keyboard.
 *
 * The `sr-only` sentence stays. It is not redundant with the popover: it is
 * inside the trigger, so it is part of the button's accessible NAME and is
 * always in the accessibility tree, whereas the popover's copy exists only
 * while the disclosure is open. Both read from one `detail` string, so the two
 * spellings cannot drift.
 *
 * Still writes nothing — a disclosure is not an editor. See the read-only note
 * on {@link RelatedSessionsCell}.
 */
function RelatedSessionRow({
  item,
  now,
}: Readonly<{ item: RelatedSessionsCellItem; now?: Date | number }>) {
  const time = formatTimeOfDayOrMonthDay(item.occurredAt, { now });
  const owner = item.ownerName ?? UNKNOWN_OWNER_LABEL;
  const detail = `by ${owner}, ${item.occurredAtLabel}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* The DS focus ring, taken from `Button`'s own token string rather
            than invented, because this trigger is deliberately not a `Button`
            — it must read as a row, not as a control, until it is focused. */}
        <button
          className={`flex items-center gap-2 rounded-sm text-left text-sm ${CHIP_FOCUS_RING_CLASS}`}
          type="button"
        >
          {/* The avatar's photo is decorative on its own (ISS-7441), but its
              fallback initials are not; the sentence below already names the
              owner, so hide the whole subtree rather than half of it. */}
          <span aria-hidden="true">
            <CommentAvatar
              author={owner}
              authorAvatar={item.ownerAvatarUrl}
              size="xs"
            />
          </span>
          <span className="min-w-0 truncate font-medium">{item.label}</span>
          <span className="text-muted-foreground text-xs">
            {item.relationshipLabel}
          </span>
          <SessionStatusBadge artifactId={item.id} status={item.status} />
          <span aria-hidden="true" className="text-muted-foreground text-xs">
            {time}
          </span>
          <span className="sr-only">{detail}</span>
        </button>
      </PopoverTrigger>
      {/* `w-auto` overrides the primitive's fixed `w-72`: this is one short
          sentence, and a 288px panel beside a single row reads as a dialog
          rather than as that row's detail. Same override the linked-chips
          overflow popover makes. */}
      <PopoverContent className="w-auto max-w-xs p-2 text-sm">
        {detail}
      </PopoverContent>
    </Popover>
  );
}

/** The pluralized noun the Documents related-session counts share. */
export function relatedSessionNoun(count: number): string {
  return `related session${count === 1 ? "" : "s"}`;
}
