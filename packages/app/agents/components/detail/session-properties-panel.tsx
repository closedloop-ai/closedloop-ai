"use client";

import type {
  AgentSessionDetail,
  SessionLinkedArtifact,
  SessionPR,
} from "@repo/api/src/types/agent-session";
import type { DisplayedSessionStatus } from "@repo/api/src/types/session-status";
import { foldToDisplayedSessionStatus } from "@repo/api/src/types/session-status";
import { TOTAL_ESTIMATED_COST_ALIAS_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { getStatusDisplay } from "@repo/app/agents/components/detail/session-status-display";
import {
  formatCodexRateLimitWindow,
  formatCodexRateLimitWindowLabel,
} from "@repo/app/agents/lib/codex-rate-limit-format";
import {
  costLabelIsFigure,
  deriveCostAvailability,
  deriveSessionCostLabel,
  hasRecordedTokenUsage,
} from "@repo/app/agents/lib/cost-availability";
import { resolveSessionOwner } from "@repo/app/agents/lib/session-owner";
import {
  resolveSessionRepositoryFullName,
  SESSION_REPOSITORY_UNKNOWN_LABEL,
} from "@repo/app/agents/lib/session-repository-label";
import { UNKNOWN_MODEL_LABEL } from "@repo/app/agents/lib/session-timeline-stacks";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { sessionStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import {
  SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
  SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY,
  SESSION_TOUCHED_BRANCHES_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { activateOnEnterOrSpace } from "@repo/design-system/lib/keyboard-activation";
import { cn } from "@repo/design-system/lib/utils";
import type { LucideIcon } from "lucide-react";
import {
  BotIcon,
  ChevronRightIcon,
  CircleDollarSignIcon,
  CpuIcon,
  FileDiffIcon,
  FingerprintIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitPullRequestIcon,
  StepForwardIcon,
  TerminalIcon,
  TimerIcon,
  UserIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  type CodexRateLimitWindowView,
  type CodexRuntimeMetadata,
  extractCodexRuntimeMetadata,
} from "./codex-runtime-metadata";
import { PropertyValue } from "./property-values";
import { SessionBranchesRow } from "./session-branches-row";
import { SessionDurationProperty } from "./session-duration-property";
import {
  CacheWriteTtlProperty,
  SessionCostValue,
  SessionLaunchAttributionProperties,
  SessionSyncProperty,
} from "./session-flagged-properties";
import { SessionLinkedArtifactsRow } from "./session-linked-artifacts-row";
import { SessionLocPerDollarProperty } from "./session-loc-per-dollar-property";
import {
  SessionAutonomyProperty,
  SessionTokensProperty,
  SessionWorkProperty,
} from "./session-measured-properties";
import {
  joinPropertySentences,
  resolveMetricProvenanceNote,
  SessionProvenanceMetric,
} from "./session-metric-provenance";
import { SessionOtherRepositoriesRow } from "./session-other-repositories-row";
import { SessionOutputDiff } from "./session-output-diff";
import { SESSION_COST_POPULATION_NOTE } from "./session-population-notes";
import { SessionPullRequestsRow } from "./session-pull-requests-row";
import { resolveDisplayedBranches } from "./values/session-branches-value";

/**
 * ISS-5818: the Session detail PROPERTIES panel — its disclosure shell, the
 * expanded row set (including the Codex runtime rows), the collapsed preview
 * strip, and the one derivation (`getSessionPropertySummary`) all three read so
 * they cannot disagree about a session.
 *
 * Split out of `agent-session-detail-view.tsx` rather than grown inside it
 * (packages/../AGENTS.md → "File Size and Organization"). The seam is a real
 * responsibility boundary, not a line
 * count: everything here answers "what does this session\u2019s record say about
 * itself", and nothing here knows anything about the timeline strip, the trace,
 * or the comments rail that the view still owns. ISS-5818 moved this panel above
 * the Timeline, so it was the block this change was already handling.
 */

export function SessionPropertiesPanel({
  session,
  buildArtifactHref,
  artifactHrefPending,
  displayedStatus,
  getBranchHref,
  transcriptNeverExpected,
}: Readonly<{
  session: AgentSessionDetail;
  /** The same derived status rendered in the detail header. */
  displayedStatus?: DisplayedSessionStatus;
  buildArtifactHref?: (artifact: SessionLinkedArtifact) => string | null;
  /**
   * ISS-5366: true while the shell still cannot say whether artifact links are
   * reachable, so the pills must not yet assert either answer. See
   * {@link SessionLinkedArtifactsRow}.
   */
  artifactHrefPending?: boolean;
  getBranchHref?: (branchArtifactId: string) => string;
  /** ISS-7516: forwarded to the Sync row; `SessionTranscriptPanel` owns the contract. */
  transcriptNeverExpected?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const status = displayedStatus ?? session.status;
  const legacySummary = getSessionPropertySummary(session, status);
  // ISS-10364 (operator ruling): an unparsable session status reads Active
  // everywhere, so the champion sees the folded displayed status only, the
  // same value the header badge renders.
  const statusView = sessionStatusView(
    session.id,
    foldToDisplayedSessionStatus(status)
  );
  const summary = champion
    ? {
        ...legacySummary,
        statusLabel: artifactStatusLabel(statusView),
        statusLeading: (
          <ArtifactStatus
            variant={ArtifactStatusVariant.Icon}
            view={statusView}
          />
        ),
      }
    : legacySummary;
  return (
    <section className="prd-props-section sd3-props" data-open={open}>
      {/* biome-ignore lint/a11y/useSemanticElements: FEA-1769 specifies div role="button" instead of a semantic button for design parity. */}
      <div
        className="prd-props-header"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={activateOnEnterOrSpace(() => setOpen((value) => !value))}
        role="button"
        tabIndex={0}
      >
        <span className="prd-props-title">Properties</span>
        <span className="prd-props-chevron">
          <ChevronRightIcon aria-hidden className="size-4" />
        </span>
      </div>

      {open ? (
        <SessionPropertiesExpanded
          artifactHrefPending={artifactHrefPending}
          buildArtifactHref={buildArtifactHref}
          getBranchHref={getBranchHref}
          session={session}
          summary={summary}
          transcriptNeverExpected={transcriptNeverExpected}
        />
      ) : (
        <SessionPropertiesPreview
          onOpen={() => setOpen(true)}
          session={session}
          summary={summary}
        />
      )}
    </section>
  );
}

type SessionPropertySummary = {
  model: string;
  prs: SessionPR[];
  /** FEA-3635: FEATs/PRDs the transcript referenced or created. */
  linkedArtifacts: SessionLinkedArtifact[];
  /**
   * ISS-4449: the true resolved DOCUMENT-link total before the server's display
   * cap. When it exceeds `linkedArtifacts.length` the pill row was truncated and
   * renders an honest "N of M" caption. Falls back to the served length when a
   * version-skewed producer omits it, so no truncation is ever falsely claimed.
   */
  linkedArtifactsTotal: number;
  repo: string;
  /**
   * FEA-3780: did a Git remote actually resolve? `repo` carries the shared
   * "Unknown" label when it did not, and absent data must not render like a
   * value (mono, full-strength) next to real `owner/repo` names — the Sessions
   * list already renders this state muted.
   */
  repoResolved: boolean;
  // FEA-4287: the status display (label + icon) resolved once from the session
  // state via `getStatusDisplay`, so the expanded Status row cannot disagree
  // with anything else derived from it.
  statusLabel: string;
  statusIcon: LucideIcon;
  statusLeading?: ReactNode;
};

/**
 * FEA-3703 / FEA-3993: the persisted Codex runtime-metadata rows (context
 * window + latest-turn utilization, latest per-turn token-usage COUNTS, and the
 * latest rate-limit windows). Split out of `SessionPropertiesExpanded`
 * (cognitive-complexity budget), mirroring the flag-gated rows in
 * `session-flagged-properties.tsx`.
 * Graduated out of Labs (FEA-3993): renders unconditionally for everyone,
 * self-gating on presence — it renders nothing when the session carries no
 * Codex runtime metadata, so non-Codex sessions and every pre-FEA-3524/3525/3526
 * payload show nothing rather than empty rows. COUNTS ONLY — no raw
 * reasoning/message content.
 */
function CodexRuntimeProperties({
  session,
}: Readonly<{ session: AgentSessionDetail }>) {
  const runtime: CodexRuntimeMetadata | null = extractCodexRuntimeMetadata(
    session.metadata
  );
  if (!runtime) {
    return null;
  }
  const { modelContextWindow, latestTokenUsage, rateLimits } = runtime;
  return (
    <>
      {modelContextWindow == null ? null : (
        <PropertyValue icon={CpuIcon} label="Context window" mono>
          {modelContextWindow.toLocaleString()} tokens
          {runtime.contextWindowUtilizationPercent == null
            ? ""
            : ` | ${Math.round(runtime.contextWindowUtilizationPercent)}% used (latest turn)`}
        </PropertyValue>
      )}
      {latestTokenUsage == null ? null : (
        <PropertyValue icon={StepForwardIcon} label="Latest turn tokens" mono>
          {latestTokenUsage.input.toLocaleString()} in |{" "}
          {latestTokenUsage.output.toLocaleString()} out |{" "}
          {latestTokenUsage.cacheRead.toLocaleString()} cache read |{" "}
          {latestTokenUsage.cacheWrite.toLocaleString()} cache write
        </PropertyValue>
      )}
      <CodexRateLimitProperty window={rateLimits?.primary ?? null} />
      <CodexRateLimitProperty window={rateLimits?.secondary ?? null} />
    </>
  );
}

/**
 * One Codex rate-limit row, named by its own window duration ("Rate limit
 * (5h)", "Rate limit (weekly)") rather than the payload's primary/secondary
 * slot (FEA-3993), with the window duration lifted out of the value. Falls back
 * to a bare "Rate limit" when the window carries no duration. Renders nothing
 * when the window is absent, keeping the presence self-gate.
 */
function CodexRateLimitProperty({
  window,
}: Readonly<{ window: CodexRateLimitWindowView | null }>) {
  if (window == null) {
    return null;
  }
  const windowLabel = formatCodexRateLimitWindowLabel(window.windowMinutes);
  const label = windowLabel ? `Rate limit (${windowLabel})` : "Rate limit";
  return (
    <PropertyValue icon={TimerIcon} label={label} mono>
      {formatCodexRateLimitWindow(window)}
    </PropertyValue>
  );
}

function SessionPropertiesExpanded({
  session,
  summary,
  buildArtifactHref,
  artifactHrefPending,
  getBranchHref,
  transcriptNeverExpected,
}: Readonly<{
  session: AgentSessionDetail;
  summary: SessionPropertySummary;
  /** ISS-7516: forwarded to the Sync row; `SessionTranscriptPanel` owns the contract. */
  transcriptNeverExpected?: boolean;
  buildArtifactHref?: (artifact: SessionLinkedArtifact) => string | null;
  /**
   * ISS-5366: true while the shell still cannot say whether artifact links are
   * reachable, so the pills must not yet assert either answer. See
   * {@link SessionLinkedArtifactsRow}.
   */
  artifactHrefPending?: boolean;
  getBranchHref?: (branchArtifactId: string) => string;
}>) {
  // FEA-4256: the session detail's in-app seam to the branch it shipped is the
  // Branch row alone — linked when the shell supplies a builder AND a branch
  // artifact resolved AND the value is a real branch name (never the "None"
  // placeholder). Repository stays plain text (its label reads "repository", so
  // a click must not land on a branch), and the PR pill stays external (its
  // content is the PR's identity, so a click opens the PR — two PRs on one
  // branch stay two destinations). Say the seam once, on the row whose identity
  // IS the branch.
  const branchHref =
    session.branch && session.branchArtifactId && getBranchHref
      ? getBranchHref(session.branchArtifactId)
      : null;
  // ISS-8427 (ISS-4779 closed-by-default): the plural Branches row is a
  // perceivable change to a pane both surfaces mount, so it is gated on web
  // (PostHog) and desktop (Labs) over one key. Branch AT the read — the boolean
  // is never handed on, so `no-threaded-feature-flag` has nothing to allowlist.
  // With the gate closed `branches` is null, which is the same value a producer
  // that computed no set yields, and the pane renders today's row unchanged.
  const touchedBranchesEnabled =
    useFeatureFlagEnabledOptional(SESSION_TOUCHED_BRANCHES_FEATURE_FLAG_KEY) ===
    true;
  // null means "render the single-branch row unchanged" — see
  // {@link resolveDisplayedBranches}.
  const branches = touchedBranchesEnabled
    ? resolveDisplayedBranches(session)
    : null;
  // ISS-7427 (AC4): ONE read for the three rows that share the gate — Cost here,
  // Tokens and Duration threaded down. Reading it per row would put three
  // subscriptions behind one disclosure and let a future refactor gate one of
  // the three differently, which is the split this ticket exists to close.
  const discloseEvidence =
    useFeatureFlagEnabledOptional(
      SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY
    ) === true;
  // ISS-7737's population sentence is a SEPARATE, independently-rolled-out
  // disclosure on the same rows, not a duplicate of the one above: it names WHAT
  // each figure counts, where `discloseEvidence` names WHERE the figure came
  // from. Two keys because they are two rollouts; both default OFF.
  const populationDisclosed = useFeatureFlagEnabledOptional(
    SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY
  );
  // PLN-2061 M5: the Other repositories row wraps tall like the Branches row, so
  // it triggers the same ISS-8427 top-alignment, and only when it renders.
  const untrackedRepositoryTargets = session.untrackedRepositoryTargets ?? [];
  const topAligned = Boolean(branches) || untrackedRepositoryTargets.length > 0;
  // FEA-3330 / FEA-3725: the Owner row is always shown (in step with the
  // Sessions table column and filter facet). The Owner is the assignee
  // (ISS-12251 D-1, `resolveSessionOwner`); with none, it renders the shared
  // em-dash `GridEmptyValue` — the same null-owner convention the Sessions
  // table column uses, keeping the two surfaces consistent.
  const owner = resolveSessionOwner(session);
  // ISS-8427: the top-alignment the tall Branches row needs rides WITH that
  // row, never ahead of it — an unscoped `.prd-props { align-items: start }`
  // re-aligned every session's pane with the gate shut.
  return (
    <div
      className={topAligned ? "prd-props sd3-props-top-aligned" : "prd-props"}
    >
      <PropertyValue
        icon={summary.statusLeading ? null : summary.statusIcon}
        label="Status"
        leading={summary.statusLeading}
      >
        {summary.statusLabel}
      </PropertyValue>
      <SessionSyncProperty
        session={session}
        transcriptNeverExpected={transcriptNeverExpected}
      />
      <PropertyValue icon={UserIcon} label="Owner">
        {owner ? getUserDisplayName(owner) : <GridEmptyValue />}
      </PropertyValue>
      <PropertyValue icon={TerminalIcon} label="Harness">
        {session.harness}
      </PropertyValue>
      {/* ISS-7259: how the harness said this thread came to run, immediately
          after the Harness row that names which harness said it. Self-gating on
          both the ISS-4779 flag and presence — a session whose harness stamped
          no attribution renders nothing here. */}
      <SessionLaunchAttributionProperties session={session} />
      <PropertyValue
        copyValue={session.externalSessionId}
        icon={FingerprintIcon}
        label="Session ID"
        mono
      >
        {session.externalSessionId}
      </PropertyValue>
      {/* FEA-3780: an unresolved remote renders muted and non-mono, matching
          the Sessions list's empty repo cell — absent data must not sit next to
          real `owner/repo` names looking like a repository named "Unknown". */}
      <PropertyValue
        icon={FolderGit2Icon}
        label="Repository"
        mono={summary.repoResolved}
      >
        {summary.repoResolved ? (
          summary.repo
        ) : (
          <span className="text-muted-foreground">{summary.repo}</span>
        )}
      </PropertyValue>
      <SessionDurationProperty
        discloseEvidence={discloseEvidence}
        session={session}
      />
      <SessionTokensProperty
        discloseEvidence={discloseEvidence}
        session={session}
      />
      <CacheWriteTtlProperty session={session} />
      <CodexRuntimeProperties session={session} />
      <SessionAutonomyProperty session={session} />
      <PropertyValue icon={BotIcon} label="Model" mono>
        {summary.model}
      </PropertyValue>
      {branches ? (
        <SessionBranchesRow branches={branches} getBranchHref={getBranchHref} />
      ) : (
        <PropertyValue
          href={branchHref}
          icon={GitBranchIcon}
          label={SESSION_BRANCH_ROW_LABEL}
          mono
        >
          {session.branch ?? "None"}
        </PropertyValue>
      )}
      <SessionPullRequestsRow
        prs={summary.prs}
        repositoryFullName={getSessionRepositoryFullName(session)}
      />
      <SessionOtherRepositoriesRow targets={untrackedRepositoryTargets} />
      {/* FEA-4378: LOC is its own labeled fact, not a value trailing the PR pills
          — a number after the pills reads as "LOC for those PRs" when it is really
          the session's working-tree diff. Same PropertyValue row every other fact
          in this pane uses (Tokens, Duration, Autonomy, Branch); the value shows
          the honest +added / -removed working-tree diff, or the summed authored-PR
          roll-up qualified "in merged PRs" when that is the larger, real delivered code. */}
      <PropertyValue icon={FileDiffIcon} label="Lines changed" mono>
        <SessionOutputDiff session={session} />
      </PropertyValue>
      {/* FEA-3635 / ISS-4449: FEATs/PRDs/PLNs the transcript referenced or
          created. The data model supports every navigable document type, so the
          row is labeled "Linked artifacts" (type-agnostic) and each pill names
          its own kind via its title. Renders up to a few pills plus a reachable
          `+N` overflow chip when the resolved total exceeds them, so a truncated
          set is never silently dropped nor a dead-end count. Renders nothing when
          no link resolved. */}
      <SessionLinkedArtifactsRow
        artifactHrefPending={artifactHrefPending}
        buildArtifactHref={buildArtifactHref}
        linkedArtifacts={summary.linkedArtifacts}
        total={summary.linkedArtifactsTotal}
      />
      {/* ISS-4418: route the Cost through the shared `deriveSessionCostLabel`
          (the same derivation the Sessions table and the detail Cost metric
          use) rather than the raw pre-formatted `session.cost`, so a zero-usage
          session reads the honest `—` here too instead of a fabricated
          `$0.00`/stale dollar value that would contradict the metric card. */}
      {/* ISS-7427 (AC4): the $5,994.85 on the reported screen is this row. It is
          priced off the synced usage rollup, which the archive never fed — so
          when the server says the main transcript is terminally absent, the row
          says where its figure came from rather than leaving the reader to
          reconcile it against a panel that renders nothing. Gated on a REAL
          figure: a Cost dash has no provenance to state.

          Two independently-gated sentences share this row after the ISS-7737
          merge — what the figure counts, then where it came from — joined by the
          shared `joinPropertySentences` so either flag alone still yields one
          clean sentence and neither can clobber the other's `explanation`. */}
      <PropertyValue
        explanation={joinPropertySentences(
          costPopulationNote(session, populationDisclosed),
          resolveMetricProvenanceNote({
            disclosureEnabled: discloseEvidence,
            evidenceCoverage: session.evidenceCoverage,
            metric: SessionProvenanceMetric.Cost,
            // AND the usage predicate, not the paint verdict alone.
            // `Subscription` renders `$0.00` for a session that took a turn but
            // consumed no tokens, and "priced from synced usage" on an all-zero
            // rollup claims a source the producer says it cannot tell apart from
            // a default. `costLabelIsFigure` is the canonical predicate main
            // extracted for exactly this question; ISS-7427's own
            // `isCostFigureRendered` copy was folded into it on merge.
            valueIsSourceBacked:
              costLabelIsFigure(deriveCostAvailability(session)) &&
              hasRecordedTokenUsage(session),
          })
        )}
        icon={CircleDollarSignIcon}
        label={TOTAL_ESTIMATED_COST_ALIAS_LABEL}
        mono
      >
        {/* ISS-7229: Claude's own reported figure rides INSIDE this
            row's value rather than in a sibling row. `.prd-props` is a
            multi-column `auto-fit` grid, so a second row was an independent grid
            item — at two columns the estimate sat right while "Claude reported"
            landed in the LEFT column a line below, labelling nothing. Self-gates
            on the ISS-4779 flag and on presence; absent, this renders exactly
            the bare estimate it always did. */}
        <SessionCostValue
          estimate={deriveSessionCostLabel(session)}
          session={session}
        />
      </PropertyValue>
      {/* FEA-3630 / ISS-4667: per-session LOC/$ next to Cost — its numerator is
          this panel's own "Lines changed" and its denominator this panel's own
          Cost, so all three reconcile on the card. */}
      <SessionLocPerDollarProperty session={session} />
      <SessionWorkProperty session={session} />
    </div>
  );
}

function SessionPropertiesPreview({
  onOpen,
  session,
  summary,
}: Readonly<{
  onOpen: () => void;
  session: AgentSessionDetail;
  summary: SessionPropertySummary;
}>) {
  return (
    <button className="sd3-props-preview" onClick={onOpen} type="button">
      {/* ISS-5818 (design review): NO status here. The title one line up already
          carries a status chip, and repeating it in this strip would state the
          same fact twice in one viewport. The original reason was stronger —
          this strip read a SECOND axis (`AgentSessionState`) that could
          legitimately disagree with the chip above it ("Stale" over "Running").
          ISS-7019 deleted that axis, so the two can no longer contradict each
          other, but the design call to keep the preview status-free stands.
          The prototype's preview likewise carries model + repo + PR count and no
          status. */}
      <span className="sd3-pp mono" title={summary.model}>
        <BotIcon aria-hidden className="size-3" />
        <span className="min-w-0 truncate">{summary.model}</span>
      </span>
      {/* FEA-3780: the title exists to reveal a truncated full name, so it is
          dropped when there is nothing to reveal — otherwise the tooltip just
          repeats the visible "Unknown" a pixel away. Unresolved also renders
          muted and non-mono, matching the Sessions list's empty repo cell. */}
      <span
        className={cn("sd3-pp", summary.repoResolved && "mono")}
        title={summary.repoResolved ? summary.repo : undefined}
      >
        <FolderGit2Icon aria-hidden className="size-3" />
        <span
          className={cn(
            "min-w-0 truncate",
            !summary.repoResolved && "text-muted-foreground"
          )}
        >
          {summary.repo}
        </span>
      </span>
      <span className="sd3-pp mono">
        <CircleDollarSignIcon aria-hidden className="size-3" />
        {/* ISS-4418: the derived honest label — never a raw
            `session.cost ?? "$0.00"` that could contradict the Cost metric.
            ISS-5072: this reads the shared `deriveSessionCostLabel` directly.
            It previously indexed the detail-content builder's Cost metric
            (`content.metrics[2]`), which is built from that SAME
            `formatCostLabel(deriveCostAvailability(session), …)` pair — so the
            rendered string is unchanged, and the page no longer builds the
            whole discarded view-model over `session.events` to read one field
            out of it. */}
        {deriveSessionCostLabel(session)}
      </span>
      <span className="sd3-pp">
        <GitPullRequestIcon aria-hidden className="size-3" />
        {formatPrCountLabel(session)}
      </span>
    </button>
  );
}

function getSessionPropertySummary(
  session: AgentSessionDetail,
  displayedStatus: string
): SessionPropertySummary {
  const linkedArtifacts = session.linkedArtifacts ?? [];
  // ISS-7019: the displayed status, the same value the Sessions list renders.
  // Was `session.state` (`AgentSessionState`), a second axis now deleted.
  const statusDisplay = getStatusDisplay(displayedStatus);
  const repositoryFullName = resolveSessionRepositoryFullName(session);
  return {
    model: session.primaryModel ?? session.model ?? UNKNOWN_MODEL_LABEL,
    prs: session.prs ?? [],
    linkedArtifacts,
    // ISS-4449: the wire carries the FULL resolved link set (the API no longer
    // caps it — the display cap is applied in SessionLinkedArtifactsRow), so the
    // true total is at least the served length. Take the max so a version-skewed
    // payload that omits `linkedArtifactsTotal` still reports an honest total and
    // never under-counts below what it actually shipped.
    linkedArtifactsTotal: Math.max(
      session.linkedArtifactsTotal ?? 0,
      linkedArtifacts.length
    ),
    // FEA-3780: resolved Git-remote evidence only. The former
    // `?? session.cwd` fallback rendered a raw working directory — a numbered
    // worktree dir, or `/` for a session run at filesystem root — as this
    // session's repository, for exactly the sessions the Sessions list reports
    // as "Unknown". See `session-repository-label`.
    repo: repositoryFullName ?? SESSION_REPOSITORY_UNKNOWN_LABEL,
    repoResolved: repositoryFullName !== null,
    statusLabel: statusDisplay.label,
    statusIcon: statusDisplay.icon,
  };
}

function getSessionRepositoryFullName(
  session: AgentSessionDetail
): string | null {
  return resolveSessionRepositoryFullName(session);
}

function getPrCount(session: AgentSessionDetail): number {
  // Total PRs associated with the session. Prefer the resolved `prs` list
  // (present on every synced/local detail); only fall back to `prsMerged` for
  // stale payloads that carry the count without the list. `prsMerged` must not
  // lead: it is legitimately 0 when PRs are opened-but-not-merged, and a
  // `session.prsMerged ?? …` chain never falls through 0, so the header
  // collapsed to "0" despite present PRs (FEA-3329).
  return session.prs?.length ?? session.prsMerged ?? 0;
}

function formatPrCountLabel(session: AgentSessionDetail): string {
  // Label matches what `getPrCount` counts (total PRs, not merged-only), so a
  // session with 7 opened / 0 merged PRs reads "7 PRs" rather than the old,
  // misleading "0 PRs merged" (FEA-3329).
  const count = getPrCount(session);
  return `${count} ${count === 1 ? "PR" : "PRs"}`;
}

/**
 * ISS-7737: the Cost row's population sentence, or `undefined` when the row has
 * no dollars to describe.
 *
 * Gated on `costLabelIsFigure`, the predicate `formatCostLabel` itself answers
 * from, so the sentence is stated exactly when the row shows dollars and never
 * when it shows a dash — naming what a dash covers describes a sum nobody
 * computed. Keying this on `CostAvailability.Available` instead was the review's
 * catch: `Subscription` prints its covered spend through the very same
 * `formatCost` call, so an `Available`-only gate annotated Turns and Tokens and
 * then went silent on the dollar figure four rows down for every
 * subscription-billed session — the ticket's own reported harm, rebuilt inside
 * the fix.
 */
function costPopulationNote(
  session: AgentSessionDetail,
  disclosed: boolean | undefined
): string | undefined {
  if (!disclosed) {
    return undefined;
  }
  return costLabelIsFigure(deriveCostAvailability(session))
    ? SESSION_COST_POPULATION_NOTE
    : undefined;
}

/** The single-branch row's label, shown when the payload carries no branch set. */
export const SESSION_BRANCH_ROW_LABEL = "Branch";
