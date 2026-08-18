import type {
  AgentSessionDetail,
  SyncedAgentSessionAgent,
} from "@repo/api/src/types/agent-session";
import {
  TranscriptAvailability,
  type TranscriptAvailabilitySummary,
} from "@repo/api/src/types/desktop-transcripts";
import { describe, expect, it } from "vitest";
import {
  buildSubagentTranscriptLabels,
  buildSubagentTranscriptSummary,
  hasUnreadableSubagentTranscripts,
  resolveSubagentCount,
  SubagentTranscriptState,
  shouldShowSubagentFileCount,
  sortSubagentTranscriptFiles,
  subagentTranscriptReconciliation,
} from "../subagent-transcripts";

function file(
  fileKey: string,
  availability: TranscriptAvailability = TranscriptAvailability.Available
): TranscriptAvailabilitySummary {
  return {
    fileKey,
    availability,
    uploadedAt: "2026-08-01T12:00:00.000Z",
    permanentFailureReason: null,
  };
}

/**
 * ISS-5762: the transport verbs the reconciliation caption must never use.
 * "Archived"/"uploaded" read as "moved out of view", and all three assert the
 * bytes reached a remote archive — false for a desktop-local session, whose
 * files are `Available` with `uploadedAt: null` and never left the disk.
 */
const TRANSPORT_VERB = /archived|synced|uploaded/i;

function sidechains(count: number): TranscriptAvailabilitySummary[] {
  return Array.from({ length: count }, (_unused, index) =>
    file(`subagent:agent-${index + 1}`)
  );
}

describe("resolveSubagentCount (ISS-4677)", () => {
  it("subtracts the session's own main agent from agentCount", () => {
    expect(
      resolveSubagentCount({ agentCount: 10 } as Pick<
        AgentSessionDetail,
        "agentCount"
      >)
    ).toBe(9);
  });

  it("reports a real zero for a loaded session that ran no subagents", () => {
    expect(
      resolveSubagentCount({ agentCount: 1 } as Pick<
        AgentSessionDetail,
        "agentCount"
      >)
    ).toBe(0);
  });

  // The distinction the whole feature turns on: a loaded session ALWAYS has its
  // own main agent row, so `agentCount < 1` is "the rows haven't arrived", not
  // "zero subagents". Returning 0 here would be a confident lie.
  it("reports unknown — not zero — when the agent rows have not arrived", () => {
    expect(
      resolveSubagentCount({ agentCount: 0 } as Pick<
        AgentSessionDetail,
        "agentCount"
      >)
    ).toBeNull();
  });

  it("reports unknown for a non-finite or negative agentCount", () => {
    for (const agentCount of [Number.NaN, Number.POSITIVE_INFINITY, -3]) {
      expect(
        resolveSubagentCount({ agentCount } as Pick<
          AgentSessionDetail,
          "agentCount"
        >)
      ).toBeNull();
    }
  });
});

