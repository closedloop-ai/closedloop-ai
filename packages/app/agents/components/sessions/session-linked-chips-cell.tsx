"use client";

import {
  type SessionLinkedEntityChip,
  sessionLinkedChipsTrackTestId,
} from "@repo/app/agents/lib/session-linked-entity-chips";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import { Link } from "@repo/navigation/link";
import type { ReactNode } from "react";
import {
  chipOverflowAriaLabel,
  DS_CHIP_FIT_GEOMETRY,
  resolveVisibleQualifierCount,
  UNMEASURED_CHIP_CELL_WIDTH_PX,
} from "../../lib/session-qualifier-fit";

/**
 * The CAPPED (grid) track: one fixed-height line, so anything the measured fit
 * could not hold is clipped here and reached through the `+N` popover instead.
 */
const CAPPED_TRACK = "flex min-w-0 items-center gap-1 overflow-hidden";

/**
 * The UNCAPPED (card) track: wraps, and does NOT clip.
 *
 * `uncapped` puts every chip in `visible` and renders no `+N`, so there is no
 * overflow affordance left to escape to — keeping the capped track's
 * single-line `overflow-hidden` would clip every chip past the card field's
 * width with no way at all to reach those links (review: chatgpt-codex-connector
 * on `SessionLinkedChipsCell`). A card field is a full-width key/value line that
 * is free to grow a row, which is the whole reason the card fallback is uncapped
 * in the first place, so wrapping is the layout that matches the mode.
 */
const UNCAPPED_TRACK = "flex min-w-0 flex-wrap items-center gap-1";

/**
 * FEA-4209 / FEA-4210: the shared LINKED-ENTITY cell for the Sessions table —
 * the `Owning project` column and the `Linked issues` column are both this
 * with a different chip list.
 *
 * One component rather than two because the hard parts are identical and are
 * exactly the parts a second copy gets wrong: how many chips the measured track
 * holds, what the `+N` counter announces, and whether the overflow is reachable
 * without a mouse. ISS-5282 settled all three for the `Signals` column
 * (`SessionQualifiersCell`) and this follows it deliberately — a MEASURED fit
 * rather than a fixed cap, and a real `<button>` Popover rather than a hover
 * tooltip, because a hover secret is one two thirds of input methods never had.
 *
 * A row with NO chips never reaches this component: the host hands the grid the
 * shared `GridEmptyValue` sentinel directly, because that element is what the
 * card fallback's `isEmptyCellValue` inspects — see `SyncedSessionsTable`.
 */
