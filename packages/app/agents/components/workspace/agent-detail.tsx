"use client";

/**
 * Agent component detail page (T-3.7).
 *
 * Renders the full detail view for a single agent component:
 *  - Header: kind icon + name + a distinct subtitle (path, else the
 *    fully-qualified identity slug; omitted when it would restate the name)
 *  - Per-kind metrics card grid (MetricCard from @repo/design-system)
 *  - Collapsible Properties panel (sourceType, source, harness, collaborators)
 *  - Read-only Prompt panel (only for Subagent / Command / Skill kinds)
 *  - Sessions, Branches, and exact Evidence tabs
 *
 * Data is fetched via `useAgentComponentDetail(slug)`. In Phase 1 the stub
 * source populates sessionsTab/branchesTab with empty arrays; the HTTP source
 * passes through whatever the server returns.
 *
 * Does NOT import from apps/prototypes or prototype mock files.
 */

import type {
  AgentComponentDetail,
  AgentComponentHonestSource,
  AgentComponentKind,
  AgentComponentProperties,
  ComponentResolvedState,
  ComponentVersion,
} from "@repo/api/src/types/agent-component";
import {
  classifyDetailError,
  DetailErrorKind,
} from "@repo/app/shared/components/detail-state-shell";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY,
  AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY,
  AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CpuIcon,
  FileCodeIcon,
  FileX2Icon,
  FolderGitIcon,
  GaugeIcon,
  HistoryIcon,
  PlugIcon,
  UsersIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTabParam } from "../../../shared/hooks/use-tab-param";
import { useAgentComponentDetail } from "../../hooks/use-agent-component-detail";
import {
  AGENT_COMPONENT_AUTHORS_LABEL,
  resolveComponentAuthors,
} from "../../lib/agent-component-authors";
import {
  adaptAgentComponentSessions,
  type SessionHrefTarget,
  type SessionTableRow,
} from "../../lib/agent-component-session-adapter";
import { detailHeaderSubtitle } from "../../lib/agent-slug-label";
import {
  CollaboratorStack,
  HARNESS_META,
  hasVersionHistoryAffordance,
  kindMeta,
  NO_SOURCE_RECORDED_TITLE,
} from "../../lib/component-meta";
import { deriveDefinitionAbsence } from "../../lib/definition-absence";
import { componentMetrics } from "../../lib/detail-data";
import { coerceHash } from "../../lib/version-label";
import {
  AgentDetailLoading,
  AgentDetailNotFound,
  AgentDetailUnavailable,
} from "./agent-detail-states";
import { DetailBranchesTab } from "./detail-branches-tab";
import { DetailSessionsTab } from "./detail-sessions-tab";
import { InvocationEvidenceList } from "./invocation-evidence-list";
import { ResolutionBadge } from "./resolution-badge";

// Kinds that carry a text prompt (read-only Prompt panel shown only for these)
// are enumerated by the shared `PROMPT_KINDS` in component-meta; the panel gate
// below routes through `hasVersionHistoryAffordance`, the same predicate the
// catalog "N versions" signal uses, so the count on the list row always points
// at a version dropdown that actually exists here (FEA-4267).