describe("sortSubagentTranscriptFiles", () => {
  it("orders numerically so agent-2 precedes agent-10", () => {
    const sorted = sortSubagentTranscriptFiles([
      file("subagent:agent-10"),
      file("subagent:agent-2"),
      file("subagent:agent-1"),
    ]);
    expect(sorted.map((entry) => entry.fileKey)).toEqual([
      "subagent:agent-1",
      "subagent:agent-2",
      "subagent:agent-10",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [file("subagent:b"), file("subagent:a")];
    sortSubagentTranscriptFiles(input);
    expect(input.map((entry) => entry.fileKey)).toEqual([
      "subagent:b",
      "subagent:a",
    ]);
  });
});

describe("buildSubagentTranscriptSummary (ISS-4677)", () => {
  it("distinguishes unreported availability from a reported empty set", () => {
    const unreported = buildSubagentTranscriptSummary({
      files: undefined,
      reportedSubagentCount: null,
    });
    const reportedEmpty = buildSubagentTranscriptSummary({
      files: [file("main")],
      reportedSubagentCount: 0,
    });

    expect(unreported.state).toBe(SubagentTranscriptState.Unavailable);
    expect(reportedEmpty.state).toBe(SubagentTranscriptState.None);
    expect(unreported.state).not.toBe(reportedEmpty.state);
  });

  it("partitions main from sidechains and folds only a real wall", () => {
    const one = buildSubagentTranscriptSummary({
      files: [file("main"), ...sidechains(1)],
      reportedSubagentCount: 1,
    });
    const many = buildSubagentTranscriptSummary({
      files: [file("main"), ...sidechains(9)],
      reportedSubagentCount: 9,
    });

    expect(one.mainFiles).toHaveLength(1);
    expect(one.subagentFiles).toHaveLength(1);
    expect(one.shouldCollapse).toBe(false);
    expect(many.subagentFiles).toHaveLength(9);
    expect(many.shouldCollapse).toBe(true);
  });

  it("reports the shortfall against the Subagents metric", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [file("main"), ...sidechains(9)],
      reportedSubagentCount: 12,
    });
    expect(summary.missingTranscriptCount).toBe(3);
    expect(subagentTranscriptReconciliation(summary)).toBe(
      "12 subagents, 9 transcripts available"
    );
  });

  it("stays silent when the file count and the metric already agree", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [file("main"), ...sidechains(9)],
      reportedSubagentCount: 9,
    });
    expect(summary.missingTranscriptCount).toBe(0);
    expect(subagentTranscriptReconciliation(summary)).toBeNull();
  });

  // Never invent a shortfall out of missing data: an unknown metric must not
  // become "N of null" or a fabricated gap.
  it("invents no shortfall when the Subagents metric is unknown", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [file("main"), ...sidechains(9)],
      reportedSubagentCount: null,
    });
    expect(summary.missingTranscriptCount).toBe(0);
    expect(subagentTranscriptReconciliation(summary)).toBeNull();
  });

  // "Still uploading" promises the bytes are coming. That is true ONLY of an
  // `uploadPending` file — a failed upload, a missing row and a permanently
  // skipped file are all "unavailable" and must not borrow the time word.
  it("counts only an in-flight upload as still uploading", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [
        file("main"),
        ...sidechains(4),
        file("subagent:agent-5", TranscriptAvailability.UploadPending),
        file("subagent:agent-6", TranscriptAvailability.PermanentlyUnavailable),
        file("subagent:agent-7", TranscriptAvailability.UploadFailed),
        file("subagent:agent-8", TranscriptAvailability.Missing),
      ],
      reportedSubagentCount: 8,
    });
    expect(summary.pendingCount).toBe(1);
    expect(summary.unavailableCount).toBe(3);
    expect(summary.readableCount).toBe(4);
    expect(hasUnreadableSubagentTranscripts(summary)).toBe(true);
    // 8 sidechains exist but only 4 are readable, so the count clause reports
    // the readable four against the reported eight. The count clause binds with
    // a comma and the FILE clauses with " · ", so the three file tallies
    // partition the population exactly (4 + 1 + 3 = 8) without the subagent
    // count reading as a fourth peer.
    expect(subagentTranscriptReconciliation(summary)).toBe(
      "8 subagents, 4 transcripts available · 1 still uploading · 3 unavailable"
    );
    expect(shouldShowSubagentFileCount(summary)).toBe(false);
  });

  it("treats a stale upload as readable — it is the freshest copy we hold", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [
        file("main"),
        file("subagent:agent-1", TranscriptAvailability.Stale),
        file("subagent:agent-2"),
      ],
      reportedSubagentCount: 2,
    });
    expect(summary.pendingCount).toBe(0);
    expect(summary.unavailableCount).toBe(0);
    expect(hasUnreadableSubagentTranscripts(summary)).toBe(false);
  });

  it("counts only readable files as available, never a failed one", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [
        file("main"),
        file("subagent:agent-1"),
        file("subagent:agent-2", TranscriptAvailability.UploadFailed),
      ],
      reportedSubagentCount: 5,
    });
    // One readable, one unavailable: a reader adding the " · "-joined FILE
    // clauses gets 2, which is how many sidechains there are. The 5 is bound to
    // its own noun by a comma and is not one of those addends. Counting the
    // failed file as readable too would report it inside both file clauses and
    // sum to 3 of 2.
    expect(summary.readableCount).toBe(1);
    expect(subagentTranscriptReconciliation(summary)).toBe(
      "5 subagents, 1 transcript available · 1 unavailable"
    );
  });

  it("reports the SURPLUS direction and drops the bare count", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [file("main"), ...sidechains(9)],
      reportedSubagentCount: 3,
    });
    expect(summary.excessTranscriptCount).toBe(6);
    expect(summary.missingTranscriptCount).toBe(0);
    // Without this the header printed a confident "(9)" beside a Subagents
    // MetricCard reading 3, with nothing reconciling the two.
    expect(shouldShowSubagentFileCount(summary)).toBe(false);
    expect(subagentTranscriptReconciliation(summary)).toBe(
      "3 subagents, 9 transcripts available"
    );
  });

  it("reconciles the degenerate agentCount=1 session that still has sidechains", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [file("main"), ...sidechains(4)],
      reportedSubagentCount: 0,
    });
    expect(shouldShowSubagentFileCount(summary)).toBe(false);
    expect(subagentTranscriptReconciliation(summary)).toBe(
      "0 subagents, 4 transcripts available"
    );
  });

  it("keeps a non-subagent file key out of the sidechain count", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [file("main"), file("subagent:agent-1"), file("sidecar:notes")],
      reportedSubagentCount: 1,
    });
    // Bucketing on "not main" would call `sidecar:notes` a sidechain, inflating
    // the header count and deflating the shortfall — while giving it no label.
    expect(summary.subagentFiles).toHaveLength(1);
    expect(summary.otherFiles.map((entry) => entry.fileKey)).toEqual([
      "sidecar:notes",
    ]);
    expect(shouldShowSubagentFileCount(summary)).toBe(true);
    expect(subagentTranscriptReconciliation(summary)).toBeNull();
  });
});

