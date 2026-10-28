import {
  SourceAccessState,
  type SourceOccurrence,
  SourceOccurrenceType,
} from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadPage,
  type AgentComponentInvocationReadRow,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_FILE_PARAM,
  TRANSCRIPT_INVOCATION_ANCHOR_PARAM,
} from "../../../lib/session-transcript-href";
import { InvocationEvidenceList } from "../invocation-evidence-list";

const RE_LEAD_NAME = /^lead-/;

describe("InvocationEvidenceList lead and context fallbacks", () => {
  it("names the row by rawName when no normalized name exists", () => {
    renderList([row({ normalizedName: undefined, rawName: "raw-review" })]);

    expect(screen.getByText("raw-review")).toBeInTheDocument();
  });

  it("names the row by componentKey when neither name exists", () => {
    renderList([row({ normalizedName: undefined, rawName: undefined })]);

    expect(screen.getByText("component-key")).toBeInTheDocument();
  });

  it("labels the session by its internal id when the external id is empty", () => {
    renderList([row({ externalSessionId: "" })], sessionHref);

    expect(
      screen.getByRole("link", { name: "session-internal" })
    ).toBeInTheDocument();
  });

  it("renders the session label as plain text when the host gives no href", () => {
    renderList([row()], () => null);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("external-session")).toBeInTheDocument();
  });

  it("marks a missing branch and a missing invocation time as not captured", () => {
    renderList([row({ branchName: undefined, invokedAt: null })]);

    // Lead time and branch line both fall back to the same phrase.
    expect(
      screen.getByText((_content, element) =>
        Boolean(
          element?.classList.contains("font-mono") &&
            element.textContent === "Skill · Not captured"
        )
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText("Not captured").length).toBeGreaterThan(1);
  });

  it("prints an unparseable invocation time raw", () => {
    renderList([row({ invokedAt: "not-a-date" })]);

    expect(
      screen.getByText((_content, element) =>
        Boolean(
          element?.classList.contains("font-mono") &&
            element.textContent === "Skill · not-a-date"
        )
      )
    ).toBeInTheDocument();
  });
});

