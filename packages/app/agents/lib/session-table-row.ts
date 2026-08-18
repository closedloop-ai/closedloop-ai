import {
  type AgentSessionListItem,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import { classifySessionProvenance } from "@repo/api/src/types/branch";
import type { SessionTableRow } from "@repo/app/agents/components/sessions/sessions-table";
import {
  deriveCostAvailability,
  formatCostLabel,
  getCostTooltip,
} from "@repo/app/agents/lib/cost-availability";
import { resolveDisplayedSessionStatusWithWaiting } from "@repo/app/agents/lib/session-displayed-status-with-waiting";
import {
  resolveSessionDurationWindow,
  resolveSessionWallClockLabel,
  toSessionInstant,
} from "@repo/app/agents/lib/session-duration";
import {
  resolveSessionRepositoryDisplay,
  resolveSessionRepositoryFullName,
} from "@repo/app/agents/lib/session-repository-label";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";

/**
 * Repository identity for a session row (FEA-4274): the resolved Git remote
 * `repositoryFullName` (e.g. `owner/repo`), or `null` when no remote has
 * resolved yet and the cell should render its honest "Unknown".
 *
 * The rule itself — Git-remote evidence only, never a working/worktree
 * directory — and the shared "Unknown" label live in `session-repository-label`
 * so the list and the session-detail surfaces cannot drift (FEA-3780). This
 * stays as the Sessions-table-shaped seam over it.
 */
export function resolveSessionRepoLabel(
  item: AgentSessionListItem
): string | null {
  return resolveSessionRepositoryFullName(item);
}

/**
 * Single mapper from the cloud `AgentSessionListItem` shape to the shared
 * presentational `SessionTableRow`. Consumed by both the web Sessions adapter
 * and the shared `SyncedSessionsTable` so the surfaces never drift.
 *
 * `repo` is the display label resolved by the caller (see
 * `resolveSessionRepoLabel`); pass `null` to render the empty placeholder.
 *
 * ISS-4996 / ISS-4998 (gate retired by ISS-5366, shipped ON): the row carries
 * the DISPLAYED status — an unrecognized or long-silent run reads "Unknown"
 * rather than claiming the agent is running — and the reason a repository has no
 * label, so the cell can tell absent from unreadable.
 *
 * That derivation rides an options bag rather than positional parameters, so
 * every seam that already forwards render-boundary options — including
 * `detail-data.ts` and `agent-component-session-adapter.ts` — carries the clock
 * too and the Agent-detail Sessions tab cannot resolve a row under a different
 * rule than the main list (wongk, PR #4324).
 */
export function agentSessionToSessionTableRow(
  item: AgentSessionListItem,
  repo: string | null,
  options: SessionRowResolutionOptions = {}
): SessionTableRow {
  const { now } = options;
  const startedAt = toSessionInstant(item.startedAt);
  const lastActivityAt = toSessionInstant(item.lastActivityAt);
  const endedAt = toSessionInstant(item.endedAt);
  const pullRequests = toSessionTablePullRequests(item.prs ?? []);
  // ISS-4997 / ISS-4998: resolved ONCE and shared by the Status cell and the
  // Duration cell below. Two cells on one row must not disagree about whether we
  // know what state this run is in — a Status reading "Unknown" beside a
  // Duration confidently climbing against `now` is the contradiction #4409
  // called out, and it is structurally impossible when both read this value.
  //
  // ISS-6455: through the SHARED resolver, so the awaiting-input projection the
  // session DETAIL applies runs here too. Without it a row stored `active` with
  // `awaitingInputSince` set and silent past the cutoff folded to Stale and
  // emptied its Duration cell while the detail kept timing it — the split
  // ISS-5575 closed, re-opened for exactly that population. The desktop LOCAL
  // producer serves that shape whenever the `sessions-displayed-status-parity`
  // Labs gate is off, and the local Status facet already gathers those rows
  // under Waiting.
  const displayedStatus = resolveDisplayedSessionStatusWithWaiting({
    awaitingInputSince: item.awaitingInputSince,
    // ISS-4654: a straggler terminal row that still carries the timestamp is not
    // waiting. RAW (wongk, #5099 review), because `toSessionInstant` collapses an
    // unparseable end instant to the same `null` as an absent one and the
    // projection must not read corrupt evidence as "no end recorded".
    endedAt: item.endedAt,
    status: item.status,
    lastActivityAt,
    // wongk (#4324): the staleness clock falls back to the start time when the
    // activity timestamp is absent or unparseable, mirroring the reaper's own
    // `lastActivityAt ?? sessionStartedAt`. Without it the least-evidenced rows
    // were the ones exempted from the fold.
    startedAt,
    now,
  });
  // ISS-5131: the Duration cell measures the owner-stated rule — `now - start`
  // while active, `end - start` once terminal — from the session's own status
  // and `endedAt`. It no longer leads with the collector's `wallClock`: that
  // value is a sync-payload projection that was anchored on the last ACTIVITY
  // timestamp, which on a completed session tracks sync time and inflated one
  // 31h session to 170h. (ISS-5182 has since removed that anchor at the
  // collector, so the projection is bounded too — but this cell no longer
  // depends on it either way.) Making the UI compute the rule means a
  // wrong backend timestamp shows up as a wrong number here rather than being
  // silently patched over; the timestamps themselves are ISS-5182.
  //
  // It reads `displayedStatus`, not the stored column (#4409 review): the cell
  // beside it renders that same value, and a row cannot both say "Unknown" and
  // keep timing the run. `now` is passed explicitly rather than left to an
  // ambient clock inside the resolver — this mapper runs in a `useMemo` whose
  // inputs TanStack structural sharing keeps referentially stable across
  // unchanged polls, so a resolver reading its own clock would freeze a running
  // Duration at the last real data change while captioning it "Start to now".
  const durationLabel = resolveSessionWallClockLabel(
    startedAt,
    resolveSessionDurationWindow(displayedStatus, endedAt),
    (now ?? new Date()).getTime()
  );

  const costAvailability = deriveCostAvailability({
    estimatedCost: toSafeNumber(item.estimatedCost),
    billingMode: item.billingMode,
    turns: item.turns,
    inputTokens: toSafeNumber(item.inputTokens),
    outputTokens: toSafeNumber(item.outputTokens),
    cacheReadTokens: toSafeNumber(item.cacheReadTokens),
    cacheWriteTokens: toSafeNumber(item.cacheWriteTokens),
    toolUseCount: toSafeNumber(item.toolUseCount),
    model: item.model,
  });

  return {
    autonomy: item.autonomy ?? null,
    costAvailability,
    costLabel: formatCostLabel(
      costAvailability,
      toSafeNumber(item.estimatedCost)
    ),
    costTooltip: getCostTooltip(costAvailability),
    durationLabel,
    harness: item.harness,
    id: item.id,
    branch: item.branch ?? null,
    lastActivityLabel: resolveTimestampLabel(lastActivityAt),
    model: item.model,
    name: item.name ?? item.externalSessionId ?? "Unknown session",
    provenance: classifySessionProvenance({
      branchName: item.branch,
      worktreePath: item.worktreePath,
      harness: item.harness,
    }),
    mergeStatusLabel: toMergeStatusLabel(item.prsMerged ?? 0, pullRequests),
    pullRequestSummaryLabel: toPullRequestSummaryLabel(pullRequests),
    pullRequests,
    repo,
    // ISS-4996: the cell needs to know WHY there is no label. Absent (no remote
    // ever resolved) and malformed (a stored value carrying no identity) are
    // different facts and get different glyphs.
    repositoryDisplay: resolveSessionRepositoryDisplay(item),
    startedLabel: resolveTimestampLabel(startedAt),
    // ISS-6005: record-mutation recency (`recordUpdatedAt`), NOT the wire
    // `updatedAt` — that field carries the desktop-reported
    // `session_updated_at` recompute time, the lookalike the `Updated` column
    // must not borrow. A producer that omits the field (version skew) yields
    // `null` and the cell renders the shared empty glyph.
    updatedLabel: resolveTimestampLabel(toSessionInstant(item.recordUpdatedAt)),
    // ISS-4997 / ISS-4998: the DISPLAYED status. An unrecognized value folds to
    // the honest "Unknown"; an `active` run silent past the staleness cutoff
    // folds to "Stale". Two different facts, two different words — neither is
    // allowed to claim the agent is running. Resolved once above so the Duration
    // cell reads the identical value. See `resolveDisplayedSessionStatus`.
    status: displayedStatus,
    user: item.user
      ? {
          avatarUrl: item.user.avatarUrl,
          // #4480: carry the identity, not just the spelling — Owner grouping
          // keys on it so two different users who share a display name stay two
          // bands.
          id: item.user.id,
          name: getUserDisplayName(item.user),
        }
      : null,
  };
}

function toSafeNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toSessionTablePullRequests(
  prs: NonNullable<AgentSessionListItem["prs"]>
): SessionTableRow["pullRequests"] {
  return prs.map((pr) => {
    const numberLabel = `#${pr.num}`;
    const statusLabel = toPullRequestStatusLabel(pr.status);
    return {
      numberLabel,
      statusLabel,
      title: pr.title,
      label: `${numberLabel} ${statusLabel}`,
    };
  });
}

function toPullRequestStatusLabel(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === SessionPrLifecycleStatus.Merged) {
    return SessionPrLifecycleStatus.Merged;
  }
  if (normalized === SessionPrLifecycleStatus.Closed) {
    return SessionPrLifecycleStatus.Closed;
  }
  if (normalized === SessionPrLifecycleStatus.Open) {
    return SessionPrLifecycleStatus.Open;
  }
  return SessionPrLifecycleStatus.Unknown;
}

