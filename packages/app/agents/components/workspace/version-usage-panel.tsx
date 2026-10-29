"use client";

import type {
  AgentComponentKind,
  ComponentVersion,
} from "@repo/api/src/types/agent-component";
import type { AgentComponentUsageAttribution } from "@repo/api/src/types/agent-component-version-usage";
import { formatCountOrDash } from "@repo/app/shared/lib/format-utils";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { FileX2Icon } from "lucide-react";
import { useState } from "react";
import { useAgentComponentVersionUsage } from "../../hooks/use-agent-component-version-usage";
import { coerceHash, versionLabelForHash } from "../../lib/version-label";
import { defaultCompareBaselineHash } from "../../lib/version-usage-compare";
import {
  sampledLocPerDollarCaveat,
  selectableVersions,
  sessionLevelAttributionCaveat,
  UNVERSIONED_UNAVAILABLE_COPY,
  unversionedDisclosure,
  VERSION_USAGE_ERROR_COPY,
  versionUsageMetrics,
} from "../../lib/version-usage-view";
import { VersionUsageCompareReadout } from "./version-usage-compare-readout";
import { VersionUsageControls } from "./version-usage-controls";

/**
 * ISS-10467 — the per-CONTENT-VERSION usage drill-down, inside the family page.
 *
 * ISS-10341 made every aggregate above this panel FAMILY-scoped (one population
 * per page) and thereby removed the only way to see one revision's own usage.
 * This restores it WHERE IT BELONGS: an explicit, opt-in drill-down BELOW the
 * headline, which it never replaces.
 *
 * WHY IT IS A LABEL/VALUE LIST AND NOT A SECOND CARD STRIP. A subordinate figure
 * must LOOK subordinate. Rendered as `MetricCard`s in the same grid the family
 * strip uses, this was a pixel-for-pixel clone of the headline sitting below the
 * headline, with only a paragraph of prose keeping a reader from reading it as
 * the total — and prose that exists to talk the eye out of what the layout says
 * is scaffolding around the wrong affordance. It borrows the lighter register the
 * Properties panel on this very page already uses.
 *
 * WHAT IT DOES WITH VERSION-LESS USAGE. Most usage rows record no version at
 * all, so most of the family's invocations belong to no revision here. Dropping
 * them silently is exactly the defect ISS-10341 fixed, so the panel COUNTS and
 * NAMES them — see `unversionedDisclosure`.
 *
 * Mounted from `AgentDetail`, which both the web page and the desktop renderer
 * mount, behind ONE closed-by-default PostHog key read at that one site. This
 * component is therefore inside the gate, never a second one.
 *
 * ISS-10468 — THE SIDE-BY-SIDE COMPARE LIVES HERE TOO, and inside the same gate.
 * It is the second half of the ISS-10341 ruling ("drill downs for specific
 * versions / side-by-side version compare"): with the page stating one
 * family-scoped population, nothing answered "did this revision actually do
 * better than the last one". The compare is a second COLUMN on this panel plus a
 * derived change column — not a new screen and not a second population — which is
 * why it needs no prototype of its own and no flag of its own
 * (`AGENTS_VERSION_USAGE_FLAG_KEY` carries why one key covers both tickets).
 *
 * The compare affordance appears ONLY when there is a second revision to compare
 * against. That is not a suppression: with one revision in history the second
 * operand does not exist, which is the one case the compare genuinely cannot be
 * offered in.
 */
const VERSION_USAGE_HEADING_ID = "agent-component-version-usage-heading";

