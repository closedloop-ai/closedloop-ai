import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildSessionTrace } from "../../../../../lib/session-trace/build-session-trace";
import {
  SESSION_TRACE_EXTENT_LABEL,
  SESSION_TRACE_EXTENT_NOTE,
  SESSION_TRACE_KIND_LABEL,
  SessionTraceExtentSource,
  type SessionTraceInvocation,
  type SessionTraceSpan,
} from "../../../../../lib/session-trace/session-trace-node";
import { PreviewTraceInspector } from "../preview-trace-inspector";
import {
  PREVIEW_EVIDENCE_LABEL,
  type PreviewSpanExtras,
} from "../preview-traced-session";
import {
  ACTIVITY_HEADING,
  FINDINGS_HEADING,
  previewTraceDetailValue,
  previewTraceSection,
} from "./support/preview-trace-dom";
import {
  buildSpan,
  extrasOf,
  type PreviewTraceTestRow,
  previewTraceRow,
  spanIn,
} from "./support/preview-trace-rows";

const CRITICAL_PATH_BADGE = "Critical path";
const TURN_SPEND_HEADING = "Turn spend (already inside the session total)";
const FOOTPRINT_HEADING = "Context footprint (a different population)";
const COUNTED_LABEL = "Counted";
const DASHED_EDGE = "border-dashed";
const PLACEHOLDER =
  /Select a span to see its ancestry, its extent provenance, and the spend underneath it\./;

function renderInspector(
  span: SessionTraceSpan | null,
  canFocusSubtree = false,
  extras: PreviewSpanExtras = {}
): {
  onFocusSubtree: ReturnType<typeof vi.fn<(span: SessionTraceSpan) => void>>;
  onOpenComponent: ReturnType<typeof vi.fn<(span: SessionTraceSpan) => void>>;
} {
  const onFocusSubtree = vi.fn<(span: SessionTraceSpan) => void>();
  const onOpenComponent = vi.fn<(span: SessionTraceSpan) => void>();
  render(
    <PreviewTraceInspector
      canFocusSubtree={canFocusSubtree}
      extras={extras}
      onFocusSubtree={onFocusSubtree}
      onOpenComponent={onOpenComponent}
      span={span}
    />
  );
  return { onFocusSubtree, onOpenComponent };
}

const fullRow: PreviewTraceTestRow = previewTraceRow("n5", 300, {
  parentExternalInvocationId: "n2",
  durationMs: 2000,
  kind: AgentComponentInvocationKind.Subagent,
  componentKey: "design-critic",
  externalAgentId: "ag-2",
  parentAgentId: "ag-1",
  model: "claude-opus",
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 5000,
  estimatedCost: 0.482,
  usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
  footprintTokens: 1234,
  evidenceClass: AgentComponentInvocationEvidenceClass.OtelCounter,
  definitionHash: "sha256:abc",
  definitionVersionId: "v3",
  packId: "pack-1",
  repositoryFullName: "org/repo",
  repositoryCommit: "deadbee",
  succeeded: true,
  detail: { command: "ls -la", "exit code": "0" },
});

const fullTrace = buildSessionTrace([
  previewTraceRow("n1", 0, {
    durationMs: 10_000,
    kind: AgentComponentInvocationKind.Command,
    componentKey: "/design",
  }),
  previewTraceRow("n2", 100, {
    durationMs: 5000,
    kind: AgentComponentInvocationKind.Skill,
    componentKey: "design",
    parentExternalInvocationId: "n1",
  }),
  fullRow,
]);