describe("resolveSubagentCount — agent-row derivation (ISS-4677)", () => {
  function agentRow(
    overrides: Partial<SyncedAgentSessionAgent> = {}
  ): SyncedAgentSessionAgent {
    return {
      externalAgentId: "a1",
      name: "Agent",
      type: "subagent",
      status: "completed",
      subagentType: null,
      parentExternalAgentId: "main",
      currentTool: null,
      startedAt: null,
      endedAt: null,
      ...overrides,
    } as SyncedAgentSessionAgent;
  }

  it("subtracts the actual main row, not a blind one", () => {
    expect(
      resolveSubagentCount({
        agentCount: 3,
        agents: [
          agentRow({
            externalAgentId: "root",
            type: "main",
            parentExternalAgentId: null,
          }),
          agentRow({ externalAgentId: "a1" }),
          agentRow({ externalAgentId: "a2" }),
        ],
      })
    ).toBe(2);
  });

  it("counts every row when the session has no main row to subtract", () => {
    // An unhealed session whose root row was deleted keeps `agentCount` equal to
    // `agents.length`. A blind `agentCount - 1` reported 1, while the Overview
    // tally rendered chips for 2 — the same off-by-one, flipped in sign.
    expect(
      resolveSubagentCount({
        agentCount: 2,
        agents: [
          agentRow({ externalAgentId: "a1" }),
          agentRow({ externalAgentId: "a2" }),
        ],
      })
    ).toBe(2);
  });

  it("falls back to agentCount - 1 when the rows are a different population", () => {
    expect(resolveSubagentCount({ agentCount: 12, agents: [] })).toBe(11);
    expect(resolveSubagentCount({ agentCount: 12 })).toBe(11);
  });

  it("returns null, never 0, when the rows have not arrived", () => {
    expect(resolveSubagentCount({ agentCount: 0 })).toBeNull();
  });
});

describe("buildSubagentTranscriptLabels (ISS-4677)", () => {
  const files = [
    file("main"),
    file("subagent:a1"),
    file("subagent:a2"),
    file("subagent:a3"),
  ];

  function agent(
    externalAgentId: string,
    overrides: Partial<SyncedAgentSessionAgent> = {}
  ): SyncedAgentSessionAgent {
    return {
      externalAgentId,
      name: `Agent ${externalAgentId}`,
      type: "subagent",
      status: "completed",
      ...overrides,
    };
  }

  it("names a chip from the agent row matched by exact external id", () => {
    const labels = buildSubagentTranscriptLabels({
      files,
      agents: [agent("a1", { subagentType: "code-reviewer" })],
    });
    expect(labels.get("subagent:a1")).toBe("code-reviewer");
  });

  // An ambiguous friendly label is worse than an opaque id: two chips both
  // reading "code-reviewer" would misidentify one of the transcripts.
  it("disambiguates a colliding name instead of mixing two label systems", () => {
    const labels = buildSubagentTranscriptLabels({
      files,
      agents: [
        agent("a1", { subagentType: "code-reviewer" }),
        agent("a2", { subagentType: "code-reviewer" }),
        agent("a3", { subagentType: "explorer" }),
      ],
    });
    // Dropping the colliding chips back to "Subagent a1" put two naming systems
    // in one drawer; every MATCHED chip now reads the same way.
    expect(labels.get("subagent:a1")).toBe("code-reviewer a1");
    expect(labels.get("subagent:a2")).toBe("code-reviewer a2");
    expect(labels.get("subagent:a3")).toBe("explorer");
  });

  it("orders sidechains by the text the chip actually renders", () => {
    const ordered = sortSubagentTranscriptFiles(
      [file("subagent:a1"), file("subagent:a2"), file("subagent:a3")],
      new Map([
        ["subagent:a1", "reviewer"],
        ["subagent:a2", "architect"],
      ])
    );
    // Sorting on the raw key while rendering names lands the named chips in an
    // order the reader can see no reason for.
    expect(ordered.map((entry) => entry.fileKey)).toEqual([
      "subagent:a2",
      "subagent:a1",
      "subagent:a3",
    ]);
  });

  it("never attaches a label to an unmatched or main file", () => {
    const labels = buildSubagentTranscriptLabels({
      files,
      agents: [agent("not-a-transcript-id", { subagentType: "explorer" })],
    });
    expect(labels.size).toBe(0);
  });

  it("returns no labels when the session carries no agent rows", () => {
    expect(
      buildSubagentTranscriptLabels({ files, agents: undefined }).size
    ).toBe(0);
  });
});

