import {
  type AgentSessionListItem,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
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
          repositoryFullName: "closedloop-ai/symphony-alpha",
          cwd: "/Users/dev/symphony-alpha",
          worktreePath: "/Users/dev/symphony-alpha-wt",
        })
      )
    ).toBe("closedloop-ai/symphony-alpha");
  });

  it("returns null (renders Unknown) when no remote has resolved, even for a purely local run — the cwd folder name is never used as a repo label (FEA-4274)", () => {
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: null,
          branch: null,
          branchArtifactId: null,
          prs: [],
          cwd: "/Users/dev/Dev/symphony-alpha",
          worktreePath: "/Users/dev/Dev/symphony-alpha-wt",
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
          repositoryFullName: "closedloop-ai/symphony-alpha",
          branch: "mike/nightly-review",
          cwd: "/Users/chris.chenault/Code/2",
        })
      )
    ).toBe("closedloop-ai/symphony-alpha");
  });

  it("returns null (Unknown) instead of a fabricated numeric cwd leaf when the remote is unresolved but a branch + PRs link the session (FEA-4274)", () => {
    // The production defect: /Users/chris.chenault/Code/2 was presented as
    // "Repository 2" while the session linked a real branch + PR. The resolver
    // must never turn the numbered worktree dir into a repository identity.
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: null,
          branch: "mike/nightly-review",
          prs: [
            {
              num: 33,
              title: "Nightly review crew worker",
              status: SessionPrLifecycleStatus.Open,
            },
          ],
          cwd: "/Users/chris.chenault/Code/2",
          worktreePath: "/Users/chris.chenault/Code/2",
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
    const row = agentSessionToSessionTableRow(sessionListItem(), "owner/repo");

    expect(row.startedLabel).toBe("Yesterday");
    expect(row.lastActivityLabel).toBe("3 hours ago");
    expect(row.repo).toBe("owner/repo");
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
   * ISS-6455: the desktop LOCAL row shape — raw `active` with
   * `awaitingInputSince` beside it, which is what the producer serves whenever
   * the `sessions-displayed-status-parity` Labs gate is off. The list read only
   * `status`/`lastActivityAt`/`startedAt`, so it folded this row to Stale and
   * emptied its Duration cell while the DETAIL, which does read the field, kept
   * timing the same run against `now()`.
   */
  it("ISS-6455: keeps measuring a silent run that is awaiting input, and badges it Waiting", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        status: SESSION_STATUS.ACTIVE,
        startedAt: new Date("2026-06-15T09:00:00.000Z"),
        // Comfortably past the 24h display cutoff, so the fold is not a
        // boundary accident.
        lastActivityAt: new Date("2026-06-16T09:00:00.000Z"),
        awaitingInputSince: new Date("2026-06-16T09:00:00.000Z"),
        endedAt: null,
      }),
      "owner/repo"
    );

    expect(row.status).toBe(DISPLAYED_SESSION_STATUS.WAITING);
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

    // Bounded by its own end instant. Without the `endedAt` guard this row
    // badges Waiting and its Duration climbs against `now()` instead — a
    // finished run reported as still going.
    expect(row.status).toBe(DISPLAYED_SESSION_STATUS.STALE);
    expect(row.durationLabel).toBe("24h 30m");
  });

  /**
   * The fail-open this projection is deliberately narrowed against: a
   * version-skewed payload spelling a status this build does not recognize,
   * carrying `awaitingInputSince`, must stay Unknown rather than being read as a
   * live run and timed.
   */
  it("ISS-6455: does not project an UNRECOGNIZED status that carries awaitingInputSince", () => {
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

    expect(row.status).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
    expect(row.durationLabel).toBeNull();
  });

  /**
   * ISS-6455 (wongk, #5099 review): a truthiness test cannot tell an ABSENT
   * timestamp from an UNREADABLE one, so a version-skewed payload with malformed
   * temporal fields projected Waiting and started a duration against `now()` for
   * a run this build has no evidence about.
   *
   * The two fields carry different weight. `endedAt` decides whether the run is
   * OVER, so an unreadable one disclaims the row.
   */
  it("ISS-6455: reads an unparseable endedAt as unknown rather than as a live run", () => {
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

    // Live by every other reading — active, and it said something an hour ago —
    // but we cannot tell whether it ENDED, so the cell must not keep timing it.
    expect(row.status).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
    expect(row.durationLabel).toBeNull();
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

    // The projection needs a READABLE anchor. Without one there is no evidence
    // this run is blocked on a human, so it folds like any other silent row.
    expect(row.status).toBe(DISPLAYED_SESSION_STATUS.STALE);
    expect(row.durationLabel).toBeNull();
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
        branch: "mikeangstadt/fea-3575",
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
