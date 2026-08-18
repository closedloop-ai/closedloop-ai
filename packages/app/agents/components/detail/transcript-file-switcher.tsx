"use client";

import type { SyncedAgentSessionAgent } from "@repo/api/src/types/agent-session";
import type { TranscriptAvailabilitySummary } from "@repo/api/src/types/desktop-transcripts";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  MAIN_TRANSCRIPT_FILE_KEY,
  transcriptFileLabel,
} from "../../lib/session-transcript-href";
import {
  buildSubagentTranscriptLabels,
  buildSubagentTranscriptSummary,
  hasUnreadableSubagentTranscripts,
  type SubagentTranscriptSummary,
  shouldShowSubagentFileCount,
  subagentTranscriptReconciliation,
} from "../../lib/subagent-transcripts";

/**
 * Deep-link tabs for a session's transcript files (main + subagent sidechains),
 * shown when there is more than one file and the surface supplies an href
 * builder (FEA-2717 Task 5). Each tab is an addressable `?file=` URL, so QA can
 * jump straight to a subagent's raw transcript.
 *
 * ISS-4677 folded the sidechain tabs behind a collapsed-by-default disclosure:
 * a session with nine subagents rendered nine pills wrapped over three rows and
 * pushed the trace itself below the fold. Three rules keep the fold honest:
 *
 *  - **Main, and the file you are actually reading, stay inline.** Collapsing may
 *    hide options; it may never hide where you are. The pinned file is ALSO
 *    listed inside the disclosure, so the header count and the revealed chips
 *    always agree — a drawer that skips the pinned number reads as a missing
 *    file.
 *  - **The header count is a count of FILES, and reconciles against the Subagents
 *    metric.** A subagent whose transcript was never archived has no file, so a
 *    bare "(9)" beside the word "subagent" would silently contradict the
 *    Subagents MetricCard. When the two disagree — in EITHER direction — the
 *    header states both numbers once, and drops the parenthetical rather than
 *    printing the count twice. The caption renders whether or not the chips are
 *    folded, because the disagreement is a property of the data, not of the fold.
 *  - **A caveat is not rendered in the calmest color we own.** Sidechains that
 *    are still uploading, or that the archive will never contain, tone the
 *    caption as a warning so collapsing cannot bury them.
 *
 * Both adapters that mount `SessionTranscriptPanel` — the web session-detail
 * route and the desktop `SessionDetailView` — render this component, so the
 * behavior cannot diverge by surface.
 */

/**
 * Shared trigger treatment. The DS `Collapsible` ships no base styles, so hover,
 * the focus ring and the tap-target floor are supplied here rather than
 * inherited. The ring recipe mirrors `Chip`'s interactive variant
 * (`focus-visible:border-ring` + `ring-ring/50` + `ring-[3px]`) so the trigger
 * and the chips beside it focus identically — the solid border change carries
 * the contrast, the ring is the glow around it.
 *
 * `w-fit`, not `w-full justify-between`: both cited references (the Properties
 * disclosure in `agent-detail.tsx` and the DS `SectionHeader`) hug their
 * content, and a full-bleed band inside a chip row reads as a selected list row
 * rather than a toggle.
 */
const TRIGGER_CLASS = cn(
  "flex w-fit items-center gap-1.5 rounded-md border border-transparent px-2 py-1.5 text-left",
  "touch:min-h-tap-min hover:bg-accent hover:text-accent-foreground",
  "outline-none transition-colors",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
);

export type TranscriptFileSwitcherProps = {
  /** The transcript file currently rendered (`main` or `subagent:{id}`). */
  activeFileKey: string;
  /** Deep-link builder; omitted on surfaces without routing (switcher hides). */
  buildHref?: (fileKey: string) => string;
  /** Per-file availability, or `undefined` when the producer did not report it. */
  files: TranscriptAvailabilitySummary[] | undefined;
  /**
   * Subagents the session reports — the SAME value the Subagents MetricCard
   * renders — or `null` when the agent rows have not arrived. Never coerce an
   * unknown count to `0`; see `resolveSubagentCount`.
   */
  subagentCount: number | null;
  /**
   * The session's agent rows, used only to give a sidechain chip a readable name
   * instead of a raw id. Optional: without them every chip keeps its file-key
   * label.
   */
  agents?: readonly SyncedAgentSessionAgent[];
};