function toPullRequestSummaryLabel(
  pullRequests: SessionTableRow["pullRequests"]
): string | null {
  if (pullRequests.length === 0) {
    return null;
  }
  if (pullRequests.length === 1) {
    return pullRequests[0]?.label ?? null;
  }
  return `${pullRequests.length} PRs`;
}

function toMergeStatusLabel(
  mergedCount: number,
  pullRequests: SessionTableRow["pullRequests"]
): string | null {
  if (pullRequests.length === 0) {
    return null;
  }
  if (
    pullRequests.every(
      (pullRequest) =>
        pullRequest.statusLabel === SessionPrLifecycleStatus.Unknown
    )
  ) {
    return "Unknown";
  }
  if (mergedCount <= 0) {
    return "Not merged";
  }
  if (mergedCount === pullRequests.length) {
    return "Merged";
  }
  return `${mergedCount}/${pullRequests.length} merged`;
}

/**
 * ISS-4996: the Started / Last-active cell label, or `null` when the timestamp
 * is absent or unparseable so the cell can render the SHARED `GridEmptyValue`
 * sentinel every other optional column already uses.
 *
 * These two columns were the last holdouts: they returned a raw `"—"` string
 * that the cell then wrapped at `text-xs` full opacity, while the eight columns
 * beside them rendered `GridEmptyValue` at `text-sm` half opacity. One table,
 * two glyphs for the same fact. `durationLabel` was converted for exactly this
 * reason (FEA-4186) and is the in-file precedent.
 *
 * Gate retired by ISS-5366 (shipped ON): an absent timestamp returns `null`, so
 * the cell renders the SAME `GridEmptyValue` every other empty cell in the table
 * renders, rather than its own hardcoded em dash at a different size and
 * opacity. `durationLabel` was converted for exactly this reason (FEA-4186) and
 * is the in-file precedent.
 */
