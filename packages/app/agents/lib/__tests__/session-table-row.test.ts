import {
  type AgentSessionListItem,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionListItemFixture } from "../../components/sessions/session-list-fixtures";
import { CostAvailability } from "../cost-availability";
import {
  agentSessionToSessionTableRow,
  resolveSessionRepoLabel,
} from "../session-table-row";

const NOW = new Date("2026-06-17T12:00:00.000Z");

/**
 * ISS-6455: the shape a corrupt wire timestamp actually arrives in. The client
 * parses every list-row instant with `new Date(...)`, so a malformed value from
 * a version-skewed producer reaches the mapper as an Invalid Date rather than
 * being rejected — the trust boundary the root `AGENTS.md` carve-out names.
 */
const UNPARSEABLE_INSTANT = new Date("not-a-date");

describe("resolveSessionRepoLabel", () => {
  it("returns the resolved Git remote repositoryFullName", () => {
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: "closedloop-ai/closedloop-ai",
          cwd: "/Users/dev/closedloop-ai",
          worktreePath: "/Users/dev/closedloop-ai-wt",
        })
      )
    ).toBe("closedloop-ai/closedloop-ai");
  });

  it("returns null (renders Unknown) when no remote has resolved, even for a purely local run — the cwd folder name is never used as a repo label (FEA-4274)", () => {
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: null,
          branch: null,
          branchArtifactId: null,
          prs: [],
          cwd: "/Users/dev/Dev/closedloop-ai",
          worktreePath: "/Users/dev/Dev/closedloop-ai-wt",
        })
      )
    ).toBeNull();
  });

  it("returns null when the session carries no repository identity at all", () => {
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: null,
          branch: null,
          branchArtifactId: null,
          prs: [],
          cwd: null,
          worktreePath: null,
        })
      )
    ).toBeNull();
  });

  it("prefers the remote over a numeric cwd leaf (FEA-4274)", () => {
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: "closedloop-ai/closedloop-ai",
          branch: "marisol/nightly-review",
          cwd: "/Users/cosimo.corrigan/Code/2",
        })
      )
    ).toBe("closedloop-ai/closedloop-ai");
  });

  it("returns null (Unknown) instead of a fabricated numeric cwd leaf when the remote is unresolved but a branch + PRs link the session (FEA-4274)", () => {
    // The production defect: /Users/cosimo.corrigan/Code/2 was presented as
    // "Repository 2" while the session linked a real branch + PR. The resolver
    // must never turn the numbered worktree dir into a repository identity.
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: null,
          branch: "marisol/nightly-review",
          prs: [
            {
              num: 33,
              title: "Nightly review crew worker",
              status: SessionPrLifecycleStatus.Open,
            },
          ],
          cwd: "/Users/cosimo.corrigan/Code/2",
          worktreePath: "/Users/cosimo.corrigan/Code/2",
        })
      )
    ).toBeNull();
  });

  it("does not crash and returns null for an older-Desktop session carrying only a cwd folder and no remote (version skew, FEA-4274)", () => {
    // A session synced by an older Desktop that never resolved a remote degrades
    // to Unknown rather than fabricating a repo label from the folder name.
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: null,
          branch: null,
          branchArtifactId: null,
          prs: [],
          cwd: "/var/task/2",
          worktreePath: null,
        })
      )
    ).toBeNull();
  });
});

