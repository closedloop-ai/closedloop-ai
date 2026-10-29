"use client";

import type { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { AgentComponentVersionUsage } from "@repo/api/src/types/agent-component-version-usage";
import { KpiDeltaPlaceholder } from "@repo/app/insights/components/kpi-delta-placeholder";
import { DELTA_SENTIMENT_TEXT_CLASS } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from "lucide-react";
import {
  VERSION_COMPARE_DIRECTION_WORD,
  type VersionCompareDelta,
  VersionCompareDeltaState,
  VersionCompareDirection,
  type VersionCompareRow,
  versionCompareRows,
} from "../../lib/version-usage-compare";

/**
 * ISS-10468 — the side-by-side readout: two revisions' figures and the change
 * between them.
 *
 * A TABLE and not the drill-down's `dl`. The single-version readout is a
 * label/value list because it has one column; a compare has two named columns
 * plus a derived one, and the association between a figure and the revision it
 * belongs to is the whole payload. A `<th scope="col">` per revision is what
 * carries that association to a screen reader, which a nested `dl` cannot.
 *
 * WHAT IT NEVER DOES, because this repo has shipped the opposite twice: it does
 * not suppress the change column, does not render a permanent placeholder in it,
 * and does not default a delta away because an operand was bounded. See
 * `../../lib/version-usage-compare.ts` for the rule and the two states it keeps
 * apart.
 */
export function VersionUsageCompareReadout({
  baselineEntry,
  baselineLabel,
  candidateEntry,
  candidateLabel,
  isLoading,
  kind,
}: {
  baselineEntry: AgentComponentVersionUsage | undefined;
  /** The baseline revision's own label, as the selector spells it. */
  baselineLabel: string;
  candidateEntry: AgentComponentVersionUsage | undefined;
  /** The selected revision's own label, as the selector spells it. */
  candidateLabel: string;
  isLoading: boolean;
  kind: AgentComponentKind;
}) {
  const rows = versionCompareRows(kind, baselineEntry, candidateEntry);
  // ONE sentence for the whole table rather than one per row: the caveat is the
  // same fact about the same read every time it applies, and repeating it six
  // times trains a reader to stop seeing it. Withholding it is not on the menu —
  // it is what makes the published figure honest rather than exact. The sentence
  // is the DERIVATION's own (`delta.disclosure`), not a constant respelled here,
  // so a row that reports itself approximate and this caption cannot disagree
  // about what was short.
  const boundedDisclosure = isLoading ? null : firstDisclosure(rows);
  return (
    <div className="flex flex-col gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Metric</TableHead>
            <TableHead className="text-right" scope="col">
              {baselineLabel}
            </TableHead>
            <TableHead className="text-right" scope="col">
              {candidateLabel}
            </TableHead>
            <TableHead className="text-right" scope="col">
              Change
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody aria-busy={isLoading}>
          {rows.map((row) => (
            <TableRow key={row.key}>
              {/* A ROW header, not a plain cell: with four columns a figure's
                  meaning depends on both its column and its row, and only a
                  `scope="row"` header gives a screen reader the second half. */}
              <TableHead
                className="font-medium text-muted-foreground"
                scope="row"
              >
                {row.label}
              </TableHead>
              <FigureCell cell={row.baseline} isLoading={isLoading} />
              <FigureCell cell={row.candidate} isLoading={isLoading} />
              <TableCell className="text-right">
                {isLoading ? (
                  <Skeleton className="ml-auto h-4 w-20" />
                ) : (
                  <DeltaCell delta={row.delta} />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {boundedDisclosure === null ? null : (
        <p className="text-muted-foreground text-xs">{boundedDisclosure}</p>
      )}
    </div>
  );
}

/** One revision's figure, muted when it is the producer's "not computed". */
function FigureCell({
  cell,
  isLoading,
}: {
  cell: VersionCompareRow["baseline"];
  isLoading: boolean;
}) {
  return (
    <TableCell
      className={cn(
        "text-right tabular-nums",
        // A pending read is a SKELETON and a not-computed figure is a muted
        // dash. Collapsing the two would tell a reader the producer answered
        // when it has not been asked yet.
        cell.measured ? "text-foreground" : "text-muted-foreground"
      )}
    >
      {isLoading ? <Skeleton className="ml-auto h-4 w-14" /> : cell.value}
    </TableCell>
  );
}

/**
 * The change cell.
 *
 * DIRECTION travels as a distinct GLYPH SHAPE (up arrow / down arrow / minus)
 * plus a screen-reader word, and the good/bad reading travels as the visible
 * verdict WORD — so neither is carried by hue alone (WCAG 2.2 SC 1.4.1). The
 * colour is an additional channel on top of both, and only for a metric whose
 * polarity actually scores; a volume row renders in the ordinary foreground
 * because nothing about its direction is a verdict.
 */
function DeltaCell({ delta }: { delta: VersionCompareDelta }) {
  if (delta.state === VersionCompareDeltaState.Incomparable) {
    // The existing catalog affordance for exactly this concept — "No comparison"
    // with the reason in a tooltip AND in the accessibility tree — rather than a
    // dash that reads as forgotten data, and rather than a suppressed cell. The
    // `bare` variant matches this readout's own delta shape (text plus a glyph,
    // no pill), so the absent state does not out-design the present one.
    return (
      <span className="inline-flex justify-end">
        <KpiDeltaPlaceholder reason={delta.reason} variant="bare" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span
        className={cn(
          "inline-flex items-center gap-1 font-medium tabular-nums",
          // The canonical BARE-text delta colouring, imported rather than
          // respelled: a fourth spelling of "what worse looks like" is how the
          // tile and this table come to disagree about the same movement.
          DELTA_SENTIMENT_TEXT_CLASS[delta.sentiment]
        )}
      >
        <DirectionGlyph direction={delta.direction} />
        <span>{delta.magnitude}</span>
        {/* Skipped on a flat row: the magnitude there is already
            `VERSION_COMPARE_NO_CHANGE_LABEL`, so appending the direction word
            makes a screen reader say "No change unchanged" (tamsinb). The
            word exists to carry a direction the GLYPH otherwise carries by
            shape alone, and "unchanged" is the one direction the visible text
            already states. */}
        {delta.direction === VersionCompareDirection.Unchanged ? null : (
          <span className="sr-only">
            {` ${VERSION_COMPARE_DIRECTION_WORD[delta.direction]}`}
          </span>
        )}
      </span>
      {delta.percent === null ? null : (
        <span className="text-muted-foreground text-xs tabular-nums">
          {delta.percent}
        </span>
      )}
      {delta.verdict === null ? null : (
        <span className="text-muted-foreground text-xs">{delta.verdict}</span>
      )}
      {delta.state === VersionCompareDeltaState.Approximate ? (
        // The row-level marker for an approximate change. The sentence under the
        // table says what it means; this is what tells a reader WHICH rows it is
        // about, so the caveat cannot be read as covering all of them. It does
        // NOT repeat that sentence in an `sr-only` span: the caption is already
        // in the same region, and restating it per row makes a screen-reader
        // pass hear it six times.
        <span className="text-muted-foreground text-xs">approx.</span>
      ) : null}
    </span>
  );
}

function DirectionGlyph({ direction }: { direction: VersionCompareDirection }) {
  if (direction === VersionCompareDirection.Up) {
    return <ArrowUpIcon aria-hidden="true" className="size-3.5" />;
  }
  if (direction === VersionCompareDirection.Down) {
    return <ArrowDownIcon aria-hidden="true" className="size-3.5" />;
  }
  return <MinusIcon aria-hidden="true" className="size-3.5" />;
}

/**
 * The first approximate row's own disclosure, or null when nothing was bounded.
 *
 * Narrowed through the row's state rather than read off an optional field, so a
 * COMPUTED delta — which has no shortfall to state — can never caption the table.
 */
function firstDisclosure(rows: readonly VersionCompareRow[]): string | null {
  for (const row of rows) {
    if (
      row.delta.state === VersionCompareDeltaState.Approximate &&
      row.delta.disclosure !== null
    ) {
      return row.delta.disclosure;
    }
  }
  return null;
}