// Resolve the human harness label from the canonical HARNESS_META map, falling
// back to the raw value for a version-skewed/unknown harness so the header never
// prints an empty eyebrow (mirrors the Properties-panel resolution). SSOT is
// HARNESS_META — do not re-declare the labels here.
//
// The harness value is NOT closed to the `Harness` union at runtime: desktop's
// `toHarness` (shared-agent-components-api.ts) and cloud's `normalizeHarness`
// deliberately pass any non-empty collector string through, so the header can
// receive an arbitrary string. Use an OWN-key check (`Object.hasOwn`) rather
// than the `in` operator — `in` walks the prototype chain, so a stored harness
// named `constructor`/`toString`/etc. would spuriously take the map branch and
// resolve to `undefined.label`, blanking the eyebrow instead of falling back to
// the raw value (wongk review).
function harnessDisplayLabel(harness: string): string {
  return Object.hasOwn(HARNESS_META, harness)
    ? HARNESS_META[harness as keyof typeof HARNESS_META].label
    : harness;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const PropRow = ({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="grid grid-cols-[120px_1fr] items-center gap-3">
    <span className="font-medium text-muted-foreground text-sm">{label}</span>
    <div className="flex min-w-0 items-center gap-2 text-sm">
      {icon ? (
        <span className="shrink-0 text-muted-foreground">{icon}</span>
      ) : null}
      {children}
    </div>
  </div>
);

const PropValue = ({ children }: { children: React.ReactNode }) => (
  <span className="truncate">{children}</span>
);

// ---------------------------------------------------------------------------
// DetailHeader
// ---------------------------------------------------------------------------

function DetailHeader({
  kind,
  name,
  path,
  slug,
  harness,
  action,
  resolution,
  honest,
}: {
  kind: AgentComponentKind;
  name: string;
  path: string;
  slug: string;
  /**
   * ISS-5518: the `agents-detail-honesty` flag, threaded so the subtitle can
   * drop a content-hash digest instead of publishing 64 hex characters under
   * the title. Read once by `AgentDetail`, not re-resolved here, so the header
   * and the metrics grid can never end up on opposite sides of one flag.
   */
  honest: boolean;
  // Typed `string`, not `Harness`: the value is not closed to the union at
  // runtime (desktop `toHarness`/cloud `normalizeHarness` pass arbitrary
  // non-empty collector strings through), so the header must accept and
  // gracefully fall back for any string (wongk review). `harnessDisplayLabel`
  // owns the safe own-key resolution.
  harness: string;
  action?: React.ReactNode;
  resolution?: React.ReactNode;
}) {
  const KindIcon = kindMeta(kind).icon;
  // Say it once (FEA-3978): the subtitle must add information the title (name)
  // does not — the definition path, or the fully-qualified identity slug as a
  // distinct fallback — and is dropped entirely when it would only restate it.
  const subtitle = detailHeaderSubtitle({ honest, name, path, slug });
  // FEA-4255: surface the harness in the always-visible header eyebrow (next to
  // the kind) so it reads on every tab/section — previously it was only in the
  // Properties panel, which a user scanning the tabs never sees.
  const harnessLabel = harnessDisplayLabel(harness);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
          <span className="flex items-center gap-1.5">
            <KindIcon className="size-3.5" />
            {kindMeta(kind).label}
          </span>
          {/* Harness rides the same eyebrow as a second metadata segment. The
              dot separator lives INSIDE the harness segment's own span (not as a
              standalone flex child) so the dot and its label never split across
              a wrap — matching the inline `{a} · {b}` pattern used everywhere
              else (pack-meta, pack-list-row, loop-cell). It carries no icon of
              its own: the kind already owns the eyebrow's glyph, and a second
              icon would read as noise. The dot is decorative. */}
          <span className="whitespace-nowrap">
            <span aria-hidden="true" className="text-muted-foreground/50">
              ·{" "}
            </span>
            {harnessLabel}
          </span>
        </span>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-semibold text-2xl tracking-tight">{name}</h1>
          {resolution}
        </div>
        {subtitle ? (
          // Truncate so a real absolute install path (production fills the
          // subtitle from `installPath`) can't wrap to a second 12px line and
          // shove the metrics grid down, making the header a per-component
          // height; the full value stays readable on hover. Matches PropValue.
          <span
            className="truncate text-muted-foreground text-xs"
            title={subtitle}
          >
            {subtitle}
          </span>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PropertiesPanel
// ---------------------------------------------------------------------------

// A wrap of monospace chips for a string list (allowed tools, orchestrated
// sub-agents). Renders nothing when the list is empty so the row can be omitted.
const PropChips = ({ items }: { items: readonly string[] }) => (
  <div className="flex flex-wrap gap-1">
    {items.map((item) => (
      <Chip className="font-mono" key={item} size="sm" variant="muted">
        {item}
      </Chip>
    ))}
  </div>
);

// The per-kind, definition-derived rows (model, allowed tools, MCP server info,
// workflow orchestration). Each row is rendered only when the backing property
// is present, so a component with a sparse definition simply shows fewer rows —
// never an empty/faked value. This is the superset the DTO can express.
const PerKindProperties = ({
  properties,
}: {
  properties: AgentComponentProperties;
}) => {
  const { format, model, allowedTools, server, maxConcurrency, orchestrates } =
    properties;
  return (
    <>
      {format ? (
        <PropRow icon={<FileCodeIcon className="size-3.5" />} label="Format">
          <PropValue>{format}</PropValue>
        </PropRow>
      ) : null}
      {model ? (
        <PropRow icon={<CpuIcon className="size-3.5" />} label="Model">
          <PropValue>{model}</PropValue>
        </PropRow>
      ) : null}
      {allowedTools && allowedTools.length > 0 ? (
        <PropRow
          icon={<WrenchIcon className="size-3.5" />}
          label="Allowed tools"
        >
          <PropChips items={allowedTools} />
        </PropRow>
      ) : null}
      {typeof maxConcurrency === "number" ? (
        <PropRow
          icon={<GaugeIcon className="size-3.5" />}
          label="Max concurrency"
        >
          <PropValue>{maxConcurrency}</PropValue>
        </PropRow>
      ) : null}
      {orchestrates && orchestrates.length > 0 ? (
        <PropRow
          icon={<WorkflowIcon className="size-3.5" />}
          label="Orchestrates"
        >
          <PropChips items={orchestrates} />
        </PropRow>
      ) : null}
      {server ? (
        <>
          <PropRow icon={<PlugIcon className="size-3.5" />} label="Server URL">
            <PropValue>{server.url}</PropValue>
          </PropRow>
          <PropRow label="Auth">
            <PropValue>{server.auth}</PropValue>
          </PropRow>
          <PropRow label="Health">
            <PropValue>{server.health}</PropValue>
          </PropRow>
        </>
      ) : null}
    </>
  );
};

/**
 * ISS-5009: the Properties "Source" value.
 *
 * The catalog cell (`SourceLabel`) and this row render the SAME component's
 * source through two different code paths — this one prints the raw string
 * rather than going through `SourceLabel` — so both must be gated together or a
 * row shows an em dash in the catalog and its own identity key one click deeper.
 *
 * Behind the flag, a producer that reported no real provenance yields the same
 * em-dash glyph and the same explanation as the catalog cell; a producer that
 * found provenance yields that provenance. With the flag OFF, or against a
 * server old enough to omit `honestSource`, this is today's raw `source`
 * verbatim and nothing from the honest projection is read.
 */
function SourceRowValue({
  source,
  honestSource,
}: {
  source: string;
  honestSource: AgentComponentHonestSource | undefined;
}) {
  const honestSourceEnabled = useFeatureFlagEnabledOptional(
    AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY
  );

  if (honestSourceEnabled && honestSource) {
    if (honestSource.hasProvenance && honestSource.source !== null) {
      return <PropValue>{honestSource.source}</PropValue>;
    }
    return (
      <span
        className="truncate text-muted-foreground/50 text-sm"
        title={NO_SOURCE_RECORDED_TITLE}
      >
        None recorded
      </span>
    );
  }

  return <PropValue>{source}</PropValue>;
}

function PropertiesPanel({
  kind,
  source,
  honestSource,
  collaborators,
  properties,
}: {
  kind: AgentComponentKind;
  source: string;
  honestSource: AgentComponentHonestSource | undefined;
  collaborators: readonly string[];
  properties: AgentComponentProperties;
}) {
  const [open, setOpen] = useState(true);
  const KindIcon = kindMeta(kind).icon;

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger asChild>
        <button
          className="flex items-center gap-1.5 font-semibold text-lg tracking-tight"
          type="button"
        >
          Properties
          {open ? (
            <ChevronDownIcon className="size-5" />
          ) : (
            <ChevronRightIcon className="size-5" />
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2.5">
        <div className="flex flex-col gap-3.5 rounded-lg bg-muted/40 px-5 py-4">
          {/* Fixed + per-kind rows. Variable row count lives here so it can't
              shift the column position of the common trailing fields below. */}
          <div className="grid grid-cols-1 gap-x-12 gap-y-3.5 md:grid-cols-2">
            <PropRow icon={<KindIcon className="size-3.5" />} label="Type">
              <PropValue>{kindMeta(kind).label}</PropValue>
            </PropRow>

            <PropRow
              icon={<FolderGitIcon className="size-3.5" />}
              label="Source"
            >
              <SourceRowValue honestSource={honestSource} source={source} />
            </PropRow>

            {/* Harness is NOT restated here: the always-visible header eyebrow
                already owns it (FEA-4255), and Properties defaults open, so a
                Harness row would print the harness twice above the fold. Say it
                once — the eyebrow is the single home for the harness label. */}
            <PerKindProperties properties={properties} />
          </div>

          {/* FEA-4098 (Slice 3): Owner was removed — the Authors people-set
              (discoverer + editors from the version lineage) is the lone
              trailing people field, on its own divider so it never shifts with
              the variable per-kind rows above. FEA-4247: a leading UsersIcon
              aligns its value with the icon'd rows above (the value side
              otherwise started an icon-width left, reading as a broken column),
              and `singleAsText` shows a lone author as plain text so the
              now-common single-author case reads like its neighbours instead of
              hiding the name behind an initials-circle hover. FEA-4266: the row
              is labelled "Authors" (see AGENT_COMPONENT_AUTHORS_LABEL). */}
          <div className="border-border/60 border-t pt-3.5">
            <div className="grid grid-cols-1 gap-x-12 gap-y-3.5 md:grid-cols-2">
              <PropRow
                icon={<UsersIcon className="size-3.5" />}
                label={AGENT_COMPONENT_AUTHORS_LABEL}
              >
                <CollaboratorStack singleAsText users={collaborators} />
              </PropRow>
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// PromptPanel — read-only, shown only for Subagent / Command / Skill kinds
// ---------------------------------------------------------------------------

// Dropdown label for one revision. Versions arrive newest-first, so index 0 is
// the newest; the live revision is tagged "Current", the rest numbered from the
// oldest up, each disambiguated by a short content-hash prefix.
//
// `version.hash` is typed `string`, but the Prompt panel renders for Skill /
// Command / Subagent kinds and a malformed record can deliver a non-string hash;
// `coerceHash` guards the `.slice` so this never throws inside the page's
// LiveblocksErrorBoundary (FEA-3520, same class as #3208).
function versionLabel(
  version: ComponentVersion,
  index: number,
  total: number
): string {
  const tag = version.isCurrent ? "Current" : `Rev ${total - index}`;
  return `${tag} · #${coerceHash(version.hash).slice(0, 7)}`;
}

// The pre-ISS-5500 identity-level Definition empty-state copy, kept verbatim as
// the flag-OFF rendering so the closed default is byte-identical to what ships
// today.
const LEGACY_NO_DEFINITION_TITLE = "No definition captured";
const LEGACY_NO_DEFINITION_DESCRIPTION =
  "We haven't captured this component's definition yet.";

// Read-only Prompt panel with a content-hash version selector (FEA-2923). When
// more than one revision exists, a dropdown pages the panel text through the
// history (defaulting to the current revision); with 0–1 revisions it renders
// the plain current `prompt` with no selector.
//
// FEA-4255: the section header always renders for a prompt-carrying kind. When
// the definition body was never captured (`prompt` null and no revision carries
// content) the panel shows an HONEST empty state instead of silently vanishing,
// so the detail page reads as an inventory item rather than a dead end. The
// version selector still renders when history exists (a revision that has a
// hash but no captured body is legitimate), and paging to an empty revision
// falls through to the same empty state.
//
// ISS-5500: that empty state said the same thing for every reason a body can be
// absent, so a definition that was NEVER recorded (an orphan-only identity, the
// ticket's `skill::c22ccd46…`) rendered identically to one the org holds and
// failed to load. Behind AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY the
// identity-level copy is derived from `resolvedState` via
// `deriveDefinitionAbsence`, so the two cases can no longer share one blank.
function PromptPanel({
  prompt,
  resolvedState,
  truncated,
  versions,
}: {
  prompt: string | null;
  /**
   * ISS-5500: the org-folded resolution state, the ONLY input that separates a
   * definition that was never recorded from one that exists and did not load.
   * Typed as the detail DTO ships it; an unknown/absent value from a
   * version-skewed peer is honestly reported as indeterminate, never guessed.
   */
  resolvedState: ComponentResolvedState | string | null | undefined;
  /**
   * ISS-5029: the server's honest "this history is PARTIAL" claim — some
   * revision this component actually has is not in `versions`. NOT recomputed
   * here from `versions.length`: only the read whose cap bound can know it.
   */
  truncated: boolean;
  versions: readonly ComponentVersion[];
}) {
  const currentIndex = Math.max(
    0,
    versions.findIndex((v) => v.isCurrent)
  );
  const [selectedHash, setSelectedHash] = useState<string | null>(
    versions[currentIndex]?.hash ?? null
  );
  const activeIndex = versions.findIndex((v) => v.hash === selectedHash);
  const active = activeIndex >= 0 ? versions[activeIndex] : undefined;
  // The selected revision's body wins; fall back to the top-level `prompt` only
  // when no revision is selected (0-version case). An empty string is "no
  // captured content" — treat it the same as null so the empty state shows.
  const body = active?.content ?? prompt;
  const text = body ?? "";
  const hasContent = text.trim().length > 0;
  // ISS-5500: with the flag on, the identity-level empty state names WHY there
  // is no body, derived from the resolution metadata the detail already ships.
  // Flag off keeps the single legacy line verbatim (closed-by-default).
  const honestEmptyStateEnabled = useFeatureFlagEnabledOptional(
    AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY
  );
  // The panel derives from the SAME `ComponentResolutionInput` the header badge
  // is wired with — `resolvedState` refined by the CURRENT revision's normalizer
  // contract — computed off the same `versions` array by the same predicate, so
  // the two can never be handed different inputs and disagree.
  //
  // #4632 review: that parity is the whole reason the contract field is passed;
  // it is NOT, on its own, what keeps the badge and the panel telling one story.
  // Every resolved-family refinement (`resolved`, `stale-definition`,
  // `contract-mismatch`) maps to the same panel reason by design, so dropping the
  // input could not currently change what this panel says. It is wired anyway
  // because the badge's input is the contract, and a future reason split must
  // start from the same metadata rather than a narrower copy of it.
  //
  // `bodyCaptured` is read from the SELECTED REVISION's `content`, never from the
  // top-level `prompt`. `agent_component_versions.content` is NOT NULL, so a
  // revision that exists carries genuinely captured text (blank included), while
  // `prompt` is not that field on every surface: the desktop read
  // (`shared-agent-components-api.ts`) falls back to the frontmatter
  // `description` when `content` is null, so a component whose body was never
  // captured can still deliver a string here and would otherwise be reported as
  // captured. A body that WAS captured and is blank is a real, correctly-captured
  // empty definition, not a failure — the collector mints `resolved` whenever it
  // read the file successfully, including a 0-byte one.
  const currentVersion = versions.find((v) => v.isCurrent);
  const absence = deriveDefinitionAbsence(
    {
      resolvedState,
      normalizerContractVersion: currentVersion?.normalizerContractVersion,
    },
    typeof active?.content === "string"
  );
  // When history exists but the selected revision has no body, name that
  // revision in the DESCRIPTION so paging the dropdown reads as "THIS revision
  // is empty" rather than the same generic line on every one (FEA-4255).
  //
  // #4632 review: only the description is revision-scoped. The TITLE comes from
  // the absence model on both paths, because `revisionScoped` is
  // `versions.length > 1` — a property of how many revisions the identity happens
  // to carry, which is not a distinction a reader can act on. Keeping the legacy
  // title here made one blank body read "Definition is empty" at one revision and
  // "No definition captured" at two, so the headline disagreed with itself about
  // the same underlying fact.
  const revisionScoped = versions.length > 1 && active !== undefined;
  const emptyTitle = honestEmptyStateEnabled
    ? absence.title
    : LEGACY_NO_DEFINITION_TITLE;
  let emptyDescription = LEGACY_NO_DEFINITION_DESCRIPTION;
  if (revisionScoped && active) {
    emptyDescription = `${versionLabel(active, activeIndex, versions.length)} has no captured definition.`;
  } else if (honestEmptyStateEnabled) {
    emptyDescription = absence.description;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-semibold text-lg tracking-tight">Definition</h3>
        {versions.length > 1 ? (
          <Select
            onValueChange={setSelectedHash}
            value={selectedHash ?? undefined}
          >
            <SelectTrigger className="h-8 w-[200px]" size="sm">
              <span className="flex items-center gap-1.5">
                <HistoryIcon className="size-3.5 text-muted-foreground" />
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent align="end">
              {versions.map((version, index) => (
                <SelectItem key={version.hash} value={version.hash}>
                  {versionLabel(version, index, versions.length)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {hasContent ? (
        <div className="rounded-lg bg-muted/40 py-4 pr-2 pl-4">
          <div className="scrollbar-overlay max-h-96 overflow-auto pr-2">
            <div className="whitespace-pre-wrap text-sm leading-relaxed">
              {text}
            </div>
          </div>
        </div>
      ) : (
        // Keep the empty state inside the same rounded-lg bg-muted/40 box the
        // populated body uses, so the section holds its container and reads as
        // "empty" rather than losing its panel and looking unfinished.
        <div className="rounded-lg bg-muted/40">
          <EmptyState
            description={emptyDescription}
            icon={FileCodeIcon}
            size="compact"
            title={emptyTitle}
          />
        </div>
      )}
      {truncated ? (
        // Only rendered when a cap actually BOUND, so the caption stays a signal
        // rather than decoration. It deliberately does not name a count: the
        // whole point is that the number of dropped revisions is not known here.
        //
        // #4391 review: it sits BENEATH the body box, not above it, because
        // support copy belongs with the data it supports — the same placement
        // and `text-muted-foreground text-xs` treatment the partial-population
        // footers in `session-activity-breakdown.tsx` already use
        // (`CostUnavailableFooter`, `DerivedFooter`). Above the box it was
        // equidistant from the heading row and the body, so it read as
        // belonging to neither.
        //
        // The wording is a claim about the HISTORY, not about the dropdown,
        // because the two do not always co-occur: the version selector only
        // draws at `versions.length > 1`, while the truncation grounds can hold
        // for a family with a single retained revision. Copy that pointed at
        // "older revisions" would then point at a control that is not on
        // screen.
        <p className="text-muted-foreground text-xs">
          This component&rsquo;s revision history is partial.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentDetail — the public export
// ---------------------------------------------------------------------------

/**
 * Render-prop that receives the resolved component detail and returns a header
 * action node (e.g. an admin-gated "Promote & Distribute" control). Kept as a
 * surface-agnostic slot so the shell (apps/app) owns the Clerk-based admin gate
 * while this shared component stays free of any auth SDK.
 */
export type AgentDetailHeaderAction = (
  component: AgentComponentDetail
) => ReactNode;

/**
 * Render-prop that receives the resolved component detail and returns the
 * analytics section rendered below the Prompt panel (e.g. the HTTP-backed
 * "Token trend by model" chart on web).
 *
 * Kept as a surface-agnostic slot because the default chart is HTTP-only: it
 * fetches `GET /agent-components/{slug}/token-trend` via `useApiClient`. The
 * desktop shell omits this slot and renders its own IPC-backed
 * `OptimizationAnalyticsPanel` instead, which serves the equivalent trend from
 * the local DB. Desktop does have a cloud transport since PLN-1138 (the
 * main-process fetch bridge), but this endpoint is not on its authenticated
 * read path — a signed-out desktop gets a 401 and an authenticated one has no
 * component-scoped cloud source yet, so the slot stays surface-provided.
 */
export type AgentDetailAnalyticsSlot = (
  component: AgentComponentDetail
) => ReactNode;

export function AgentDetail({
  slug,
  headerAction,
  analytics,
  getSessionHref,
  backHref,
}: {
  slug: string;
  headerAction?: AgentDetailHeaderAction;
  analytics?: AgentDetailAnalyticsSlot;
  /**
   * Surface-injected builder for the session-detail link rendered on each
   * Sessions-tab row (FEA-3557 pattern). Web passes an org-scoped route
   * (`/{orgSlug}/sessions/{id}`), desktop a hash href; when omitted the name
   * renders as non-navigable text. Kept surface-provided so this shared
   * component hardcodes no route (see packages/app/AGENTS.md).
   *
   * ISS-5464: the parameter is the minimal `SessionHrefTarget` (`{ id }`), not a
   * full `SessionTableRow`. Both surfaces only ever read `.id` (web builds
   * `/{orgSlug}/sessions/{id}`, desktop `desktopSessionDetailHref`), and
   * requiring a whole row is what tied the Evidence tab's links to the
   * `sessionsTab` array — see `getInvocationSessionHref`. Widening the
   * parameter is call-site compatible: a full row still satisfies `{ id }`.
   */
  getSessionHref?: (session: SessionHrefTarget) => string;
  /**
   * Surface-injected href for the "Back to Agents" link rendered in the shared
   * not-found / unavailable states (FEA-3987), mirroring how BranchDetailPage /
   * the session detail thread their `backHref`. Required — both real mounts
   * (web wrapper + desktop `AgentDetailView`) always supply it, so the error
   * states always give the user a way out.
   */
  backHref: string;
}) {
  const { data, isLoading, isError, error } = useAgentComponentDetail(slug);
  // ISS-5518/5519 (ISS-4779 closed-by-default): the header's content-hash
  // subtitle and the dead Lines-shipped / Total-cost cards. The capped Merged
  // PRs disclosure left this flag in ISS-6462 — the Packs tile shows it ungated,
  // so gating it here made the two screens disagree. `Optional` because this
  // mounts without a flag provider (Storybook, the shared-component tests),
  // where it must resolve OFF rather than crash the subtree.
  const honestDetail = useFeatureFlagEnabledOptional(
    AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY
  );
  // FEA-3557/FEA-3294: durable permalinks for the Invocations tabs.
  // `/agents/<slug>?tab=branches|evidence` survives refresh/back-forward while
  // the default Sessions tab keeps the canonical URL clean.
  const { activeTab, setActiveTab } = useTabParam({
    defaultTab: "sessions",
    validTabs: ["sessions", "branches", "evidence"] as const,
  });
  const getInvocationSessionHref = useMemo(() => {
    if (!(data && getSessionHref)) {
      return undefined;
    }
    const adaptedRows = adaptAgentComponentSessions(data, data.sessionsTab);
    const rowBySessionIdentity = new Map<string, SessionTableRow>();
    data.sessionsTab.forEach((session, index) => {
      const row = adaptedRows[index];
      if (!row) {
        return;
      }
      rowBySessionIdentity.set(session.id, row);
      rowBySessionIdentity.set(session.externalSessionId, row);
    });
    // ISS-5464: `sessionsTab` is a BOUNDED payload (50 rows), but an invocation
    // row may belong to any of the component's sessions. Resolving links only
    // through that array made every Evidence row on a heavy component
    // non-navigable — measured 78% -> 0% link coverage for `tool::Bash` when the
    // bound landed. `usageSessions` carries one row per session that used this
    // component and is NOT bounded, so it is the correct existence set: a link
    // is rendered iff the invocation's session genuinely used this component,
    // and the href needs only the canonical id the invocation already carries.
    const sessionIdsThatUsedComponent = new Set(
      data.usageSessions.map((usage) => usage.sessionId)
    );
    return (sessionId: string) => {
      const row = rowBySessionIdentity.get(sessionId);
      if (row) {
        return getSessionHref(row);
      }
      return sessionIdsThatUsedComponent.has(sessionId)
        ? getSessionHref({ id: sessionId })
        : null;
    };
  }, [data, getSessionHref]);

  if (isLoading) {
    return <AgentDetailLoading />;
  }

  // Split a genuine 404 (the component doesn't exist) from a transient provider
  // failure (gateway down, API 5xx) so a read that just failed never tells the
  // user the component is missing (FEA-3987). Mirrors the sibling session/branch
  // detail contract (`classifyDetailError`). A settled read with no data and no
  // error object degrades to not-found.
  if (isError || !data) {
    return classifyDetailError(error) === DetailErrorKind.ProviderError ? (
      <AgentDetailUnavailable backHref={backHref} />
    ) : (
      <AgentDetailNotFound backHref={backHref} />
    );
  }

  const metrics = componentMetrics(data, { honest: honestDetail });
  const path = data.properties.path;

  // The component's honest resolution state, refined by the CURRENT revision's
  // fingerprint metadata so a definition captured under an unknown normalizer
  // contract surfaces as `contract-mismatch` rather than a bare "resolved". The
  // shared model derives + labels; this component never re-implements the states.
  const currentVersion = data.versions.find((v) => v.isCurrent);

  return (
    <div className="flex-1 overflow-auto">
      {/* Title, properties, prompt, and metrics stay inset (centered column). */}
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 pt-10 pb-6">
        <DetailHeader
          action={headerAction?.(data)}
          harness={data.harness}
          honest={honestDetail}
          kind={data.kind}
          name={data.name}
          path={path}
          resolution={
            <ResolutionBadge
              normalizerContractVersion={
                currentVersion?.normalizerContractVersion
              }
              resolvedState={data.resolvedState}
            />
          }
          slug={data.slug}
        />

        <div
          className={cn(
            "grid grid-cols-2 gap-3 sm:grid-cols-3",
            // ISS-5519: deliberately UNCHANGED. Suppressing the two unmeasured
            // cards takes a subagent from six to four, and four cards in a
            // five-column track is already exactly how every non-verifiable kind
            // renders today — so the shipped layout absorbs the new count with no
            // edit. Deriving the track from the card count instead would have
            // re-flowed those other kinds too, on a flag that drops none of their
            // cards (metric-reconciliation review).
            metrics.length >= 6 ? "lg:grid-cols-6" : "lg:grid-cols-5"
          )}
        >
          {metrics.map((metric) => (
            <MetricCard
              info={metric.info}
              key={metric.key}
              label={metric.label}
              value={metric.value}
            />
          ))}
        </div>

        <PropertiesPanel
          collaborators={resolveComponentAuthors(data)}
          honestSource={data.honestSource}
          kind={data.kind}
          properties={data.properties}
          source={data.source}
        />

        {/* FEA-4255: render the Definition section for every prompt-carrying
            kind (subagent/command/skill with an invocation signal), even when
            the body is missing — the panel owns the honest "No definition
            captured" empty state. Non-prompt kinds (Hook/Config/Tool/…) still
            show no Definition section: they legitimately carry no body. */}
        {hasVersionHistoryAffordance(data.kind) ? (
          // Key the panel by the component identity (`slug`) so its local
          // `selectedHash` revision selection is reset on same-component
          // navigation. On desktop the detail view can swap `data` in place
          // (cached B replaces A without unmounting AgentDetail); without this
          // key A's selected revision would survive into B, showing "No
          // definition captured" even when B's current revision has content and
          // leaving the Select value out of B's option set (wongk review).
          <PromptPanel
            key={data.slug}
            prompt={data.prompt}
            // ISS-5500: the same org-folded state the header badge renders, so
            // the badge and the Definition panel can never tell two stories.
            resolvedState={data.resolvedState}
            // ISS-5029: absent (an older cloud, or the desktop's own uncapped
            // local read) means "no evidence of truncation" — no marker, exactly
            // today's rendering.
            truncated={data.versionsTruncated === true}
            versions={data.versions}
          />
        ) : null}

        {analytics?.(data)}
      </div>

      {/* The Sessions/Branches table spans the full page width. */}
      <div className="pb-6">
        <Tabs className="gap-4" onValueChange={setActiveTab} value={activeTab}>
          <div className="flex flex-wrap items-center justify-between gap-4 px-4">
            <h3 className="font-semibold text-lg tracking-tight">
              Invocations
            </h3>
            <div className="flex items-center gap-2">
              <TabsList>
                <TabsTrigger value="sessions">Sessions</TabsTrigger>
                <TabsTrigger value="branches">Branches</TabsTrigger>
                <TabsTrigger value="evidence">Evidence</TabsTrigger>
              </TabsList>
            </div>
          </div>
          <TabsContent value="sessions">
            <DetailSessionsTab
              component={data}
              getSessionHref={getSessionHref}
              sessions={data.sessionsTab}
              sessionsTabTruncated={data.sessionsTabTruncated}
              usageSessions={data.usageSessions}
              versions={data.versions}
            />
          </TabsContent>
          <TabsContent value="branches">
            <DetailBranchesTab
              branches={data.branchesTab}
              branchesTabTruncated={data.branchesTabTruncated}
              usageSessions={data.usageSessions}
              versions={data.versions}
            />
          </TabsContent>
          <TabsContent value="evidence">
            {data.invocationRows ? (
              <InvocationEvidenceList
                getSessionHref={getInvocationSessionHref}
                page={data.invocationRows}
              />
            ) : (
              <EmptyState
                description="This data source does not record exact invocation evidence."
                icon={FileX2Icon}
                size="compact"
                title="Evidence unavailable"
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