describe("agentSessionToSessionTableRow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps Started and Last active labels through app local-time helpers", () => {
    const item = sessionListItem();
    const row = agentSessionToSessionTableRow(item, "owner/repo");

    expect(row.startedLabel).toBe("Yesterday");
    expect(row.lastActivityLabel).toBe("3 hours ago");
    expect(row.repo).toBe("owner/repo");
    expect(row.rawStatus).toBe(item.status);
  });

  it("preserves producer lifecycle evidence beside a derived display status", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        rawStatus: "quantum-flux",
        // Plain literal: ISS-10364 retired `DISPLAYED_SESSION_STATUS.UNKNOWN`.
        status: "unknown",
      }),
      "owner/repo"
    );

    expect(row.rawStatus).toBe("quantum-flux");
    // ISS-10364: a stored literal `unknown` now folds through
    // `normalizeSessionStatus` to Active like any other unmodelled value, so the
    // derived `status` no longer echoes the stored literal — `rawStatus` is what
    // still carries it.
    expect(row.status).toBe(SESSION_STATUS.ACTIVE);
  });

  it("nulls missing timestamps so the cell renders the shared sentinel", () => {
    // ISS-4996 defect B: Started and Last-active were the last two columns
    // returning their own raw "—" string; every other optional column returned
    // null and let the cell render `GridEmptyValue`. Null here is what routes
    // them through the same sentinel — see the sessions-table cell test.
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        startedAt: new Date("not-a-date"),
        lastActivityAt: new Date("not-a-date"),
      }),
      null
    );

    expect(row.startedLabel).toBeNull();
    expect(row.lastActivityLabel).toBeNull();
    expect(row.durationLabel).toBeNull();
  });

  it("still formats present timestamps", () => {
    // The null-for-empty rule must only change the EMPTY case; a resolvable
    // timestamp formats exactly as it always did.
    const row = agentSessionToSessionTableRow(sessionListItem(), "owner/repo");

    expect(row.startedLabel).toBe("Yesterday");
    expect(row.lastActivityLabel).toBe("3 hours ago");
  });

  it("ISS-5131: measures a RUNNING session's Duration to now", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.ACTIVE,
        startedAt: new Date("2026-06-17T09:00:00.000Z"),
        lastActivityAt: new Date("2026-06-17T10:00:00.000Z"),
        endedAt: null,
      }),
      "owner/repo"
    );

    expect(row.durationLabel).toBe("3h 0m");
  });

  it("ISS-5131: measures a TERMINAL session's Duration to its own endedAt", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.INACTIVE,
        startedAt: new Date("2026-06-17T09:00:00.000Z"),
        lastActivityAt: new Date("2026-06-17T09:20:00.000Z"),
        endedAt: new Date("2026-06-17T09:30:00.000Z"),
      }),
      "owner/repo"
    );

    expect(row.durationLabel).toBe("30m 0s");
  });

  it("ISS-5131: ignores a lastActivityAt past endedAt and the collector wallClock", () => {
    // The reported session `019fb3e3`: `lastActivityAt` tracks SYNC time and
    // lands six days past `endedAt`; the collector's `wallClock` was derived
    // from that same anchor and read 170h for a 31h run.
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.INACTIVE,
        startedAt: new Date("2026-07-28T14:58:31.028Z"),
        endedAt: new Date("2026-07-29T22:02:53.365Z"),
        lastActivityAt: new Date("2026-08-04T17:28:37.425Z"),
        wallClock: "170h 30m",
      }),
      "owner/repo"
    );

    expect(row.durationLabel).toBe("31h 4m");
    expect(row.durationLabel).not.toBe("170h 30m");
  });

  it("ISS-5131: renders no Duration for a terminal row with no end instant", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.INACTIVE,
        startedAt: new Date("2026-06-10T10:00:00.000Z"),
        lastActivityAt: new Date("2026-06-10T14:54:00.000Z"),
        endedAt: null,
        wallClock: null,
      }),
      "owner/repo"
    );

    expect(row.durationLabel).toBeNull();
  });

  /**
   * ISS-10364 (operator ruling, 2026-09-23/24) retired the Waiting projection
   * this case used to pin: the mapper no longer reads `awaitingInputSince` at
   * all, so this row's status is the ordinary Active fold, the same as any
   * other non-terminal row — and its Duration keeps climbing against `now()`
   * regardless, since there is no staleness fold left to stop it either.
   */
  it("ISS-10364: keeps measuring a silent run that is awaiting input, now badged plain Active", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.ACTIVE,
        startedAt: new Date("2026-06-15T09:00:00.000Z"),
        lastActivityAt: new Date("2026-06-16T09:00:00.000Z"),
        awaitingInputSince: new Date("2026-06-16T09:00:00.000Z"),
        endedAt: null,
      }),
      "owner/repo"
    );

    expect(row.status).toBe(SESSION_STATUS.ACTIVE);
    expect(row.durationLabel).toBe("51h 0m");
  });

  /**
   * ISS-6455 / ISS-4654: `awaitingInputSince` outlives the run, so a straggler row that
   * ended while still carrying it is not waiting — its span is bounded by its
   * own end instant, not climbing against `now()`.
   */
  it("ISS-6455: does not project an ENDED row that still carries awaitingInputSince", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.ACTIVE,
        startedAt: new Date("2026-06-15T09:00:00.000Z"),
        lastActivityAt: new Date("2026-06-16T09:00:00.000Z"),
        awaitingInputSince: new Date("2026-06-16T09:00:00.000Z"),
        endedAt: new Date("2026-06-16T09:30:00.000Z"),
      }),
      "owner/repo"
    );

    // The `endedAt` guard still holds: this row never badges Waiting. But
    // ISS-10364 retired the staleness fold, so its fallback is now plain Active
    // rather than Stale — and Active always drives a running Duration window, so
    // this straggler (stored `active` with a stray `endedAt`) keeps climbing
    // against `now()` rather than being bounded.
    expect(row.status).toBe(SESSION_STATUS.ACTIVE);
    expect(row.durationLabel).toBe("51h 0m");
  });

  /**
   * The recognized-live gate, held against the population it exists for: a
   * version-skewed payload spelling a status this build does not model, with
   * `awaitingInputSince` beside it. The gate REFUSES it, so the row is not
   * badged Waiting on evidence this build cannot corroborate.
   *
   * ISS-10364 (tamsinb review, #7820) is why this is asserted rather than
   * assumed. Narrowing `resolveDisplayedSessionStatus` to a lifecycle value
   * made it answer Active for every unmodelled spelling, which briefly turned
   * this gate into a pass-through and badged this row Waiting. The gate is a
   * membership test now (`projectLiveWaiting`), so the refusal is restored —
   * the row falls through to the ordinary fold and reads Active, and its
   * Duration still times, because the fold no longer has a staleness arm.
   */
  it("refuses the Waiting projection for an UNRECOGNIZED status carrying awaitingInputSince", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: "quantum-flux",
        startedAt: new Date("2026-06-17T09:00:00.000Z"),
        lastActivityAt: new Date("2026-06-17T10:00:00.000Z"),
        awaitingInputSince: new Date("2026-06-17T10:00:00.000Z"),
        endedAt: null,
      }),
      "owner/repo"
    );

    expect(row.status).toBe(SESSION_STATUS.ACTIVE);
    expect(row.durationLabel).toBe("3h 0m");
  });

  /**
   * ISS-10364 (operator ruling, 2026-09-23/24) retired the disclaim-on-corrupt-
   * endedAt path this case used to pin. The mapper's status fold never reads
   * `endedAt`, and a lifecycle of `Running` (which ACTIVE always is now) short-
   * circuits the window logic before it ever looks at `endedAt` — so a raw
   * `active` row keeps timing against `now()` regardless of whether its
   * `endedAt` is corrupt, absent, or a real past instant.
   */
  it("ISS-10364: keeps timing an active row even with an unparseable endedAt", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.ACTIVE,
        startedAt: new Date("2026-06-15T09:00:00.000Z"),
        lastActivityAt: new Date("2026-06-17T11:00:00.000Z"),
        awaitingInputSince: new Date("2026-06-17T11:00:00.000Z"),
        endedAt: UNPARSEABLE_INSTANT,
      }),
      "owner/repo"
    );

    expect(row.status).toBe(SESSION_STATUS.ACTIVE);
    expect(row.durationLabel).toBe("51h 0m");
  });

  /**
   * `awaitingInputSince` carries only the staleness EXEMPTION, so an unreadable
   * one withholds the exemption and nothing else. Disclaiming the whole row
   * would throw away a span the other three fields compute perfectly well — the
   * same over-claim as the fabricated number, pointing the other way.
   */
  it("ISS-6455: keeps measuring a LIVE run whose awaitingInputSince is unparseable", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.ACTIVE,
        startedAt: new Date("2026-06-17T09:00:00.000Z"),
        lastActivityAt: new Date("2026-06-17T11:00:00.000Z"),
        awaitingInputSince: UNPARSEABLE_INSTANT,
        endedAt: null,
      }),
      "owner/repo"
    );

    expect(row.status).toBe(SESSION_STATUS.ACTIVE);
    expect(row.durationLabel).toBe("3h 0m");
  });

  it("ISS-6455: withholds the staleness exemption from a SILENT run whose awaitingInputSince is unparseable", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.ACTIVE,
        startedAt: new Date("2026-06-15T09:00:00.000Z"),
        lastActivityAt: new Date("2026-06-16T09:00:00.000Z"),
        awaitingInputSince: UNPARSEABLE_INSTANT,
        endedAt: null,
      }),
      "owner/repo"
    );

    // The projection still needs a READABLE anchor: without one there is no
    // evidence this run is blocked on a human, so no Waiting exemption is
    // granted and it takes the ordinary fold. ISS-10364 retired the staleness
    // fold that ordinary path used to apply, so the row now reads Active (and
    // measurably running) rather than Stale (and unmeasurable).
    expect(row.status).toBe(SESSION_STATUS.ACTIVE);
    expect(row.durationLabel).toBe("51h 0m");
  });

  it("maps session pull requests into compact PR and merge display fields", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        prs: [
          {
            num: 17,
            title: "Add session PR columns",
            status: SessionPrLifecycleStatus.Open,
          },
          {
            num: 18,
            title: "Merge session sync",
            status: SessionPrLifecycleStatus.Merged,
          },
        ],
        prsMerged: 1,
      }),
      "owner/repo"
    );

    expect(row.pullRequestSummaryLabel).toBe("2 PRs");
    expect(row.pullRequests).toEqual([
      {
        numberLabel: "#17",
        statusLabel: SessionPrLifecycleStatus.Open,
        title: "Add session PR columns",
        label: "#17 open",
      },
      {
        numberLabel: "#18",
        statusLabel: SessionPrLifecycleStatus.Merged,
        title: "Merge session sync",
        label: "#18 merged",
      },
    ]);
    expect(row.mergeStatusLabel).toBe("1/2 merged");
  });

  it("renders all-unknown PR lifecycle as unknown merge state", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        prs: [
          {
            num: 17,
            title: "Legacy merged claim",
            status: SessionPrLifecycleStatus.Unknown,
          },
        ],
        prsMerged: 0,
      }),
      "owner/repo"
    );

    expect(row.pullRequestSummaryLabel).toBe("#17 unknown");
    expect(row.mergeStatusLabel).toBe("Unknown");
  });

  it("renders empty PR fields when a session has no pull requests", () => {
    const row = agentSessionToSessionTableRow(sessionListItem(), "owner/repo");

    expect(row.pullRequests).toEqual([]);
    expect(row.pullRequestSummaryLabel).toBeNull();
    expect(row.mergeStatusLabel).toBeNull();
  });

  it("classifies bot sessions from a CI harness (FEA-3575)", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({ harness: "ci" }),
      "owner/repo"
    );
    expect(row.provenance).toBe("bot");
  });

  it("classifies bot sessions from a bot branch name (FEA-3575)", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({ harness: "claude", branch: "dependabot/npm/vite-8" }),
      "owner/repo"
    );
    expect(row.provenance).toBe("bot");
  });

  it("classifies agent sessions from a `.claude/worktrees/*` path (FEA-3575)", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        harness: "claude",
        branch: null,
        worktreePath: "/Users/x/repo/.claude/worktrees/agent-abc",
      }),
      "owner/repo"
    );
    expect(row.provenance).toBe("agent");
  });

  it("classifies ordinary human sessions as human (FEA-3575)", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        harness: "claude",
        branch: "marisolashgrove/fea-3575",
        worktreePath: "/Users/x/repo",
      }),
      "owner/repo"
    );
    expect(row.provenance).toBe("human");
  });

  it("shows dollar amount with subscription tooltip for subscription-billed sessions (FEA-3643)", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        estimatedCost: 3.5,
        billingMode: "pro",
        inputTokens: 50_000,
        outputTokens: 10_000,
      }),
      "owner/repo"
    );
    expect(row.costLabel).toBe("$3.50");
    expect(row.costTooltip).toBe("Billed through your subscription");
    expect(row.costAvailability).toBe(CostAvailability.Subscription);
  });

  it("shows formatted cost for metered sessions with real cost (FEA-3643)", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        estimatedCost: 4.25,
        billingMode: null,
        inputTokens: 48_000,
        outputTokens: 12_000,
      }),
      "owner/repo"
    );
    expect(row.costLabel).toBe("$4.25");
    expect(row.costTooltip).toBeNull();
    expect(row.costAvailability).toBe(CostAvailability.Available);
  });

  it("shows dash with pricing-miss tooltip when cost is zero but tokens exist (FEA-3643)", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        estimatedCost: 0,
        billingMode: null,
        inputTokens: 48_000,
        outputTokens: 12_000,
      }),
      "owner/repo"
    );
    expect(row.costLabel).toBe("—");
    expect(row.costTooltip).toBe("No pricing data for this model");
    expect(row.costAvailability).toBe(CostAvailability.Unavailable);
  });

  it("shows empty value for sessions with zero usage (FEA-3643)", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        estimatedCost: 0,
        billingMode: null,
        inputTokens: 0,
        outputTokens: 0,
        toolUseCount: 0,
        model: null,
      }),
      "owner/repo"
    );
    expect(row.costLabel).toBe("—");
    expect(row.costTooltip).toBeNull();
    expect(row.costAvailability).toBe(CostAvailability.NoUsage);
  });

  // ISS-4418: a zero-usage subscription session (no tokens, no tool uses, no
  // model, null cost) must render `—` on the list — the same empty state a
  // zero-usage unknown-billing session gets — not a fabricated `$0.00`.
  it("shows empty value for a zero-usage subscription session, not $0.00 (ISS-4418)", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        estimatedCost: 0,
        billingMode: "pro",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolUseCount: 0,
        model: null,
      }),
      "owner/repo"
    );
    expect(row.costLabel).toBe("—");
    expect(row.costTooltip).toBeNull();
    expect(row.costAvailability).toBe(CostAvailability.NoUsage);
  });

  // ISS-4418: a subscription session that DID run keeps its subscription
  // treatment (covered cost + subscription tooltip).
  it("keeps subscription treatment for a subscription session that did work with zero API cost (ISS-4418)", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        estimatedCost: 0,
        billingMode: "pro",
        inputTokens: 50_000,
        outputTokens: 10_000,
        model: "claude-opus-4",
      }),
      "owner/repo"
    );
    expect(row.costLabel).toBe("$0.00");
    expect(row.costTooltip).toBe("Billed through your subscription");
    expect(row.costAvailability).toBe(CostAvailability.Subscription);
  });
});