describe("PreviewTraceInspector with no span", () => {
  it("asks for a selection and offers no controls", () => {
    renderInspector(null);
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("PreviewTraceInspector with every optional field present", () => {
  const span = spanIn(fullTrace, "n5");

  it("leads with the kind, the critical-path badge and the component name", () => {
    renderInspector(span);
    expect(
      screen.getByText(
        SESSION_TRACE_KIND_LABEL[AgentComponentInvocationKind.Subagent]
      )
    ).toBeInTheDocument();
    expect(screen.getByText(CRITICAL_PATH_BADGE)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: "design-critic" })
    ).toBeInTheDocument();
    expect(screen.queryByText(PLACEHOLDER)).not.toBeInTheDocument();
  });

  it("walks the ancestry from the session root and states depth, agent and order", () => {
    renderInspector(span, false, extrasOf(fullRow));
    const section = previewTraceSection("Which call reached this one");
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["session root", "›/design", "›design"]);
    expect(previewTraceDetailValue(section, "Depth")).toBe("3");
    expect(previewTraceDetailValue(section, "Agent")).toBe("ag-2 · from ag-1");
    expect(previewTraceDetailValue(section, "Order in session")).toBe("#5");
  });

  it("states a measured extent with its note, own time and start", () => {
    renderInspector(span);
    const section = previewTraceSection("Extent");
    expect(
      within(section).getByText(
        SESSION_TRACE_EXTENT_LABEL[SessionTraceExtentSource.Measured]
      )
    ).toBeInTheDocument();
    expect(within(section).getByText("2.0s")).toBeInTheDocument();
    expect(
      within(section).getByText(
        SESSION_TRACE_EXTENT_NOTE[SessionTraceExtentSource.Measured]
      )
    ).toBeInTheDocument();
    expect(previewTraceDetailValue(section, "Own time")).toBe(
      "2.0s not covered by a child"
    );
    expect(previewTraceDetailValue(section, "Starts")).toBe(
      "300ms into the session"
    );
  });

  it("draws a measured extent's badge with a solid edge", () => {
    renderInspector(span);
    const badge = within(previewTraceSection("Extent")).getByText(
      SESSION_TRACE_EXTENT_LABEL[SessionTraceExtentSource.Measured]
    );
    // The edge is the only thing that changes with the extent source; the word
    // comes from the label map, not from this branch.
    expect(badge).not.toHaveClass(DASHED_EDGE);
  });

  it("keeps turn spend in its own block, including the measured count", () => {
    renderInspector(span);
    const section = previewTraceSection(TURN_SPEND_HEADING);
    expect(previewTraceDetailValue(section, "Model")).toBe("claude-opus");
    expect(previewTraceDetailValue(section, "Input")).toBe("1,200");
    expect(previewTraceDetailValue(section, "Output")).toBe("340");
    expect(previewTraceDetailValue(section, "Cache read")).toBe("5,000");
    expect(previewTraceDetailValue(section, "This call")).toBe("$0.4820");
    expect(
      previewTraceDetailValue(section, "This call and everything under it")
    ).toBe("$0.4820");
    expect(previewTraceDetailValue(section, COUNTED_LABEL)).toBe(
      "Bracketed around this call"
    );
  });

  it("keeps the context footprint in a separate block", () => {
    renderInspector(span);
    expect(
      previewTraceDetailValue(
        previewTraceSection(FOOTPRINT_HEADING),
        "Injected into context"
      )
    ).toBe("1,234 tokens");
  });

  it("lists every detail key under what it did when the call succeeded", () => {
    renderInspector(span, false, extrasOf(fullRow));
    const section = previewTraceSection(ACTIVITY_HEADING);
    expect(previewTraceDetailValue(section, "command")).toBe("ls -la");
    expect(previewTraceDetailValue(section, "exit code")).toBe("0");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("states every evidence field it was given", () => {
    renderInspector(span);
    const section = previewTraceSection("Evidence");
    expect(previewTraceDetailValue(section, "Attribution")).toBe(
      AgentComponentInvocationAttributionStatus.Matched
    );
    expect(previewTraceDetailValue(section, "Attributed from")).toBe(
      PREVIEW_EVIDENCE_LABEL[AgentComponentInvocationEvidenceClass.OtelCounter]
    );
    expect(previewTraceDetailValue(section, "Definition hash")).toBe(
      "sha256:abc"
    );
    expect(previewTraceDetailValue(section, "Component version")).toBe("v3");
    expect(previewTraceDetailValue(section, "Pack")).toBe("pack-1");
    expect(previewTraceDetailValue(section, "Ran against")).toBe(
      "org/repo @ deadbee"
    );
    expect(previewTraceDetailValue(section, "Invocation id")).toBe("n5");
  });
});

describe("PreviewTraceInspector with the optional fields missing", () => {
  // Two roots: the longer one holds the critical path, so the short one is off it.
  const trace = buildSessionTrace([
    previewTraceRow("n1", 0, { durationMs: 5000 }),
    previewTraceRow("n2", 6000),
    previewTraceRow("n3", 7000, { durationMs: 20_000 }),
  ]);
  const span = spanIn(trace, "n2");

  it("drops the critical-path badge and prints dashes for the unknown agent", () => {
    renderInspector(span);
    expect(screen.queryByText(CRITICAL_PATH_BADGE)).not.toBeInTheDocument();
    const section = previewTraceSection("Which call reached this one");
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["session root"]);
    expect(previewTraceDetailValue(section, "Depth")).toBe("1");
    expect(previewTraceDetailValue(section, "Agent")).toBe("—");
  });

  it("marks an extent with no measured duration as inferred", () => {
    renderInspector(span);
    const section = previewTraceSection("Extent");
    expect(
      within(section).getByText(
        SESSION_TRACE_EXTENT_LABEL[SessionTraceExtentSource.Inferred]
      )
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        SESSION_TRACE_EXTENT_NOTE[SessionTraceExtentSource.Inferred]
      )
    ).toBeInTheDocument();
    expect(previewTraceDetailValue(section, "Own time")).toBe(
      "1.0s not covered by a child"
    );
  });

  it("draws an inferred extent's badge with a dashed edge", () => {
    renderInspector(span);
    const badge = within(previewTraceSection("Extent")).getByText(
      SESSION_TRACE_EXTENT_LABEL[SessionTraceExtentSource.Inferred]
    );
    expect(badge).toHaveClass(DASHED_EDGE);
  });

  it("renders no turn-spend, findings, footprint or activity blocks", () => {
    renderInspector(span);
    expect(
      screen.queryByRole("heading", { name: TURN_SPEND_HEADING })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: FINDINGS_HEADING })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: FOOTPRINT_HEADING })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: ACTIVITY_HEADING })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prints a dash for every evidence field it was not given", () => {
    renderInspector(span);
    const section = previewTraceSection("Evidence");
    // `evidenceClass` is required on `SessionTraceInvocation`, so a row cannot
    // omit it and this field has no dash state to assert. It states the label
    // for whatever class the row carries; the optional four below still dash.
    expect(previewTraceDetailValue(section, "Attributed from")).toBe(
      PREVIEW_EVIDENCE_LABEL[
        AgentComponentInvocationEvidenceClass.TranscriptSnapshot
      ]
    );
    expect(previewTraceDetailValue(section, "Definition hash")).toBe("—");
    expect(previewTraceDetailValue(section, "Component version")).toBe("—");
    expect(previewTraceDetailValue(section, "Pack")).toBe("—");
    expect(previewTraceDetailValue(section, "Ran against")).toBe("—");
    expect(previewTraceDetailValue(section, "Invocation id")).toBe("n2");
  });
});