export function SessionLinkedChipsCell({
  chips,
  icon,
  overflowNoun,
  testId,
  uncapped = false,
}: Readonly<{
  /**
   * The row's chips, already resolved. Passed in rather than derived here so the
   * host can tell an EMPTY row from a populated one before it renders anything
   * (the `GridEmptyValue` rule above).
   */
  chips: readonly SessionLinkedEntityChip[];
  /**
   * Optional leading glyph rendered inside every chip in this cell. Supplied by
   * the column, not per chip, because it identifies the KIND of link the whole
   * column carries.
   *
   * Pass the bare lucide element with no size class — `Chip` sizes its own
   * `svg` child (`[&>svg]:size-3.5` at the default size), so hardcoding one
   * re-declares a token the component already ships and silently desyncs the
   * glyph from the pill if the chip size ever changes.
   */
  icon?: ReactNode;
  /**
   * What the overflow counter is counting, singular, in customer-facing words —
   * "issue", "project". Used to build the counter's accessible name.
   */
  overflowNoun: string;
  /** Test hook for the overflow trigger; the column supplies a per-column id. */
  testId: string;
  /**
   * Render every chip, never collapsing into `+N`.
   *
   * The cap serves the GRID's fixed-height single line. The narrow-width CARD
   * fallback has no such constraint — a card field is a full-width key/value
   * line that can wrap, and below the card breakpoint the card list IS the
   * surface, and a touch one, where an overflow affordance is the worst place to
   * put a link. Same split ISS-5282 made for the qualifiers cell.
   */
  uncapped?: boolean;
}>) {
  // One observer per rendered cell, measuring the CONTENT box the chips actually
  // get — the grid track minus the cell's own horizontal padding — so the fit is
  // computed against the space available rather than against the track width.
  const { ref, width, measured } = useContainerWidth<HTMLSpanElement>();
  // The fit is pure arithmetic over label lengths and is shared with the
  // qualifiers cell rather than re-derived — but measured against THIS pill's
  // geometry, not that one's. The shared module's default constants describe a
  // `ToneBadge` (11px text, a state dot); a default-size DS `Chip` with a
  // `size-3.5` icon is ~4px wider per chip and a point larger in type, so
  // borrowing the ToneBadge numbers under-measured every chip — the direction
  // the module documents as unsafe, because an underestimate renders a chip the
  // track cannot hold and it clips silently against the `overflow-hidden` below.
  const visibleCount = uncapped
    ? chips.length
    : resolveVisibleQualifierCount(
        chips.map((chip) => chip.label),
        measured ? width : UNMEASURED_CHIP_CELL_WIDTH_PX,
        DS_CHIP_FIT_GEOMETRY
      );
  const visible = chips.slice(0, visibleCount);
  const overflow = chips.slice(visibleCount);
  return (
    <span
      className={uncapped ? UNCAPPED_TRACK : CAPPED_TRACK}
      data-testid={sessionLinkedChipsTrackTestId(testId)}
      ref={ref}
    >
      {visible.map((chip) => (
        <LinkedEntityChip chip={chip} icon={icon} key={chip.key} />
      ))}
      {overflow.length > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              aria-label={chipOverflowAriaLabel(
                overflow.map((one) => one.label),
                overflowNoun
              )}
              className="shrink-0"
              data-testid={testId}
              type="button"
            >
              {/* The SAME pill the chips beside it are, so the counter reads as
                  the overflow of this cell rather than as another entry in it.
                  Also the same HEIGHT as the `Signals` column's `ToneBadge`
                  pills (`h-6`) one track away — ISS-5282 review cid 3731458708
                  caught a ~20px pill sitting beside 11px-semibold `h-6` ones and
                  called it out as reading like a mistake rather than a counter.
                  That applies across columns on one row, not just within a cell,
                  so these chips take the DS default size rather than `sm`. */}
              <Chip variant="muted">{`+${overflow.length}`}</Chip>
            </button>
          </PopoverTrigger>
          {/* `w-auto` overrides the primitive's fixed `w-72`: this is a handful
              of short labels, and a 288px panel beside a 40px chip reads as a
              dialog rather than as the overflow of the row it belongs to.

              Bounded in HEIGHT for the opposite reason (wongk review):
              `linkedArtifacts` is not a handful in the tail — the projection
              test already carries 27 — and an unbounded list runs past the
              viewport and strands the links below the fold, which is exactly the
              unreachability this popover exists to fix. `available-height` is
              Radix's measured room between the trigger and the viewport edge, so
              the panel scrolls instead of overflowing; the same pairing
              `DropdownMenuContent` and `SelectContent` already ship. */}
          <PopoverContent
            align="start"
            className="max-h-(--radix-popover-content-available-height) w-auto max-w-xs overflow-y-auto p-2"
          >
            <ul className="flex flex-col items-start gap-1">
              {overflow.map((chip) => (
                <li key={chip.key}>
                  <LinkedEntityChip chip={chip} icon={icon} />
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}
    </span>
  );
}

/**
 * One chip: a link when the surface resolved an href, an inert pill when it did
 * not.
 *
 * The link is `@repo/navigation`'s `Link` (a real anchor both surfaces
 * intercept) rather than a raw `<a href>`, which is a dead click in the desktop
 * renderer — the same FEA-4051 rule the Session Name cell follows.
 *
 * The tooltip is the design-system `Tooltip`, never a native `title`: `title`
 * opens on neither keyboard focus nor touch, so the readers most in need of the
 * fuller name would be the ones who never see it. The inert branch stays a
 * non-focusable span — a `tabIndex` on a non-interactive element is a tab stop
 * that does nothing — so its tooltip is hover/pointer only.
 *
 * EVERY chip gets a tooltip, even one whose `title` adds nothing beyond the
 * visible label. The label renders in a `truncate` span inside a track whose
 * floor is narrow, so it can be ellipsised — and for `Owning project` the
 * `+N` popover can never be the escape hatch, because the contract yields at
 * most one project and the fit returns early for a single chip. Without this
 * fallback the column most likely to hold a long name would be the one with no
 * way at all to read it: no overflow, no tooltip, no accessible name. Mirrors
 * what the Repository cell already does (`renderRepoChip` passes `tooltip: label`).
 */
function LinkedEntityChip({
  chip,
  icon,
}: Readonly<{ chip: SessionLinkedEntityChip; icon?: ReactNode }>) {
  const disclosure = chip.title ?? chip.label;
  const body = (
    <>
      {icon}
      <span className="truncate">{chip.label}</span>
    </>
  );
  const pill = chip.href ? (
    <Chip asChild interactive variant="outline">
      {/* The accessible name carries the fuller title when there is one: "FEA-654"
          announced alone is not something a screen-reader user can choose to
          follow, and the tooltip that would explain it is behind a hover. */}
      <Link
        aria-label={chip.title ? `${chip.label}: ${chip.title}` : undefined}
        href={chip.href}
      >
        {body}
      </Link>
    </Chip>
  ) : (
    <Chip variant="muted">{body}</Chip>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent>{disclosure}</TooltipContent>
    </Tooltip>
  );
}