/**
 * ISS-8013: the five sortable columns that render a FORMATTED value — Cost,
 * Duration, Started, Updated and Last active — now carry the underlying value
 * beside the label, because sorting on the label ranked `$1,234.00` below
 * `$9.50`. This is the producer half: one mapper fills all five, and the row
 * type declares them optional so hand-written story rows still compile, so
 * nothing but this assertion stands between a forgotten field and a sort control
 * that silently stops moving anything.
 *
 * Every instant below is DISTINCT, so a value read off a neighbouring field —
 * `updatedAtMs` off `lastActivityAt`, the pair ISS-6005 had to separate once
 * already — fails here rather than matching by coincidence.
 */
describe("agentSessionToSessionTableRow raw sort values", () => {
  it("carries the value behind every label a sortable column ranks by", () => {
    const row = agentSessionToSessionTableRow(
      createAgentSessionListItemFixture({
        status: SESSION_STATUS.INACTIVE,
        startedAt: new Date("2026-06-16T10:00:00.000Z"),
        endedAt: new Date("2026-06-16T10:30:00.000Z"),
        lastActivityAt: new Date("2026-06-16T22:00:00.000Z"),
        recordUpdatedAt: new Date("2026-06-17T08:00:00.000Z"),
        estimatedCost: 4.25,
      }),
      null,
      { now: NOW }
    );

    expect(row.costValue).toBe(4.25);
    expect(row.durationMs).toBe(30 * 60 * 1000);
    expect(row.startedAtMs).toBe(
      new Date("2026-06-16T10:00:00.000Z").getTime()
    );
    expect(row.lastActivityAtMs).toBe(
      new Date("2026-06-16T22:00:00.000Z").getTime()
    );
    expect(row.updatedAtMs).toBe(
      new Date("2026-06-17T08:00:00.000Z").getTime()
    );
  });

  /**
   * The sibling in the opposite state, on the same subject: where the cell shows
   * an em dash the value is `null`, so an unpriced or unmeasured row is UNRANKED
   * rather than ranked as the cheapest and shortest run on the page. A `0` here
   * would be the lie.
   */
  it("carries no value where the label is an em dash", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.INACTIVE,
        // The wire shape a missing instant actually arrives in — see
        // {@link UNPARSEABLE_INSTANT}. `recordUpdatedAt` is optional on the DTO,
        // so its absence is spelled by simply not being here.
        startedAt: UNPARSEABLE_INSTANT,
        endedAt: null,
        lastActivityAt: UNPARSEABLE_INSTANT,
        estimatedCost: 0,
      }),
      null,
      { now: NOW }
    );

    expect(row.costLabel).toBe("—");
    expect(row.costValue).toBeNull();
    expect(row.durationLabel).toBeNull();
    expect(row.durationMs).toBeNull();
    expect(row.startedLabel).toBeNull();
    expect(row.startedAtMs).toBeNull();
    expect(row.lastActivityLabel).toBeNull();
    expect(row.lastActivityAtMs).toBeNull();
    expect(row.updatedLabel).toBeNull();
    expect(row.updatedAtMs).toBeNull();
  });
});

function sessionListItem(
  overrides: Partial<AgentSessionListItem> = {}
): AgentSessionListItem {
  return {
    id: "session-1",
    slug: "SES-1",
    externalSessionId: "external-session-1",
    name: "Implement local timestamps",
    status: "completed",
    harness: "codex",
    cwd: "/repo",
    repositoryFullName: "owner/repo",
    worktreePath: "/repo",
    model: "gpt-5.5",
    branch: "fea-2097",
    autonomy: null,
    startedAt: new Date("2026-06-16T10:00:00.000Z"),
    updatedAt: new Date("2026-06-17T09:00:00.000Z"),
    lastActivityAt: new Date("2026-06-17T09:00:00.000Z"),
    lastSyncedAt: new Date("2026-06-17T09:00:00.000Z"),
    endedAt: new Date("2026-06-17T09:30:00.000Z"),
    awaitingInputSince: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
    agentCount: 1,
    toolUseCount: 0,
    errorCount: 0,
    baseBranch: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    user: null,
    computeTarget: {
      id: "target-1",
      machineName: "Local Desktop",
      isOnline: true,
      lastSeenAt: NOW,
      lastAgentSessionSyncAt: NOW,
    },
    project: null,
    ...overrides,
  };
}
