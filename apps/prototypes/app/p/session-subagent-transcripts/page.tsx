"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import { cn } from "@repo/design-system/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import {
  COHORTS,
  MockAvailability,
  type MockCohort,
  type MockTranscriptFile,
} from "./mock";

/**
 * Presentational prototype for the LIVE session transcript file switcher
 * (ISS-4677). Mock-data only.
 *
 * Where this lands: this is the chip row at the top of `SessionTranscriptPanel`
 * (`packages/app/agents/components/detail/session-transcript-panel.tsx`), the
 * one the web session-detail route and the desktop `SessionDetailView` both
 * mount. It is not a new panel and not a new page; it replaces the existing flat
 * chip wall in place. ISS-4625 built the same idea on `SessionOverviewSection`,
 * which has no production consumer, so nothing shipped.
 *
 * The things this prototype is here to settle:
 *  1. Collapsed by default, so a session with nine sidechains stops pushing the
 *     trace down three wrapped rows of pills.
 *  2. Main, and the file you are actually reading, stay inline — and stay put
 *     when the drawer opens, so the row does not reflow mid-interaction.
 *     Collapsing may hide options; it may never hide where you are.
 *  3. The header count is a count of transcript FILES, and says so. When the
 *     files and the session's Subagents metric disagree in EITHER direction it
 *     reconciles out loud ("12 subagents, 9 transcripts available")
 *     instead of quietly contradicting the metric, and states the number once.
 *  4. Unavailable is not zero. With no reported availability the switcher makes
 *     no claim at all rather than rendering a confident empty state.
 *  5. "Coming" and "never coming" are different things. An upload in flight
 *     stays calm and openable; a file the archive will never hold is warning
 *     toned, marked in visible text, and not a link.
 *  6. The drawer scrolls past ~four rows, so a 40-sidechain session does not
 *     just move the chip wall one click deeper.
 */

const READABLE = new Set<MockAvailability>([
  MockAvailability.Available,
  MockAvailability.Stale,
]);

const INLINE_LIMIT = 1;

const TRIGGER_CLASS = cn(
  "flex w-fit items-center gap-1.5 rounded-md border border-transparent px-2 py-1.5 text-left",
  "touch:min-h-tap-min hover:bg-accent hover:text-accent-foreground",
  "outline-none transition-colors",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
);

function fileLabel(file: MockTranscriptFile): string {
  if (file.fileKey === "main") {
    return "Main";
  }
  if (file.label) {
    return file.label;
  }
  return file.fileKey.startsWith("subagent:")
    ? `Subagent ${file.fileKey.slice("subagent:".length)}`
    : file.fileKey;
}

/** No bytes to open now, and no upload on the way that would change that. */
function isUnreachable(availability: MockAvailability): boolean {
  return !(
    READABLE.has(availability) ||
    availability === MockAvailability.UploadPending
  );
}

function chipVariant(
  file: MockTranscriptFile,
  isActive: boolean
): "default" | "warning" | "muted" {
  if (isActive) {
    return "default";
  }
  // `warning` is reserved for bytes that are NOT coming. An upload in flight is
  // as calm as a readable file — its own marker carries the difference — so the
  // chips do not flatten "coming" and "never coming" back together after the
  // caption went to trouble to keep them apart.
  return isUnreachable(file.availability) ? "warning" : "muted";
}

function FileChip({
  file,
  isActive,
  onSelect,
  presentationOnly,
}: {
  file: MockTranscriptFile;
  isActive: boolean;
  onSelect: (fileKey: string) => void;
  presentationOnly?: boolean;
}) {
  const variant = chipVariant(file, isActive);
  // Nothing to link to, so nothing that looks like a link. The reason is VISIBLE
  // text rather than a native `title`: a tooltip shows on neither touch nor a
  // keyboard, and a plain span never takes focus, so a title-only explanation
  // reads as a control that stopped working.
  if (isUnreachable(file.availability)) {
    return (
      <Chip aria-hidden={presentationOnly} variant={variant}>
        {fileLabel(file)}
        <span className="text-xs opacity-80">· unavailable</span>
      </Chip>
    );
  }
  return (
    <Chip asChild interactive variant={variant}>
      <button
        aria-current={isActive && !presentationOnly ? "page" : undefined}
        aria-hidden={presentationOnly}
        className="touch:min-h-tap-min"
        onClick={() => onSelect(file.fileKey)}
        tabIndex={presentationOnly ? -1 : undefined}
        type="button"
      >
        {fileLabel(file)}
        {file.availability === MockAvailability.UploadPending ? (
          <span className="text-xs opacity-80">· uploading</span>
        ) : null}
      </button>
    </Chip>
  );
}