export function VersionUsagePanel({
  slug,
  kind,
  versions,
  familyInvocations,
  familySessions,
}: {
  slug: string;
  /**
   * The component's kind, which decides TWO things and not one.
   *
   * It applies the SAME `LOC / $` verifiability gate the family strip applies —
   * without it a subordinate RATIO could assert a per-component attribution the
   * headline above it deliberately declines to make. And it selects the
   * session-level admission beneath the token/cost rows, which render for every
   * kind (ISS-10467 operator ruling, 2026-09-26): those totals are measured, so
   * the honesty is a sentence rather than a suppression.
   */
  kind: AgentComponentKind;
  versions: readonly ComponentVersion[];
  /**
   * The page's FAMILY headline, restated here verbatim from the detail payload
   * rather than re-derived: a second producer of the page's own headline number
   * is a number that can disagree with itself on one screen.
   */
  familyInvocations: number | null;
  familySessions: number | null;
}) {
  const options = selectableVersions(versions);
  const currentIndex = Math.max(
    0,
    options.findIndex((v) => v.isCurrent)
  );
  const currentHash = coerceHash(options[currentIndex]?.hash) || null;
  const [pickedHash, setPickedHash] = useState<string | null>(currentHash);
  // A PICK THAT IS NO LONGER ON OFFER IS NOT A SELECTION (whitlockk). The panel's
  // key resets it on same-component navigation, but a local refresh can replace
  // a legacy name-slug's version history IN PLACE — same slug, new hashes — and
  // the held pick then asks the read for a revision this component no longer
  // has, which answers "not computed" and renders the deliberate dash state as
  // if the data were missing. Falling back to the current revision keeps the
  // panel showing something the history actually carries; deriving it rather
  // than syncing state in an effect means there is no frame where the selector
  // and the request disagree.
  const offered = new Set(options.map((version) => coerceHash(version.hash)));
  const selectedHash =
    pickedHash !== null && offered.has(pickedHash) ? pickedHash : currentHash;
  // Nothing is selectable when every revision's hash coerces away (FEA-3520:
  // these arrive as non-strings in production), and then nothing was ever asked.
  const requested = selectedHash !== null;
  // ISS-10468. Compare is OFF by default — the drill-down answers "what did this
  // revision do", and the compare is the explicit follow-up question, so opening
  // the page still costs one version's read.
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [pickedBaseline, setPickedBaseline] = useState<string | null>(null);
  // Possible only when a SECOND revision exists. The comparison is withheld for
  // the one honest reason — there is no other operand — and never because a
  // figure inside it was hard to compute. Deliberately NOT gated on `supported`
  // here: that answer arrives from the hook below, and this value is what decides
  // the hook's own argument.
  const { baselineHash, comparePossible, comparing } = compareSelection({
    compareEnabled,
    offered,
    options,
    pickedBaseline,
    selectedHash,
  });
  const selectedHashes = versionsRequested(
    selectedHash,
    comparing ? baselineHash : null
  );
  const { data, isLoading, isError, supported } = useAgentComponentVersionUsage(
    slug,
    selectedHashes
  );
  const entry = data?.entries[0];
  // The contract answers "one entry per requested version, IN THE ORDER
  // REQUESTED", so the baseline is the second entry exactly when one was asked
  // for. Read positionally rather than by hash so a producer that echoes a
  // normalized hash cannot make the column silently empty.
  const baselineEntry = comparing ? data?.entries[1] : undefined;
  // The partition sentence is a claim about the PRODUCER, so it may only be made
  // once the producer has answered. Before that — pending, or idle with no
  // revision chosen — the panel says nothing rather than asserting that something
  // could not be computed when nothing has been asked yet.
  const settled = Boolean(data) && !isLoading;

  return (
    <section
      // A NAMED region: the panel restates a family figure and then shows a
      // narrower one beside it, so a screen-reader user reaching these rows out
      // of order needs the heading to travel with them.
      aria-labelledby={VERSION_USAGE_HEADING_ID}
      className="flex flex-col gap-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2
          className="font-semibold text-lg tracking-tight"
          id={VERSION_USAGE_HEADING_ID}
        >
          Version usage
        </h2>
        {/* Hidden when there is nothing to choose between, and when the source
            cannot answer per-version at all — a live control that changes
            nothing promises a drill-down this surface does not have. Mirrors the
            Definition panel above, whose selector also draws only past one
            revision. */}
        {supported && comparePossible ? (
          <VersionUsageControls
            baselineHash={baselineHash}
            compareEnabled={compareEnabled}
            onCompareChange={setCompareEnabled}
            onSelectBaseline={setPickedBaseline}
            onSelectVersion={setPickedHash}
            options={options}
            selectedHash={selectedHash}
          />
        ) : null}
      </div>
      <p className="text-muted-foreground text-sm">
        {familyBaselineCopy({
          comparing,
          familyInvocations,
          familySessions,
          // The tail is a claim about the BODY, so it may only be made when a
          // body of figures is actually below it (whitlockk).
          figuresBelow: !isError,
        })}
      </p>
      {readoutBody({
        baselineEntry,
        // ONE numbering base for the whole panel. `versionSelectLabel` numbers
        // against `options`, so numbering the column headers against the
        // unfiltered `versions` put the same revision under two "Rev N" a few
        // pixels apart whenever a hash coerced away (the FEA-3520 case
        // `selectableVersions` filters out) — tamsinb.
        baselineLabel: versionLabelForHash(baselineHash, options) ?? "Other",
        candidateLabel:
          versionLabelForHash(selectedHash, options) ?? "Selected",
        comparing,
        entry,
        isError,
        isLoading,
        kind,
        requested,
        supported,
      })}
      {versionUsageNotes({
        attribution: data?.attribution,
        baselineEntry,
        entry,
        isError,
        kind,
        settled,
        supported,
      })}
    </section>
  );
}

