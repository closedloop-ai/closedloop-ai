"use client";

import {
  AgentComponentKind,
  SourceAccessState,
  type SourceOccurrence,
  SourceOccurrenceType,
} from "@repo/api/src/types/agent-component";
import {
  type AgentComponentInvocationAnchor,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  type AgentComponentInvocationReadPage,
  type AgentComponentInvocationReadRow,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { Chip } from "@repo/design-system/components/ui/chip";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { CopyButton } from "@repo/design-system/components/ui/primitives/copy-button";
import { Link } from "@repo/navigation/link";
import { FileSearchIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { AGENTS_PAGE_SIZE } from "../../lib/agents-timeframe";
import {
  DetailTabUnit,
  detailTabTruncationReadout,
} from "../../lib/detail-tab-truncation-readout";
import { portableDefinitionPath } from "../../lib/portable-definition-path";
import {
  MAIN_TRANSCRIPT_FILE_KEY,
  withTranscriptInvocationParams,
} from "../../lib/session-transcript-href";

export type InvocationEvidenceListProps = {
  page: AgentComponentInvocationReadPage;
  getSessionHref?: (sessionId: string) => string | null;
};

/** Bounded, deterministic audit rows in the dedicated Evidence tab. */
export function InvocationEvidenceList({
  page,
  getSessionHref,
}: InvocationEvidenceListProps) {
  const rows = useMemo(
    () =>
      page.items.slice().sort(compareInvocationRows).slice(0, AGENTS_PAGE_SIZE),
    [page.items]
  );
  // ISS-5464: the third "Showing N of M" shape on this one detail page. It sat
  // ABOVE the table at `text-xs` with no unit noun ("Showing 50 of 1218"), while
  // Sessions and Branches print a `text-sm` sentence with a noun BELOW theirs.
  // Same page, same question, three answers. It now goes through the shared
  // readout and renders in the same slot as its siblings.
  //
  // ISS-5520: `isTotalPartial` is FALSE here — it must never be `page.hasMore`.
  // `hasMore` reports that the ROW LIST was bounded, never that the COUNT was:
  // both producers compute `total` with no limit — the cloud read sums an
  // uncapped `groupBy` COUNT (`invocation-read.ts`) and desktop a bare
  // `COUNT(*)` (`shared-agent-components-api.ts`) — and then derive
  // `hasMore: total > rows.length` from it. So whenever the 500-row read cap
  // bound the list, marking the total a floor printed "Showing 50 of 1,218+
  // invocations" for a population known to be exactly 1,218, one line under a
  // stats strip stating that same 1,218 flatly. The `+` belongs to a total that
  // genuinely is a lower bound (the Branches tab, which has no uncapped count to
  // read); overstating uncertainty is its own way of failing to say what we know.
  //
  // The total is used only while it is CREDIBLE, mirroring the Sessions tab's
  // `trueTotal >= delivered` test. Each producer reads its rows and its count in
  // two queries that are NOT in one transaction (`Promise.all` in both), so a
  // write landing between them can return a count below the rows delivered
  // alongside it. Believing that would print "Showing 50 of 40 invocations";
  // treating it as an exact total would let `total <= rendered` suppress the
  // notice entirely on a page that visibly cut rows. Falling back to a floor
  // says the one thing still true in that state — there may be more — which is
  // the same answer the Sessions tab gives an incredible count. With a credible
  // total the readout returns `null` exactly when nothing was omitted, which is
  // the condition the removed `page.hasMore || omittedCount > 0` guard tested.
  const population = invocationEvidencePopulation(page);
  const truncationNotice = detailTabTruncationReadout({
    isTotalPartial: population.isFloor,
    rendered: rows.length,
    total: population.total,
    unit: DetailTabUnit.Invocations,
  });

  // With zero rows, suppress the stats strip so the empty state stands alone.
  // Stacking "0 recorded" + "Attribution exceptions: 0 unmatched · 0 ambiguous"
  // above a full "No evidence recorded" empty state is three ways of saying
  // nothing (design review, #3688) — the eye works through two legible-but-empty
  // lines to reach the one that reads. Let the empty state carry the message.
  if (rows.length === 0) {
    return (
      <section aria-label="Invocation evidence">
        <EmptyState
          description="No exact invocation evidence has been recorded for this component yet."
          icon={FileSearchIcon}
          size="compact"
          title="No evidence recorded"
        />
      </section>
    );
  }

  return (
    <section aria-label="Invocation evidence">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3">
        <p className="flex flex-wrap gap-x-3 text-muted-foreground text-sm">
          <span>{formatInvocationPopulation(population)} recorded</span>
          <span>
            Attribution exceptions: {page.unmatchedCount} unmatched ·{" "}
            {page.ambiguousCount} ambiguous
          </span>
        </p>
      </div>

      <GridTable
        columns={INVOCATION_COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={INVOCATION_GRID_TEMPLATE_COLUMNS}
        items={rows}
        leadingLabel="Invocation"
        renderCell={(columnId, row) =>
          renderInvocationCell(columnId, row, getSessionHref)
        }
        renderLead={renderInvocationLead}
      />
      {truncationNotice ? (
        <p className="mt-2 px-4 text-muted-foreground text-sm">
          {truncationNotice}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The population this panel claims, decided ONCE for every readout on it.
 *
 * ISS-5520 (wongk, codex review #4716): the stats strip and the truncation
 * caption are two sentences about one number, so they must not be allowed to
 * compute it separately. The strip read `page.total` raw while the caption ran
 * the credibility test, and in the racy state the panel said "4 recorded" one
 * line above "Showing 10 of 10+ invocations" — the same component making two
 * incompatible population claims. Both now render this one value, so they can
 * only ever agree.
 *
 * Credibility is tested against `page.items.length`, the count the producer
 * actually DELIVERED — never against the rendered row count. `rows` is capped at
 * {@link AGENTS_PAGE_SIZE} (50) while `items` carries up to
 * `AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS` (500), so a count of 55 arriving
 * beside 60 delivered rows clears a `>= rows.length` test and would be accepted
 * as exact — even though the payload in hand already proves at least 60. The
 * delivered array is the strongest lower bound the client holds, so it is both
 * the credibility yardstick and the floor reported when the count fails it.
 */
function invocationEvidencePopulation(page: AgentComponentInvocationReadPage): {
  total: number;
  isFloor: boolean;
} {
  const delivered = page.items.length;
  return page.total >= delivered
    ? { total: page.total, isFloor: false }
    : { total: delivered, isFloor: true };
}

/**
 * "1,218" for a known population, "60+" for a floor — the same `+` convention
 * {@link detailTabTruncationReadout} prints, so the strip and the caption below
 * the table read as one claim. `formatNumber` matches the caption's separators;
 * the strip previously printed the raw integer, so a heavy component read "1218
 * recorded" directly above "Showing 50 of 1,218 invocations".
 */
function formatInvocationPopulation({
  total,
  isFloor,
}: {
  total: number;
  isFloor: boolean;
}): string {
  return isFloor ? `${formatNumber(total)}+` : formatNumber(total);
}

function renderInvocationLead(row: AgentComponentInvocationReadRow): ReactNode {
  return (
    <div className="min-w-0">
      <div className="truncate font-medium text-sm">
        {row.normalizedName ?? row.rawName ?? row.componentKey}
      </div>
      <div className="truncate font-mono text-muted-foreground text-xs">
        {KIND_LABELS[row.kind]} · {formatInvocationTime(row.invokedAt)}
      </div>
    </div>
  );
}

function renderInvocationCell(
  columnId: string,
  row: AgentComponentInvocationReadRow,
  getSessionHref: InvocationEvidenceListProps["getSessionHref"]
): ReactNode {
  if (columnId === "context") {
    return <InvocationContext getSessionHref={getSessionHref} row={row} />;
  }
  if (columnId === "revision") {
    return <ExactVersion row={row} />;
  }
  if (columnId === "status") {
    return <StatusChip status={row.status} />;
  }
  if (columnId === "source") {
    return <EvidenceSource row={row} />;
  }
  return null;
}

function InvocationContext({
  row,
  getSessionHref,
}: {
  row: AgentComponentInvocationReadRow;
  getSessionHref: InvocationEvidenceListProps["getSessionHref"];
}) {
  const sessionHref = invocationSessionHref(row, getSessionHref);
  const sessionLabel = row.externalSessionId || row.sessionId;
  return (
    <div className="min-w-0">
      {sessionHref ? (
        <Link
          className="block truncate text-primary text-sm underline-offset-4 hover:underline"
          href={sessionHref}
        >
          {sessionLabel}
        </Link>
      ) : (
        <span className="block truncate text-muted-foreground text-sm">
          {sessionLabel}
        </span>
      )}
      <span className="block truncate font-mono text-muted-foreground text-xs">
        {row.branchName ?? "Not captured"}
      </span>
    </div>
  );
}

function ExactVersion({ row }: { row: AgentComponentInvocationReadRow }) {
  const value = row.definitionHash ?? row.definitionVersionId;
  if (!value) {
    return <GridEmptyValue />;
  }
  const isHash = row.definitionHash === value;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-xs" title={value}>
        {isHash ? "sha256:" : "rev:"}
        {shortIdentifier(value)}
      </span>
      <CopyButton label={isHash ? "Copy hash" : "Copy revision"} text={value} />
    </div>
  );
}

function EvidenceSource({ row }: { row: AgentComponentInvocationReadRow }) {
  const source = formatGenuineSource(row);
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate text-xs" title={source}>
          {source}
        </span>
        {source === "Not captured" ? null : (
          <CopyButton label="Copy source" text={source} />
        )}
      </div>
      <span className="block truncate text-muted-foreground text-xs">
        {EVIDENCE_LABELS[row.evidenceClass]}
      </span>
    </div>
  );
}

function StatusChip({
  status,
}: {
  status: AgentComponentInvocationReadRow["status"];
}) {
  return (
    <Chip size="sm" variant={statusChipVariant(status)}>
      {STATUS_LABELS[status]}
    </Chip>
  );
}

function invocationSessionHref(
  row: AgentComponentInvocationReadRow,
  getSessionHref: InvocationEvidenceListProps["getSessionHref"]
): string | null {
  const rawHref = getSessionHref?.(row.sessionId) ?? null;
  if (!rawHref) {
    return null;
  }
  const baseHref = rawHref.startsWith("#") ? rawHref.slice(1) : rawHref;
  return withTranscriptInvocationParams(
    baseHref,
    invocationTranscriptFileKey(row),
    invocationLinkAnchor(row)
  );
}

function invocationTranscriptFileKey(
  row: AgentComponentInvocationReadRow
): string {
  if (
    row.anchor.kind === AgentComponentInvocationAnchorKind.Agent &&
    row.anchor.transcriptFileId
  ) {
    return `subagent:${row.anchor.transcriptFileId}`;
  }
  if (row.childSessionId) {
    return `subagent:${row.childSessionId}`;
  }
  if (
    row.externalAgentId &&
    (row.anchor.kind === AgentComponentInvocationAnchorKind.Agent ||
      row.relationship !== AgentComponentInvocationRelationship.Direct)
  ) {
    return `subagent:${row.externalAgentId}`;
  }
  return MAIN_TRANSCRIPT_FILE_KEY;
}

function invocationLinkAnchor(
  row: AgentComponentInvocationReadRow
): AgentComponentInvocationAnchor {
  if (
    row.anchor.kind === AgentComponentInvocationAnchorKind.Event &&
    !row.anchor.providerToolUseId
  ) {
    return {
      ...row.anchor,
      ...(row.providerInvocationId
        ? { providerToolUseId: row.providerInvocationId }
        : {}),
    };
  }
  if (
    row.anchor.kind === AgentComponentInvocationAnchorKind.Agent &&
    !row.anchor.externalAgentId
  ) {
    return {
      ...row.anchor,
      ...(row.externalAgentId ? { externalAgentId: row.externalAgentId } : {}),
    };
  }
  return row.anchor;
}

/**
 * A lexically-sortable key for `invokedAt`, which is DECLARED `string | null`.
 *
 * ISS-5520 (#4716): the web client reads every response through
 * `JSON.parse(rawBody, reviveWithDates)` (`shared/api/use-api-client.ts`), and
 * that reviver USED TO replace any ISO-8601 string with a `Date` whatever the
 * key. So this row reached the list with `invokedAt` a `Date` on the WEB adapter
 * and a plain string from the desktop reader's SQLite read — one contract, two
 * runtime shapes. The comparator called `.localeCompare` on it, which `Date`
 * does not have, so sorting threw a `TypeError` and took the entire component
 * detail page into its error boundary ("Something went wrong").
 *
 * ISS-5771 closed that at the source: revival is now gated to the keys a
 * route-served contract declares as a `Date`, and `invokedAt` is not one, so
 * both adapters deliver the declared `string`. This normalization stays as
 * defense in depth — the shape it guards against is no longer produced here,
 * but a comparator that cannot be handed a non-string is worth keeping.
 *
 * It stayed invisible because `Array.prototype.sort` never invokes the
 * comparator for fewer than two elements: every fixture and story that reached
 * this list carried a SINGLE invocation row, and the jsdom tests inject
 * plain-string props that never pass through the reviver. Reproducing it needed
 * a web-adapter payload with two or more rows — the regression threads 5/6 asked
 * for. On the live web app this crashed the detail page of any component with
 * two or more recorded invocations.
 *
 * Both shapes normalize to the same UTC ISO-8601 format, whose lexical order is
 * chronological, so the sort is unchanged for the string case.
 */
function invocationSortKey(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === "string" ? value : "";
}

function compareInvocationRows(
  left: AgentComponentInvocationReadRow,
  right: AgentComponentInvocationReadRow
): number {
  const byTime = invocationSortKey(right.invokedAt).localeCompare(
    invocationSortKey(left.invokedAt)
  );
  if (byTime !== 0) {
    return byTime;
  }
  const bySequence = right.sequence - left.sequence;
  return bySequence === 0 ? left.id.localeCompare(right.id) : bySequence;
}

function formatInvocationTime(value: string | null): string {
  if (!value) {
    return "Not captured";
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

function formatGenuineSource(row: AgentComponentInvocationReadRow): string {
  if (row.sourceOccurrence) {
    return formatSourceOccurrence(row.sourceOccurrence);
  }
  if (
    row.evidenceClass ===
      AgentComponentInvocationEvidenceClass.RepositoryCommit &&
    row.repositoryFullName
  ) {
    return [
      row.repositoryFullName,
      row.repositoryCommit ? `@${row.repositoryCommit}` : null,
      row.sourcePath,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (
    row.evidenceClass ===
      AgentComponentInvocationEvidenceClass.PackMembership &&
    row.packId
  ) {
    return `Pack ${row.packId}`;
  }
  if (
    row.evidenceClass ===
    AgentComponentInvocationEvidenceClass.CollectorSnapshot
  ) {
    return row.sourcePath ?? "Not captured";
  }
  return "Not captured";
}

function formatSourceOccurrence(source: SourceOccurrence): string {
  const access =
    source.accessState === SourceAccessState.Inaccessible
      ? " (inaccessible)"
      : "";
  return `${formatSourceOccurrenceBody(source)}${access}`;
}

/**
 * FEA-3982: render the provenance body for every `SourceOccurrenceType`. Each new
 * occurrence kind (static_file, distributed, builtin_claude, builtin_codex) gets
 * an explicit label instead of falling through to "Pack source" — a static file
 * or a harness-builtin has no pack evidence, so labeling it as a pack was wrong.
 * The exhaustive switch + `never` guard makes a future occurrence type fail
 * typecheck here until it is intentionally mapped.
 *
 * ISS-4805: `localPath` is a machine-captured path on an org-shared surface, the
 * same disclosure the detail header fixed, so it renders through the SAME
 * {@link portableDefinitionPath} rule. Without this the page made two different
 * claims about where one definition lives — a redacted header above an evidence
 * row still printing `/Users/<someone>/…`. A path with no portable part is
 * omitted rather than shown raw; the occurrence still renders its other
 * evidence (the compute target, or the bare "Static file" label).
 */
function formatSourceOccurrenceBody(source: SourceOccurrence): string {
  const localPath = source.localPath
    ? portableDefinitionPath(source.localPath)
    : null;
  switch (source.occurrenceType) {
    case SourceOccurrenceType.Repository:
      return [
        source.repoFullName,
        source.repoCommit ? `@${source.repoCommit}` : null,
        source.repoPath,
      ]
        .filter(Boolean)
        .join(" ");
    case SourceOccurrenceType.Local:
      return [source.computeTargetId, localPath].filter(Boolean).join(" · ");
    case SourceOccurrenceType.Pack:
      return source.packId ? `Pack ${source.packId}` : "Pack source";
    case SourceOccurrenceType.StaticFile:
      return localPath ? `Static file · ${localPath}` : "Static file";
    case SourceOccurrenceType.Distributed:
      return source.packId ? `Distributed · ${source.packId}` : "Distributed";
    case SourceOccurrenceType.BuiltinClaude:
      return "Built-in (Claude)";
    case SourceOccurrenceType.BuiltinCodex:
      return "Built-in (Codex)";
    default:
      return assertNeverOccurrenceType(source.occurrenceType);
  }
}

/**
 * Compile-time exhaustiveness guard: a new `SourceOccurrenceType` added to the
 * contract fails `tsc` here until {@link formatSourceOccurrenceBody} maps it.
 * Falls back to "Unknown source" at runtime for a version-skewed peer value.
 */
function assertNeverOccurrenceType(value: never): string {
  return typeof value === "string" ? value : "Unknown source";
}

const STATUS_LABELS = {
  [AgentComponentInvocationAttributionStatus.Matched]: "Matched",
  [AgentComponentInvocationAttributionStatus.Unresolved]: "Unresolved",
  [AgentComponentInvocationAttributionStatus.Unmatched]: "Unmatched",
  [AgentComponentInvocationAttributionStatus.Ambiguous]: "Ambiguous",
} as const;

const KIND_LABELS = {
  [AgentComponentKind.Subagent]: "Subagent",
  [AgentComponentKind.Command]: "Command",
  [AgentComponentKind.Skill]: "Skill",
  [AgentComponentKind.Workflow]: "Workflow",
  [AgentComponentKind.Mcp]: "MCP",
  [AgentComponentKind.Hook]: "Hook",
  [AgentComponentKind.Config]: "Config",
  [AgentComponentKind.Plugin]: "Plugin",
  [AgentComponentKind.Tool]: "Tool",
  [AgentComponentKind.Orchestration]: "Orchestration",
} as const;

const EVIDENCE_LABELS = {
  [AgentComponentInvocationEvidenceClass.TranscriptSnapshot]:
    "Transcript snapshot",
  [AgentComponentInvocationEvidenceClass.CollectorSnapshot]:
    "Collector snapshot",
  [AgentComponentInvocationEvidenceClass.RepositoryCommit]: "Repository commit",
  [AgentComponentInvocationEvidenceClass.PackMembership]: "Pack membership",
  [AgentComponentInvocationEvidenceClass.None]: "No exact evidence",
} as const;

function statusChipVariant(
  status: AgentComponentInvocationReadRow["status"]
): "success" | "warning" | "muted" {
  if (status === AgentComponentInvocationAttributionStatus.Matched) {
    return "success";
  }
  if (
    status === AgentComponentInvocationAttributionStatus.Ambiguous ||
    status === AgentComponentInvocationAttributionStatus.Unmatched
  ) {
    return "warning";
  }
  return "muted";
}

function shortIdentifier(value: string): string {
  return value.length <= 16
    ? value
    : `${value.slice(0, 10)}…${value.slice(-4)}`;
}

const INVOCATION_COLUMNS = [
  { id: "context", label: "Context" },
  { id: "revision", label: "Revision" },
  { id: "status", label: "Status" },
  { id: "source", label: "Evidence source" },
] satisfies readonly GridTableColumn[];

const INVOCATION_GRID_TEMPLATE_COLUMNS =
  "minmax(240px,1.1fr) minmax(220px,0.9fr) 220px 132px minmax(280px,1fr)";