describe("PreviewTraceInspector partial fields", () => {
  it.each([
    ["input tokens", { inputTokens: 10 }],
    ["output tokens", { outputTokens: 10 }],
    ["an estimated cost", { estimatedCost: 0.02 }],
  ] satisfies [string, Partial<SessionTraceInvocation>][])(
    "shows turn spend when only %s is present",
    (_label, usage) => {
      renderInspector(buildSpan([previewTraceRow("n1", 0, usage)], "n1"));
      const section = previewTraceSection(TURN_SPEND_HEADING);
      expect(previewTraceDetailValue(section, "Model")).toBe("—");
      expect(previewTraceDetailValue(section, "Cache read")).toBe("—");
      expect(
        within(section).queryByText(COUNTED_LABEL)
      ).not.toBeInTheDocument();
    }
  );

  it("says an estimated count was derived from a session-wide average", () => {
    renderInspector(
      buildSpan(
        [
          previewTraceRow("n1", 0, {
            inputTokens: 10,
            usageMeasurement:
              AgentComponentInvocationUsageMeasurement.Estimated,
          }),
        ],
        "n1"
      )
    );
    expect(
      previewTraceDetailValue(
        previewTraceSection(TURN_SPEND_HEADING),
        COUNTED_LABEL
      )
    ).toBe("Derived from a session-wide average");
  });

  it("marks the repository as unknown when only the commit was recorded", () => {
    renderInspector(
      buildSpan(
        [previewTraceRow("n1", 0, { repositoryCommit: "deadbee" })],
        "n1"
      )
    );
    expect(
      previewTraceDetailValue(previewTraceSection("Evidence"), "Ran against")
    ).toBe("? @ deadbee");
  });

  it("prints a dash for the repository when no commit was recorded", () => {
    renderInspector(
      buildSpan(
        [previewTraceRow("n1", 0, { repositoryFullName: "org/repo" })],
        "n1"
      )
    );
    expect(
      previewTraceDetailValue(previewTraceSection("Evidence"), "Ran against")
    ).toBe("—");
  });

  it("renders an empty detail object as no activity block", () => {
    renderInspector(
      buildSpan([previewTraceRow("n1", 0, { detail: {} })], "n1")
    );
    expect(
      screen.queryByRole("heading", { name: ACTIVITY_HEADING })
    ).not.toBeInTheDocument();
  });

  it.each(Object.values(AgentComponentInvocationKind))(
    "badges a %s span with its kind label",
    (kind) => {
      renderInspector(buildSpan([previewTraceRow("n1", 0, { kind })], "n1"));
      expect(
        screen.getByText(SESSION_TRACE_KIND_LABEL[kind])
      ).toBeInTheDocument();
    }
  );
});