/**
 * The readout rows.
 *
 * A FAILED read is named, not merely dimmed: a muted row set reads as "not
 * applicable here", while the honest statement is "we could not fetch this". A
 * PENDING read is skeletoned rather than dashed, because a dash is the
 * producer's "not computed" and a request in flight has not said that yet.
 */
function VersionUsageReadout({
  entry,
  isLoading,
  kind,
}: {
  entry: Parameters<typeof versionUsageMetrics>[1];
  isLoading: boolean;
  kind: AgentComponentKind;
}) {
  const rows = versionUsageMetrics(kind, entry);
  return (
    <dl
      // `aria-busy` while the read is in flight: the loading cell is a bare
      // `Skeleton` with no name, so without this the list announces four labels
      // with empty values and nothing says the figures are still arriving. Set
      // only on the loading branch — it would be false once a read has settled.
      aria-busy={isLoading}
      className="grid grid-cols-[120px_1fr] gap-x-6 gap-y-2"
    >
      {rows.map((row) => (
        <div className="col-span-2 grid grid-cols-subgrid" key={row.key}>
          {/* The label treatment and the 120px track come from `PropRow` on this
              same page — a second label/value grid one section away with its own
              column width reads as a broken column, not as a lighter register. */}
          <dt className="font-medium text-muted-foreground text-sm">
            {row.label}
          </dt>
          <dd
            className={cn(
              "text-sm tabular-nums",
              // A not-computed figure must not be styled like a measurement:
              // the same muted treatment the shared MetricCard gives its own
              // no-data slot.
              row.measured ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {isLoading ? <Skeleton className="h-4 w-16" /> : row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The inputs every body state reads, shared by the wrapper and the switch. */
type VersionUsageBodyProps = {
  /** The BASELINE revision's entry, present only while comparing. */
  baselineEntry: Parameters<typeof versionUsageMetrics>[1];
  /** The baseline revision's column header. */
  baselineLabel: string;
  /** The selected revision's column header. */
  candidateLabel: string;
  /** Whether a second revision was requested and a compare is live. */
  comparing: boolean;
  entry: Parameters<typeof versionUsageMetrics>[1];
  isError: boolean;
  isLoading: boolean;
  kind: AgentComponentKind;
  requested: boolean;
  supported: boolean;
};

/**
 * The panel body, whichever of its states is live.
 *
 * ONE CONTAINER ACROSS EVERY STATE. This page already wrote the rule down for
 * itself on the Definition panel: keep the empty state inside the same box the
 * populated body uses, so the section reads as "empty" rather than losing its
 * panel and looking unfinished. The readout, the compare table and the two
 * no-data states therefore share one wrapper instead of the box belonging to the
 * unavailable branch alone.
 */
function readoutBody(props: VersionUsageBodyProps) {
  return (
    <div className="rounded-lg bg-muted/40 px-5 py-4">
      {versionUsageBody(props)}
    </div>
  );
}

function versionUsageBody({
  baselineEntry,
  baselineLabel,
  candidateLabel,
  comparing,
  entry,
  isError,
  isLoading,
  kind,
  requested,
  supported,
}: VersionUsageBodyProps) {
  if (!supported) {
    return (
      <EmptyState
        description="This view's data source cannot scope usage to a single content version."
        icon={FileX2Icon}
        size="compact"
        title="Per-version usage unavailable here"
      />
    );
  }
  // Nothing was asked, so nothing may answer. A row set of dashes here would
  // report the producer's "not computed" about a revision no one selected — the
  // same rule the disclosure sentence above already follows.
  if (!requested) {
    return (
      <EmptyState
        description="This component's revision history carries no version that can be broken down."
        icon={FileX2Icon}
        size="compact"
        title="No revision to break down"
      />
    );
  }
  // A FAILED read is named, not merely dimmed: a muted row set reads as "not
  // applicable here", while the honest statement is "we could not fetch this".
  if (isError) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {VERSION_USAGE_ERROR_COPY}
      </p>
    );
  }
  if (comparing) {
    return (
      <VersionUsageCompareReadout
        baselineEntry={baselineEntry}
        baselineLabel={baselineLabel}
        candidateEntry={entry}
        candidateLabel={candidateLabel}
        isLoading={isLoading}
        kind={kind}
      />
    );
  }
  return (
    <VersionUsageReadout entry={entry} isLoading={isLoading} kind={kind} />
  );
}

/**
 * The family restatement.
 *
 * Deliberately names the family FIRST and the drill-down second, so the panel
 * reads as subordinate to the headline above it rather than as a competing
 * total — the ISS-10341 ruling is that the page states one population, and this
 * sentence is what keeps a subtotal from being mistaken for it. A family figure
 * the producer could not compute is left unsaid rather than dashed into the
 * sentence, which would read as a claim about the component.
 */
function familyBaselineCopy({
  comparing,
  familyInvocations,
  familySessions,
  figuresBelow,
}: {
  comparing: boolean;
  familyInvocations: number | null;
  familySessions: number | null;
  /** Whether the body below this sentence is a figure readout at all. */
  figuresBelow: boolean;
}): string {
  // ONE ABSENT OPERAND MUST NOT TAKE THE OTHER WITH IT. These are the very
  // figures the cards above are rendering, so suppressing a computable one
  // because its sibling is null withholds a baseline the page already holds and
  // leaves a subtotal with no total to read it against.
  const parts: string[] = [];
  if (isMeasuredCount(familyInvocations)) {
    parts.push(`${formatCountOrDash(familyInvocations)} invocations`);
  }
  if (isMeasuredCount(familySessions)) {
    parts.push(`${formatCountOrDash(familySessions)} sessions`);
  }
  // ISS-10468: the sentence has to follow the body it introduces. Left at "one
  // revision's own share" while two columns render, it would name a population
  // the table does not show — the same stale-prose defect one layer out from the
  // one ISS-10341 fixed.
  const tail = comparing
    ? "The figures below are two revisions' own shares of that, and the change between them."
    : "The figures below are one revision's own share of that.";
  // A FAILED read leaves the named error alert below and no figures at all, so
  // the tail would promise two columns and a change that are not there (whitlockk).
  // The family restatement itself is still true — those cards are rendering — so
  // only the sentence about the body is dropped, never the baseline with it.
  const body = figuresBelow ? ` ${tail}` : "";
  if (parts.length === 0) {
    return `The cards above total every revision of this component.${body}`;
  }
  return `The cards above total ${parts.join(" across ")}, for every revision.${body}`;
}

/**
 * The three sentences beneath the readout, each in its OWN slot.
 *
 * Split out of the panel body for the same reason `compareSelection` was: the
 * gate each sentence carries is a real condition, and six of them inline put the
 * component over the cognitive-complexity ceiling. The slots stay separate — the
 * first is about the FAMILY's partition, the second about a selected revision's
 * ratio sample, the third about how the SPEND rows attribute — because running
 * three claims together would read as one claim about one population.
 *
 * Every one of them is a claim about the PRODUCER, so none may be made before a
 * producer has answered: the slot is withheld rather than rendered empty, since
 * an empty `<p>` still takes its share of the column gap and makes the caveat pop
 * in under settled data.
 */
function versionUsageNotes({
  attribution,
  baselineEntry,
  entry,
  isError,
  kind,
  settled,
  supported,
}: {
  attribution: AgentComponentUsageAttribution | undefined;
  baselineEntry: Parameters<typeof versionUsageMetrics>[1];
  entry: Parameters<typeof versionUsageMetrics>[1];
  isError: boolean;
  kind: AgentComponentKind;
  settled: boolean;
  supported: boolean;
}) {
  if (!(supported && settled) || isError) {
    return null;
  }
  // ISS-10468: each caveat is owed when EITHER compared revision earns it, not
  // only the selected one. Scoping them to the candidate would leave a baseline
  // column's sampled ratio sitting unqualified in the same table — and the change
  // column divides the two, so a bound on either side reaches the delta.
  const ratioCaveat =
    sampledLocPerDollarCaveat(kind, entry) ??
    sampledLocPerDollarCaveat(kind, baselineEntry);
  const spendCaveat =
    sessionLevelAttributionCaveat(kind, entry) ??
    sessionLevelAttributionCaveat(kind, baselineEntry);
  return (
    <>
      <p className="text-muted-foreground text-xs">
        {unversionedDisclosure(attribution) ?? UNVERSIONED_UNAVAILABLE_COPY}
      </p>
      {ratioCaveat === null ? null : (
        <p className="text-muted-foreground text-xs">{ratioCaveat}</p>
      )}
      {spendCaveat === null ? null : (
        <p className="text-muted-foreground text-xs">{spendCaveat}</p>
      )}
    </>
  );
}

/**
 * Which two revisions the compare is looking at, and whether it can look at all.
 *
 * Extracted from the panel body rather than inlined: three of its four branches
 * are guards against a stale or self-referential selection, and reading them
 * beside the render made the component itself exceed the cognitive-complexity
 * ceiling. Derived on every render instead of synced in an effect, so there is
 * no frame where the selectors and the request disagree.
 */
function compareSelection({
  compareEnabled,
  offered,
  options,
  pickedBaseline,
  selectedHash,
}: {
  compareEnabled: boolean;
  /** The hashes the primary selector currently offers. */
  offered: ReadonlySet<string>;
  options: readonly ComponentVersion[];
  pickedBaseline: string | null;
  selectedHash: string | null;
}): {
  baselineHash: string | null;
  comparePossible: boolean;
  comparing: boolean;
} {
  // POSSIBLE only when a SECOND revision exists. That is the one honest reason
  // the comparison can be unavailable — there is no other operand — and never
  // because a figure inside it was hard to compute.
  const comparePossible = options.length > 1;
  // The same "a pick no longer on offer is not a selection" rule the primary
  // selector follows, plus one more: a baseline equal to the candidate would ask
  // the producer for one version twice and render a table comparing a revision
  // with itself.
  const held =
    pickedBaseline !== null &&
    offered.has(pickedBaseline) &&
    pickedBaseline !== selectedHash;
  const baselineHash = held
    ? pickedBaseline
    : defaultCompareBaselineHash(options, selectedHash);
  return {
    baselineHash,
    comparePossible,
    comparing:
      comparePossible &&
      compareEnabled &&
      selectedHash !== null &&
      baselineHash !== null,
  };
}

/**
 * The versions this panel asks the producer for: the selected revision, plus the
 * baseline when a compare is live.
 *
 * CANDIDATE FIRST, because the contract answers "in the order requested" and the
 * readout reads the baseline positionally from index 1. Nothing is asked when no
 * revision is selectable at all (FEA-3520: every hash can coerce away), which is
 * what leaves the query idle rather than requesting an empty version list.
 */
function versionsRequested(
  candidateHash: string | null,
  baselineHash: string | null
): readonly string[] {
  if (candidateHash === null) {
    return [];
  }
  return baselineHash === null
    ? [candidateHash]
    : [candidateHash, baselineHash];
}

/** The same finite-number test the rows use, so the two cannot disagree. */
function isMeasuredCount(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
