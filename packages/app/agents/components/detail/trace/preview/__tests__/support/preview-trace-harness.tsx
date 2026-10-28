import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { render, screen, within } from "@testing-library/react";
import type { SessionTraceInvocation } from "../../../../../../lib/session-trace/session-trace-node";
import type { PreviewTraceParam } from "../../preview-trace-route-state";
import { SessionTracePreviewPanel } from "../../session-trace-preview-panel";
import { ROWS_LIST_NAME } from "./preview-trace-dom";
import { previewTraceRow } from "./preview-trace-rows";

const PREVIEW_TRACE_PATH = "/trace";
export const SPAN_DETAIL_NAME = "Span detail";

/**
 * A two-root session. `/design` (n1) holds the critical path down through
 * `design-critic` (n2) to a failed `Bash` (n3); a second `Bash` (n4) sits beside
 * `design-critic`; a stop hook (n5) is an inferred root off the critical path;
 * `Read` (n6) has no timestamp and lands in the unplaced strip.
 */
export const previewTraceHarnessRows: readonly SessionTraceInvocation[] = [
  previewTraceRow("n1", 0, {
    durationMs: 10_000,
    kind: AgentComponentInvocationKind.Command,
    componentKey: "/design",
    externalAgentId: "ag-0",
    estimatedCost: 1,
    inputTokens: 1000,
    outputTokens: 200,
    footprintTokens: 50,
    cacheReadTokens: 7,
  }),
  previewTraceRow("n2", 100, {
    durationMs: 6000,
    kind: AgentComponentInvocationKind.Subagent,
    componentKey: "design-critic",
    parentExternalInvocationId: "n1",
    externalAgentId: "ag-1",
    parentAgentId: "ag-0",
    estimatedCost: 0.5,
  }),
  previewTraceRow("n3", 200, {
    durationMs: 64,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: "Bash",
    parentExternalInvocationId: "n2",
    externalAgentId: "ag-1",
    succeeded: false,
    detail: { error: "exit status 2" },
  }),
  previewTraceRow("n4", 7000, {
    durationMs: 1000,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: "Bash",
    parentExternalInvocationId: "n1",
    externalAgentId: "ag-0",
  }),
  previewTraceRow("n5", 12_000, {
    kind: AgentComponentInvocationKind.Hook,
    componentKey: "stop-hook",
  }),
  previewTraceRow("n6", null, {
    kind: AgentComponentInvocationKind.Tool,
    componentKey: "Read",
  }),
];

/** Point the jsdom URL at the tab with `search`, as a pasted link would. */
export function visitPreviewTrace(search = ""): void {
  globalThis.window.history.replaceState(
    null,
    "",
    `${PREVIEW_TRACE_PATH}${search}`
  );
}

export function renderPreviewTrace(
  search = "",
  invocations: readonly SessionTraceInvocation[] = previewTraceHarnessRows
): void {
  visitPreviewTrace(search);
  render(<SessionTracePreviewPanel invocations={invocations} />);
}

/** One query parameter as the tab last wrote it to the URL. */
export function previewTraceParam(param: PreviewTraceParam): string | null {
  return new URLSearchParams(globalThis.window.location.search).get(param);
}

/** The value printed under a summary stat's label. */
export function previewTraceStatValue(label: string): string {
  const trigger = screen.getByText(label, { selector: "button" });
  return trigger.closest("dt")?.nextElementSibling?.textContent ?? "";
}

/** Component keys of the drawn rows, top to bottom. */
export function drawnRowKeys(): string[] {
  const list = screen.queryByRole("list", { name: ROWS_LIST_NAME });
  if (list === null) {
    return [];
  }
  return within(list)
    .getAllByRole("button")
    .map(
      (row) => row.querySelector("span.truncate")?.textContent ?? "(unnamed)"
    );
}

/** The inspector rail. */
export function spanDetail(): HTMLElement {
  return screen.getByRole("complementary", { name: SPAN_DETAIL_NAME });
}