/** Inline count-agreement, matching the production caption. */
function plural(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function reconciliation(
  cohort: MockCohort,
  subagentFiles: MockTranscriptFile[]
) {
  const parts: string[] = [];
  const reported = cohort.agentCount >= 1 ? cohort.agentCount - 1 : null;
  // "Available" counts only files whose bytes are readable. Counting a failed or
  // skipped one here would report the same file inside two clauses of one
  // caption, and a reader adding them up would get more files than exist.
  const archived = subagentFiles.filter((file) =>
    READABLE.has(file.availability)
  ).length;
  const disagrees = reported !== null && archived !== reported;
  if (disagrees) {
    // ISS-5762: one form for both directions, each number carrying its own
    // noun, bound by a comma so the two populations do not read as peers of the
    // " · "-joined file clauses. "N of M" made M read as a transcript count
    // when it counts subagents; "archived" read as "hidden" — the one thing
    // this surface must never imply, since no chip is ever dropped — and a
    // transport verb ("synced") is false for a desktop-local file.
    parts.push(
      `${reported} ${plural("subagent", reported)}, ${archived} ${plural("transcript", archived)} available`
    );
  }
  const pending = subagentFiles.filter(
    (file) => file.availability === MockAvailability.UploadPending
  ).length;
  const unavailable = subagentFiles.length - archived - pending;
  // "Still uploading" is a promise. True of an in-flight upload; false of a
  // failed one, a missing row, or a permanently skipped file.
  if (pending > 0) {
    parts.push(`${pending} still uploading`);
  }
  if (unavailable > 0) {
    parts.push(`${unavailable} unavailable`);
  }
  return {
    caption: parts.length > 0 ? parts.join(" · ") : null,
    hasUnreadable: pending + unavailable > 0,
    // The parenthetical is suppressed whenever the caption already carries a
    // count, in EITHER direction, so the same number is never printed twice and
    // a bare "(9)" can never sit beside a contradicting metric.
    showCount: !disagrees,
  };
}

/**
 * The reconciliation caption, shared by the disclosure trigger and the
 * un-collapsed chip row so the two cannot phrase the same reconciliation
 * differently. `ToneLabel` truncates by default, which is right for a one-word
 * status stem and wrong for a three-clause caveat — the clause most likely to be
 * clipped is the one the whole fold exists to protect — so it wraps instead.
 */
function Caption({
  caption,
  hasUnreadable,
}: {
  caption: string | null;
  hasUnreadable: boolean;
}) {
  if (!caption) {
    return null;
  }
  return (
    <ToneLabel
      className="text-clip whitespace-normal"
      variant={hasUnreadable ? "warning" : "muted"}
    >
      {caption}
    </ToneLabel>
  );
}

function TranscriptFileSwitcher({ cohort }: { cohort: MockCohort }) {
  const [open, setOpen] = useState(false);
  // Picking a sidechain is the entire job of this control, so the chips actually
  // switch files here rather than being fully styled no-ops.
  const [activeFileKey, setActiveFileKey] = useState(cohort.activeFileKey);

  if (!cohort.files || cohort.files.length <= 1) {
    return null;
  }

  const mainFiles = cohort.files.filter((file) => file.fileKey === "main");
  const subagentFiles = [...cohort.files]
    .filter((file) => file.fileKey !== "main")
    .sort((left, right) =>
      // Sort on the text the chip RENDERS: sorting by raw key while showing
      // names lands the chips in an order the reader can see no reason for.
      fileLabel(left).localeCompare(fileLabel(right), undefined, {
        numeric: true,
      })
    );
  const activeSubagent = subagentFiles.find(
    (file) => file.fileKey === activeFileKey
  );
  const shouldCollapse = subagentFiles.length > INLINE_LIMIT;
  const { caption, hasUnreadable, showCount } = reconciliation(
    cohort,
    subagentFiles
  );

  const inline = [...mainFiles];
  if (shouldCollapse) {
    if (activeSubagent) {
      inline.push(activeSubagent);
    }
  } else {
    inline.push(...subagentFiles);
  }

  const chipRow = (
    <div className="flex flex-wrap items-center gap-1">
      {inline.map((file) => (
        <FileChip
          file={file}
          isActive={file.fileKey === activeFileKey}
          key={file.fileKey}
          onSelect={setActiveFileKey}
          // Stays on screen so the row does not reflow when the drawer opens,
          // but inert once the drawer below exposes the same file.
          presentationOnly={open && file.fileKey === activeSubagent?.fileKey}
        />
      ))}
    </div>
  );

  if (!shouldCollapse) {
    // The disagreement is a property of the DATA, not of the fold: one sidechain
    // against a Subagents metric of 5 is exactly as contradictory below the
    // collapse threshold as above it.
    return (
      <div className="mb-3 space-y-1.5">
        {chipRow}
        <Caption caption={caption} hasUnreadable={hasUnreadable} />
      </div>
    );
  }

  return (
    <Collapsible className="mb-3" onOpenChange={setOpen} open={open}>
      {chipRow}
      <CollapsibleTrigger className={cn("mt-1.5", TRIGGER_CLASS)}>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-sm">
            {showCount
              ? `Subagent transcripts (${subagentFiles.length})`
              : "Subagent transcripts"}
          </span>
          <Caption caption={caption} hasUnreadable={hasUnreadable} />
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5">
        {/* Every sidechain, including the pinned one: a drawer that skips the
            pinned entry leaves a hole in the run, which reads as a missing
            transcript rather than as "you are already there". Bounded height,
            because an unbounded wrapped grid at 40 sidechains just moves the
            chip wall one click deeper. */}
        <div className="flex max-h-40 flex-wrap items-center gap-1 overflow-y-auto">
          {subagentFiles.map((file) => (
            <FileChip
              file={file}
              isActive={file.fileKey === activeFileKey}
              key={file.fileKey}
              onSelect={setActiveFileKey}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const SessionSubagentTranscriptsPrototype = () => {
  const [cohortId, setCohortId] = useState(COHORTS[0].id);
  const cohort = COHORTS.find((item) => item.id === cohortId) ?? COHORTS[0];
  const rendersSwitcher = Boolean(cohort.files && cohort.files.length > 1);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-8">
      <header className="flex flex-col gap-1">
        <span className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
          Session detail
        </span>
        <h1 className="font-semibold text-2xl tracking-tight">
          Subagent transcript disclosure
        </h1>
        <p className="text-muted-foreground text-sm">
          The transcript file switcher above the Session Trace, collapsed by
          default.
        </p>
      </header>

      <p className="rounded-md border border-border border-dashed bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">Where this lands: </span>
        this replaces the flat chip wall at the top of{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          SessionTranscriptPanel
        </code>
        , the panel the web session-detail route and the desktop{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          SessionDetailView
        </code>{" "}
        both mount. Not a new panel, not a new page.
      </p>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Sandbox controls
        </h2>
        {/* Plain Buttons, not Chips: reviewer chrome must not wear the same
            primitive as the surface under review, or the two read as one control
            set. Matches how `sessions-active-filters` switches cohorts. */}
        <div className="flex flex-wrap gap-1.5">
          {COHORTS.map((item) => (
            <Button
              key={item.id}
              onClick={() => setCohortId(item.id)}
              size="sm"
              type="button"
              variant={item.id === cohort.id ? "secondary" : "ghost"}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <p className="text-muted-foreground text-sm">{cohort.note}</p>
        {rendersSwitcher ? null : (
          <p className="rounded-md border border-border border-dashed bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
            <span className="font-medium text-foreground">Reviewer note: </span>
            the switcher renders nothing at all for this cohort, so the trace
            below sits flush against the panel edge. That absence is the
            behavior, not a gap to fill.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Session Trace
        </h2>
        <div className="rounded-xl border border-border bg-card p-4">
          <TranscriptFileSwitcher cohort={cohort} key={cohort.id} />
          <div className="flex flex-col gap-2 opacity-60">
            {["User turn", "Assistant turn", "Tool call", "Assistant turn"].map(
              (row) => (
                <div
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  key={row}
                >
                  {row}
                </div>
              )
            )}
          </div>
        </div>
      </section>
    </main>
  );
};

export default SessionSubagentTranscriptsPrototype;