/**
 * ISS-5762 — the fold PARTITIONS the served files; it never bounds them.
 *
 * Sized above every row cap in the tree a future edit could plausibly reach for
 * (50, 100, 122 observed), because a fixture that fits under the cap passes
 * while the bug is live — the exact way ISS-5520 and ISS-5521 survived review.
 */
describe("buildSubagentTranscriptSummary — completeness (ISS-5762)", () => {
  const OBSERVED_SIDECHAIN_COUNT = 122;
  const OBSERVED_REPORTED_SUBAGENTS = 72;

  it("keeps every sidechain in the summary regardless of population size", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [file("main"), ...sidechains(OBSERVED_SIDECHAIN_COUNT)],
      reportedSubagentCount: OBSERVED_REPORTED_SUBAGENTS,
    });

    expect(summary.subagentFiles).toHaveLength(OBSERVED_SIDECHAIN_COUNT);
    expect(summary.readableCount).toBe(OBSERVED_SIDECHAIN_COUNT);
    expect(summary.mainFiles).toHaveLength(1);
    // The three availability buckets still partition the WHOLE population, so a
    // cap could not hide inside a bucket either.
    expect(
      summary.readableCount + summary.pendingCount + summary.unavailableCount
    ).toBe(OBSERVED_SIDECHAIN_COUNT);
  });

  it("reports the observed surplus without claiming a transport", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [file("main"), ...sidechains(OBSERVED_SIDECHAIN_COUNT)],
      reportedSubagentCount: OBSERVED_REPORTED_SUBAGENTS,
    });
    const caption = subagentTranscriptReconciliation(summary);

    expect(caption).toBe(
      `${OBSERVED_REPORTED_SUBAGENTS} subagents, ${OBSERVED_SIDECHAIN_COUNT} transcripts available`
    );
    // "archived" is this codebase's word for "uploaded to storage", but a reader
    // hears "moved out of view" — an admission of the silent subsetting this
    // surface does not do.
    expect(caption).not.toMatch(TRANSPORT_VERB);
    expect(summary.excessTranscriptCount).toBe(
      OBSERVED_SIDECHAIN_COUNT - OBSERVED_REPORTED_SUBAGENTS
    );
  });
});

/**
 * ISS-5762 (review follow-up) — the caption is mounted by the DESKTOP renderer
 * too, over files that were never uploaded anywhere.
 *
 * `resolveLocalTranscriptSummaries`
 * (`apps/desktop/src/main/dashboard/local-transcript-detail-gate.ts`) reports
 * each locally-readable `.jsonl` as `Available` with `uploadedAt: null` — no
 * archive identity exists, and the bytes are served off disk over the read
 * bridge rather than from S3. It does that whether or not transcript sync is
 * enabled. So any caption verb asserting the bytes reached a remote archive
 * ("synced", "archived", "uploaded") is false on exactly this shape, and the
 * mismatch branch is the only branch that renders it.
 */
describe("subagentTranscriptReconciliation — desktop-local files (ISS-5762)", () => {
  /** The exact summary shape the desktop main process emits. */
  function localFile(fileKey: string): TranscriptAvailabilitySummary {
    return {
      fileKey,
      availability: TranscriptAvailability.Available,
      uploadedAt: null,
      permanentFailureReason: null,
    };
  }

  it("claims no transport for files that never left the disk", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [
        localFile("main"),
        localFile("subagent:agent-1"),
        localFile("subagent:agent-2"),
      ],
      reportedSubagentCount: 5,
    });

    expect(summary.subagentFiles.every((f) => f.uploadedAt === null)).toBe(
      true
    );
    expect(subagentTranscriptReconciliation(summary)).toBe(
      "5 subagents, 2 transcripts available"
    );
  });

  it("keeps the unreadable clauses transport-free as well", () => {
    const summary = buildSubagentTranscriptSummary({
      files: [
        localFile("main"),
        localFile("subagent:agent-1"),
        {
          ...localFile("subagent:agent-2"),
          availability: TranscriptAvailability.UploadFailed,
        },
      ],
      reportedSubagentCount: 5,
    });
    const caption = subagentTranscriptReconciliation(summary);

    expect(caption).toBe("5 subagents, 1 transcript available · 1 unavailable");
    expect(caption).not.toMatch(TRANSPORT_VERB);
  });
});