describe("PreviewTraceInspector controls", () => {
  const span = spanIn(fullTrace, "n2");

  it("opens the component when its name is activated", async () => {
    const user = userEvent.setup();
    const { onOpenComponent, onFocusSubtree } = renderInspector(span, true);
    await user.click(screen.getByRole("button", { name: "design" }));
    expect(onOpenComponent).toHaveBeenCalledTimes(1);
    expect(onOpenComponent).toHaveBeenCalledWith(span);
    expect(onFocusSubtree).not.toHaveBeenCalled();
  });

  it("focuses the subtree when focusing is allowed", async () => {
    const user = userEvent.setup();
    const { onOpenComponent, onFocusSubtree } = renderInspector(span, true);
    const focus = screen.getByRole("button", { name: "Focus subtree" });
    expect(focus).toBeEnabled();
    await user.click(focus);
    expect(onFocusSubtree).toHaveBeenCalledTimes(1);
    expect(onFocusSubtree).toHaveBeenCalledWith(span);
    expect(onOpenComponent).not.toHaveBeenCalled();
  });

  it("disables focusing on a leaf span, which the caller marks unfocusable", async () => {
    const user = userEvent.setup();
    const leaf = spanIn(fullTrace, "n5");
    expect(leaf.children).toHaveLength(0);
    const { onFocusSubtree } = renderInspector(leaf, false);
    const focus = screen.getByRole("button", { name: "Focus subtree" });
    expect(focus).toBeDisabled();
    await user.click(focus);
    expect(onFocusSubtree).not.toHaveBeenCalled();
  });
});