export function TranscriptFileSwitcher({
  activeFileKey,
  agents,
  buildHref,
  files,
  subagentCount,
}: TranscriptFileSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const labels = useMemo(
    () => buildSubagentTranscriptLabels({ files: files ?? [], agents }),
    [files, agents]
  );
  // Labels first: the chip order is the order of the text the reader actually
  // sees, so a drawer of named chips scans instead of looking shuffled.
  const summary = useMemo(
    () =>
      buildSubagentTranscriptSummary({
        files,
        labels,
        reportedSubagentCount: subagentCount,
      }),
    [files, labels, subagentCount]
  );

  // No href builder, no availability, or nothing to switch to: render nothing.
  // Rendering NOTHING is the honest response to unknown availability — an empty
  // switcher shell would be a claim we cannot support.
  if (!(buildHref && files) || files.length <= 1) {
    return null;
  }

  // The file you are reading is pinned beside Main so collapsing never hides
  // where you are — and it STAYS pinned when the drawer opens, so the row above
  // does not reflow under the reader mid-interaction. Once the drawer lists that
  // same file, the inline copy goes `aria-hidden` + untabbable: two links with
  // the same accessible name, href and `aria-current="page"` would be announced
  // twice, so the eye keeps its anchor and assistive tech sees one.
  const activeSidechain =
    activeFileKey === MAIN_TRANSCRIPT_FILE_KEY
      ? undefined
      : summary.subagentFiles.find((file) => file.fileKey === activeFileKey);
  // `otherFiles` are neither main nor a `subagent:` sidechain. They are never
  // folded and never counted — a file the reader can open must stay reachable
  // even when the format grows a key this component does not model.
  const inlineFiles = summary.shouldCollapse
    ? [
        ...summary.mainFiles,
        ...summary.otherFiles,
        ...(activeSidechain ? [activeSidechain] : []),
      ]
    : [...summary.mainFiles, ...summary.otherFiles, ...summary.subagentFiles];

  const chipRow = (
    <div className="flex flex-wrap items-center gap-1">
      {inlineFiles.map((file) => (
        <TranscriptFileChip
          activeFileKey={activeFileKey}
          buildHref={buildHref}
          file={file}
          key={file.fileKey}
          label={labels.get(file.fileKey)}
          // The open drawer below already exposes this exact file; the inline
          // copy is only here to hold the reader's place.
          presentationOnly={isOpen && file.fileKey === activeSidechain?.fileKey}
        />
      ))}
    </div>
  );

  if (!summary.shouldCollapse) {
    // The reconciliation is a property of the DATA, not of the fold: a session
    // whose Subagents metric reads 5 with a single archived sidechain — or whose
    // one sidechain is still uploading — is exactly as contradictory below the
    // collapse threshold as above it. Rendering the caption only inside the
    // disclosure would let the single-sidechain case ship a bare chip row that
    // says nothing about the other four.
    return (
      <div className="mb-3 space-y-1.5">
        {chipRow}
        <SubagentReconciliationCaption summary={summary} />
      </div>
    );
  }

  return (
    <Collapsible className="mb-3" onOpenChange={setIsOpen} open={isOpen}>
      {chipRow}
      <CollapsibleTrigger className={cn("mt-1.5", TRIGGER_CLASS)}>
        <SwitcherTriggerLabel summary={summary} />
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            isOpen && "rotate-180"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5">
        {/* A wrapped grid with no bound just moves the chip wall one click
            deeper: a 40-sidechain session would push the trace off screen the
            moment the drawer opens. Past roughly four rows it scrolls in place
            instead of growing, so the drawer costs the trace a fixed amount of
            room however many sidechains a session ran. */}
        <div className="flex max-h-40 flex-wrap items-center gap-1 overflow-y-auto">
          {/* Every sidechain, including the pinned active one: the header count
              and the revealed chips must agree, or the gap where the pinned file
              would sit reads as a missing transcript. */}
          {summary.subagentFiles.map((file) => (
            <TranscriptFileChip
              activeFileKey={activeFileKey}
              buildHref={buildHref}
              file={file}
              key={file.fileKey}
              label={labels.get(file.fileKey)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The trigger's accessible name and its reconciliation caption. "Subagent
 * transcripts" — not "Subagents" — because the number counts transcript files,
 * not subagents (ISS-5762: it is never a bounded prefix of them either).
 * When a caption carries the count (the shortfall case) the parenthetical is
 * dropped so the same number is not printed twice.
 */
function SwitcherTriggerLabel({
  summary,
}: {
  summary: SubagentTranscriptSummary;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="font-medium text-sm">
        {shouldShowSubagentFileCount(summary)
          ? `Subagent transcripts (${summary.subagentFiles.length})`
          : "Subagent transcripts"}
      </span>
      <SubagentReconciliationCaption summary={summary} />
    </span>
  );
}

/**
 * The reconciliation caption, or nothing when the numbers already agree and
 * every file is readable. Shared by the collapsed disclosure trigger and the
 * un-collapsed chip row so the two cannot phrase or tone the same reconciliation
 * differently.
 */
function SubagentReconciliationCaption({
  summary,
}: {
  summary: SubagentTranscriptSummary;
}) {
  const caption = subagentTranscriptReconciliation(summary);
  if (!caption) {
    return null;
  }
  return (
    // A caveat rendered in the calmest color we own is not a caveat, so an
    // unreadable sidechain tones the caption `warning` — the SAME variant
    // vocabulary the affected chips use, via the catalog ToneLabel rather than a
    // local class string that can drift from it.
    //
    // ToneLabel truncates by default, which is right for a one-word status stem
    // and wrong here: the worst-case caption is three clauses, and the clause
    // most likely to be clipped is the caveat the whole fold exists to protect.
    // It wraps instead.
    <ToneLabel
      className="text-clip whitespace-normal"
      variant={hasUnreadableSubagentTranscripts(summary) ? "warning" : "muted"}
    >
      {caption}
    </ToneLabel>
  );
}

/**
 * One transcript tab. Composes the design-system `Chip` (`asChild` → the routing
 * `Link`) so the active/inactive pills inherit shared tokens + focus ring
 * instead of a local class string that drifts from Chip's palette.
 *
 * An UNREACHABLE file — `permanentlyUnavailable`, `uploadFailed` or `missing` —
 * is rendered as a PLAIN chip, not a link: there are no bytes to open, so a
 * live, hover-lit deep link would be a styled promise that lands the reader on
 * an error state. That reasoning does not stop at `permanentlyUnavailable`; a
 * failed upload and a missing row are just as unreachable right now.
 *
 * A still-uploading file KEEPS its link (those bytes may arrive while the panel
 * is open) and stays `muted`, because a warning tone would say "this is trouble"
 * about a file that is simply in flight.
 *
 * The reason a chip cannot be opened is VISIBLE text, not a native `title`: a
 * plain span never takes focus, and a tooltip shows on neither touch nor a
 * keyboard, so a title-only explanation reads as a link that stopped working.
 */
function TranscriptFileChip({
  activeFileKey,
  buildHref,
  file,
  label,
  presentationOnly,
}: {
  activeFileKey: string;
  buildHref: (fileKey: string) => string;
  file: TranscriptAvailabilitySummary;
  label?: string;
  /**
   * A visual duplicate of a chip already exposed elsewhere in this switcher —
   * kept on screen so the row does not reflow, but hidden from assistive tech
   * and skipped by the tab order so the same file is not offered twice.
   */
  presentationOnly?: boolean;
}) {
  const isActive = file.fileKey === activeFileKey;
  const text = label ?? transcriptFileLabel(file.fileKey);
  const variant = resolveChipVariant({
    availability: file.availability,
    isActive,
  });

  if (isUnreachableTranscript(file.availability)) {
    return (
      <Chip aria-hidden={presentationOnly} variant={variant}>
        {text}
        <span className="text-xs opacity-80">· unavailable</span>
      </Chip>
    );
  }

  return (
    <Chip asChild interactive variant={variant}>
      <Link
        aria-current={isActive && !presentationOnly ? "page" : undefined}
        aria-hidden={presentationOnly}
        className="touch:min-h-tap-min"
        href={buildHref(file.fileKey)}
        tabIndex={presentationOnly ? -1 : undefined}
      >
        {text}
        {file.availability === TranscriptAvailability.UploadPending ? (
          <span className="text-xs opacity-80">· uploading</span>
        ) : null}
      </Link>
    </Chip>
  );
}

/** No bytes to open now, and no upload on the way that would change that. */
function isUnreachableTranscript(
  availability: TranscriptAvailability
): boolean {
  return !(
    availability === TranscriptAvailability.Available ||
    availability === TranscriptAvailability.Stale ||
    availability === TranscriptAvailability.UploadPending
  );
}

function resolveChipVariant({
  availability,
  isActive,
}: {
  availability: TranscriptAvailability;
  isActive: boolean;
}): "default" | "warning" | "muted" {
  if (isActive) {
    return "default";
  }
  // `warning` is reserved for bytes that are NOT coming. An upload in flight
  // gets the same calm tone as a readable file — its own "· uploading" marker
  // carries the difference — so the palette does not flatten "coming" and "never
  // coming" back together after the caption went to trouble to keep them apart.
  return isUnreachableTranscript(availability) ? "warning" : "muted";
}
