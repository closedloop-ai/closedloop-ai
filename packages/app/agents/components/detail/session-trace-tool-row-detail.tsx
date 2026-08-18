"use client";

import {
  resolveToolCallDetailState,
  type ToolItem,
  toolCallDetailEmptyMessage,
} from "@repo/api/src/types/agent-session-tool-call";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";

/**
 * Expanded panel for one tool-call row: command, output, meta — or a TRUTHFUL
 * empty state (FEA-3696). When no detail is inline, we render a state-specific
 * message from the shared SSOT (`redacted` / `unavailable` / `malformed`) rather
 * than a single ambiguous "no detail captured", so a cloud row whose detail
 * merely lives in the archived transcript never claims the call had none.
 *
 * Lives beside `session-trace.tsx` rather than inside it: this is the UI half of
 * the tool-call detail contract in `@repo/api/src/types/agent-session-tool-call`,
 * and it is the only part of the trace that reads that contract's state helpers.
 */
export function SessionTraceToolRowDetail({
  tool,
}: Readonly<{ tool: ToolItem }>) {
  const emptyMessage = toolCallDetailEmptyMessage(
    resolveToolCallDetailState(tool)
  );
  const hasDetail = Boolean(
    tool.input || tool.output || tool.durationMs !== undefined || tool.status
  );
  // No inline detail: render the honest, state-specific empty panel. Fall back to
  // the `unavailable` copy for the theoretically-empty `available`/`truncated`
  // case (a producer bug) so the panel is never blank.
  if (!hasDetail) {
    return (
      <div className="st-toolrow-detail">
        <div className="st-toolrow-empty">
          {emptyMessage ?? toolCallDetailEmptyMessage("unavailable")}
        </div>
      </div>
    );
  }

  const meta = [
    tool.status,
    tool.durationMs === undefined ? null : formatDurationMs(tool.durationMs),
  ].filter(Boolean);

  return (
    <div className="st-toolrow-detail">
      {tool.input ? (
        <TraceToolRowField
          label="Command"
          text={tool.input}
          truncated={tool.inputTruncated}
        />
      ) : null}
      {tool.output ? (
        <TraceToolRowField
          label="Output"
          text={tool.output}
          truncated={tool.outputTruncated}
        />
      ) : null}
      {meta.length > 0 ? (
        <div className="st-toolrow-meta mono">{meta.join(" · ")}</div>
      ) : null}
    </div>
  );
}

function TraceToolRowField({
  label,
  text,
  truncated,
}: Readonly<{ label: string; text: string; truncated?: boolean }>) {
  return (
    <div className="st-toolrow-field">
      <span className="st-toolrow-field-label">{label}</span>
      <pre className="st-toolrow-code mono">
        {text}
        {truncated ? "\n… (truncated)" : ""}
      </pre>
    </div>
  );
}