function resolveTimestampLabel(timestamp: Date | null): string | null {
  return timestamp ? formatRelativeTime(timestamp) : null;
}

/**
 * Render-boundary options for {@link agentSessionToSessionTableRow} and
 * {@link toSessionTableRowWithSyncFold}.
 *
 * Both mappers are pure functions with no hook access, so every render-boundary
 * value they read has to arrive in this bag. Keeping them in a single object
 * means a seam that already forwards options (`detail-data.ts`,
 * `agent-component-session-adapter.ts`, `SyncedSessionsTable`) picks up a new
 * one without another positional argument to forget.
 */
export type SessionRowResolutionOptions = Readonly<{
  /**
   * The clock the staleness fold AND the Duration cell read. Absent means "read
   * the real clock" — callers that re-render on a cadence pass an explicit value
   * so the derivation stays pure and testable.
   *
   * ISS-5131: a production list adapter MUST pass a ticking value
   * (`useCoarseNow(SESSION_DURATION_TICK_MS)`). It stays optional so Storybook,
   * fixtures, and the many narrow unit tests that only care about a terminal row
   * keep compiling — but omitting it in a mounted list freezes every RUNNING
   * session's Duration at the last input change. all three list adapters
   * (`synced-sessions-table.tsx`, the web `sessions-table.tsx`, and
   * `detail-sessions-tab.tsx`) pass it, and
   * `components/sessions/__tests__/synced-sessions-table-duration-rule.test.tsx`
   * pins that the value actually reaches the cell and advances.
   */
  now?: Date;
}>;