describe("InvocationEvidenceList revision cell", () => {
  it("shows a short revision id in full with a Copy revision action", () => {
    renderList([
      row({ definitionHash: undefined, definitionVersionId: "rev-short" }),
    ]);

    expect(screen.getByText("rev:rev-short")).toHaveAttribute(
      "title",
      "rev-short"
    );
    expect(
      screen.getByRole("button", { name: "Copy revision" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy hash" })).toBeNull();
  });

  it("prints an identifier of exactly sixteen characters in full", () => {
    renderList([row({ definitionHash: "0123456789abcdef" })]);

    expect(screen.getByText("sha256:0123456789abcdef")).toHaveAttribute(
      "title",
      "0123456789abcdef"
    );
  });

  it("renders the empty-value dash when neither hash nor revision exists", () => {
    const { container } = renderList([
      row({ definitionHash: undefined, definitionVersionId: undefined }),
    ]);

    expect(
      container.querySelector('[data-slot="grid-empty-value"]')
    ).toHaveTextContent("—");
    expect(screen.queryByRole("button", { name: "Copy revision" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy hash" })).toBeNull();
  });
});

describe("InvocationEvidenceList status chip", () => {
  it("renders matched as success, ambiguous as warning, and unresolved as muted", () => {
    renderList([
      row({
        id: "m",
        sequence: 3,
        status: AgentComponentInvocationAttributionStatus.Matched,
      }),
      row({
        id: "a",
        sequence: 2,
        status: AgentComponentInvocationAttributionStatus.Ambiguous,
      }),
      row({
        id: "b",
        sequence: 1,
        status: AgentComponentInvocationAttributionStatus.Unresolved,
      }),
    ]);

    expect(screen.getByText("Matched")).toHaveClass("bg-success/12");
    expect(screen.getByText("Ambiguous")).toHaveClass("bg-warning/14");
    expect(screen.getByText("Unresolved")).toHaveClass("bg-muted/70");
    expect(screen.getByText("Unresolved")).not.toHaveClass("bg-warning/14");
  });
});

describe("InvocationEvidenceList session deep link", () => {
  it("strips a leading hash from the host href", () => {
    renderList([row()], (sessionId) => `#/sessions/${sessionId}`);

    const href = linkHref("external-session");
    expect(href.startsWith("/sessions/session-internal")).toBe(true);
    expect(href).not.toContain("#");
  });

  it("addresses the child session transcript when the row carries one", () => {
    renderList([row({ childSessionId: "child-1" })], sessionHref);

    expect(linkParams().get(TRANSCRIPT_FILE_PARAM)).toBe("subagent:child-1");
  });

  it("addresses the main transcript for a direct event invocation even with an agent id", () => {
    renderList(
      [
        row({
          externalAgentId: "agent-1",
          relationship: AgentComponentInvocationRelationship.Direct,
        }),
      ],
      sessionHref
    );

    // The main transcript is addressed by the bare href, with no file param.
    expect(linkParams().get(TRANSCRIPT_FILE_PARAM)).toBeNull();
  });

  it("addresses the agent sidechain for an agent anchor without a transcript file id", () => {
    renderList(
      [
        row({
          anchor: {
            agentId: "agent-row",
            kind: AgentComponentInvocationAnchorKind.Agent,
          },
          externalAgentId: "agent-ext",
          relationship: AgentComponentInvocationRelationship.Direct,
        }),
      ],
      sessionHref
    );

    const params = linkParams();
    expect(params.get(TRANSCRIPT_FILE_PARAM)).toBe("subagent:agent-ext");
    expect(
      JSON.parse(params.get(TRANSCRIPT_INVOCATION_ANCHOR_PARAM) ?? "{}")
    ).toEqual({
      agentId: "agent-row",
      externalAgentId: "agent-ext",
      kind: AgentComponentInvocationAnchorKind.Agent,
    });
  });

  it("leaves an agent anchor without external id untouched when the row has none", () => {
    renderList(
      [
        row({
          anchor: {
            agentId: "agent-row",
            kind: AgentComponentInvocationAnchorKind.Agent,
          },
          externalAgentId: undefined,
        }),
      ],
      sessionHref
    );

    expect(
      JSON.parse(linkParams().get(TRANSCRIPT_INVOCATION_ANCHOR_PARAM) ?? "{}")
    ).toEqual({
      agentId: "agent-row",
      kind: AgentComponentInvocationAnchorKind.Agent,
    });
  });

  it("keeps an agent anchor's own external id instead of the row's", () => {
    renderList(
      [
        row({
          anchor: {
            agentId: "agent-row",
            externalAgentId: "anchor-ext",
            kind: AgentComponentInvocationAnchorKind.Agent,
          },
          externalAgentId: "row-ext",
        }),
      ],
      sessionHref
    );

    const anchor = JSON.parse(
      linkParams().get(TRANSCRIPT_INVOCATION_ANCHOR_PARAM) ?? "{}"
    );
    expect(anchor.externalAgentId).toBe("anchor-ext");
  });

  it("does not invent a provider tool-use id for an event anchor when the row has none", () => {
    renderList([row({ providerInvocationId: undefined })], sessionHref);

    expect(
      JSON.parse(linkParams().get(TRANSCRIPT_INVOCATION_ANCHOR_PARAM) ?? "{}")
    ).toEqual({
      eventId: "event-1",
      kind: AgentComponentInvocationAnchorKind.Event,
    });
  });

  it("keeps an event anchor's own provider tool-use id", () => {
    renderList(
      [
        row({
          anchor: {
            eventId: "event-1",
            kind: AgentComponentInvocationAnchorKind.Event,
            providerToolUseId: "anchor-toolu",
          },
          externalAgentId: "row-agent",
          providerInvocationId: "row-toolu",
          relationship: AgentComponentInvocationRelationship.Direct,
        }),
      ],
      sessionHref
    );

    // Whole anchor, so the row's agent id cannot leak into an event anchor.
    expect(
      JSON.parse(linkParams().get(TRANSCRIPT_INVOCATION_ANCHOR_PARAM) ?? "{}")
    ).toEqual({
      eventId: "event-1",
      kind: AgentComponentInvocationAnchorKind.Event,
      providerToolUseId: "anchor-toolu",
    });
  });
});

describe("InvocationEvidenceList row ordering", () => {
  it("orders by time desc, then sequence desc, then id asc, with missing times last", () => {
    renderList([
      row({ id: "b", invokedAt: T1, normalizedName: "lead-b", sequence: 1 }),
      row({ id: "a", invokedAt: T1, normalizedName: "lead-a", sequence: 1 }),
      row({ id: "c", invokedAt: T1, normalizedName: "lead-c", sequence: 5 }),
      row({ id: "d", invokedAt: T2, normalizedName: "lead-d", sequence: 0 }),
      row({ id: "e", invokedAt: null, normalizedName: "lead-e", sequence: 9 }),
    ]);

    expect(
      screen.getAllByText(RE_LEAD_NAME).map((node) => node.textContent)
    ).toEqual(["lead-d", "lead-c", "lead-a", "lead-b", "lead-e"]);
  });
});

describe("InvocationEvidenceList genuine evidence source", () => {
  it.each([
    {
      expected: "org/repo @abc123 skills/review.md",
      name: "repository commit with commit and path",
      overrides: {
        evidenceClass: AgentComponentInvocationEvidenceClass.RepositoryCommit,
        repositoryCommit: "abc123",
        repositoryFullName: "org/repo",
        sourcePath: "skills/review.md",
      },
    },
    {
      expected: "org/repo",
      name: "repository commit without commit or path",
      overrides: {
        evidenceClass: AgentComponentInvocationEvidenceClass.RepositoryCommit,
        repositoryCommit: undefined,
        repositoryFullName: "org/repo",
        sourcePath: undefined,
      },
    },
    {
      expected: "Pack pack-9",
      name: "pack membership with a pack id",
      overrides: {
        evidenceClass: AgentComponentInvocationEvidenceClass.PackMembership,
        packId: "pack-9",
      },
    },
    {
      expected: "collected/path.md",
      name: "collector snapshot with a source path",
      overrides: {
        evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
        // A pack id on the row must not claim a collector snapshot as pack
        // evidence: the evidence class decides which source is genuine.
        packId: "pack-must-not-render",
        sourcePath: "collected/path.md",
      },
    },
  ])("renders the $name with a copy action", ({ expected, overrides }) => {
    renderList([row(overrides)]);

    // Exact attribute, not a normalized text match: a dropped empty-part filter
    // would leave the gaps in this string and still pass a normalized compare.
    expect(screen.getByTitle(expected)).toHaveAttribute("title", expected);
    expect(
      screen.getByRole("button", { name: "Copy source" })
    ).toBeInTheDocument();
  });

  it.each([
    {
      name: "repository commit without a repository",
      overrides: {
        evidenceClass: AgentComponentInvocationEvidenceClass.RepositoryCommit,
        repositoryFullName: undefined,
      },
    },
    {
      name: "pack membership without a pack id",
      overrides: {
        evidenceClass: AgentComponentInvocationEvidenceClass.PackMembership,
        packId: undefined,
      },
    },
    {
      name: "collector snapshot without a source path",
      overrides: {
        evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
        sourcePath: undefined,
      },
    },
  ])(
    "renders the $name as not captured with no copy action",
    ({ overrides }) => {
      renderList([row({ branchName: "feat/x", ...overrides })]);

      expect(screen.getByTitle("Not captured")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Copy source" })).toBeNull();
    }
  );
});

describe("InvocationEvidenceList source occurrences", () => {
  it.each([
    {
      expected: "org/repo @def456 .claude/skills/x.md",
      occurrence: occurrence({
        occurrenceType: SourceOccurrenceType.Repository,
        repoCommit: "def456",
        repoFullName: "org/repo",
        repoPath: ".claude/skills/x.md",
      }),
    },
    {
      expected: "org/repo",
      occurrence: occurrence({
        occurrenceType: SourceOccurrenceType.Repository,
        repoFullName: "org/repo",
      }),
    },
    {
      expected: "Pack pack-1",
      occurrence: occurrence({
        occurrenceType: SourceOccurrenceType.Pack,
        packId: "pack-1",
      }),
    },
    {
      expected: "Pack source",
      occurrence: occurrence({ occurrenceType: SourceOccurrenceType.Pack }),
    },
    {
      expected: "Distributed",
      occurrence: occurrence({
        occurrenceType: SourceOccurrenceType.Distributed,
      }),
    },
    {
      expected: "Built-in (Claude) (inaccessible)",
      occurrence: occurrence({
        accessState: SourceAccessState.Inaccessible,
        occurrenceType: SourceOccurrenceType.BuiltinClaude,
      }),
    },
  ])("renders $expected", ({ expected, occurrence: source }) => {
    renderList([row({ sourceOccurrence: source })]);

    expect(screen.getByTitle(expected)).toHaveAttribute("title", expected);
  });
});

const T1 = "2026-07-22T12:00:00.000Z";
const T2 = "2026-07-23T12:00:00.000Z";

function sessionHref(sessionId: string): string {
  return `/sessions/${sessionId}`;
}

function row(
  overrides: Partial<AgentComponentInvocationReadRow> = {}
): AgentComponentInvocationReadRow {
  return {
    anchor: {
      eventId: "event-1",
      kind: AgentComponentInvocationAnchorKind.Event,
    },
    branchName: "feat/evidence",
    componentKey: "component-key",
    definitionHash: "exact-definition-hash",
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    externalInvocationId: "toolu_1",
    externalSessionId: "external-session",
    id: "invocation-1",
    invokedAt: T1,
    kind: AgentComponentInvocationKind.Skill,
    normalizedName: "review",
    providerInvocationId: "toolu_1",
    relationship: AgentComponentInvocationRelationship.Associated,
    sequence: 1,
    sessionId: "session-internal",
    sourceSessionId: "external-session",
    status: AgentComponentInvocationAttributionStatus.Matched,
    ...overrides,
  };
}

function occurrence(overrides: Partial<SourceOccurrence>): SourceOccurrence {
  return {
    accessState: SourceAccessState.Accessible,
    computeTargetId: null,
    firstSeenAt: T1,
    lastSeenAt: T1,
    localPath: null,
    occurrenceType: SourceOccurrenceType.Local,
    packId: null,
    repoCommit: null,
    repoFullName: null,
    repoPath: null,
    ...overrides,
  };
}

function renderList(
  items: AgentComponentInvocationReadRow[],
  getSessionHref?: (sessionId: string) => string | null
) {
  const page: AgentComponentInvocationReadPage = {
    ambiguousCount: 0,
    hasMore: false,
    items,
    total: items.length,
    unmatchedCount: 0,
  };
  const navigation = createMemoryNavigation({
    initialPath: "/agents",
    orgSlug: "org-test",
  });
  return render(
    <NavigationProvider adapter={navigation.adapter}>
      <InvocationEvidenceList getSessionHref={getSessionHref} page={page} />
    </NavigationProvider>
  );
}

function linkHref(name: string): string {
  return screen.getByRole("link", { name }).getAttribute("href") ?? "";
}

function linkParams(): URLSearchParams {
  return new URLSearchParams(linkHref("external-session").split("?")[1]);
}
