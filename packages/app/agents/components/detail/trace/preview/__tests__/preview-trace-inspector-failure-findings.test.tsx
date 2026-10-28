import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSessionTrace } from "../../../../../lib/session-trace/build-session-trace";
import type { SessionTraceSpan } from "../../../../../lib/session-trace/session-trace-node";
import { PreviewTraceInspector } from "../preview-trace-inspector";
import type { PreviewSpanExtras } from "../preview-traced-session";
import {
  ACTIVITY_HEADING,
  FINDINGS_HEADING,
  previewTraceDetailValue,
  previewTraceSection,
} from "./support/preview-trace-dom";
import {
  buildSpan,
  DESIGN_CRITIC_ID,
  extrasOf,
  type PreviewTraceTestRow,
  previewTraceRow,
  spanIn,
  VISUAL_QA_ID,
} from "./support/preview-trace-rows";

const NO_ERROR_MESSAGE = "No error message was recorded for this call.";
const FAN_OUT_WITH_OWN = "This call and everything under it";
const FAN_OUT_WITHOUT_OWN = "Under this call";
const CONFIRMED_LABEL = "Confirmed";
// The detail keys a failure hoists into its block. They are fixture data this
// file writes AND the row labels it reads back, so both go through one name.
const DETAIL_KEY = {
  Error: "error",
  ExitCode: "exit code",
  Decision: "decision",
  Blocking: "blocking",
  Command: "command",
} as const;
const ALERT_DESCRIPTION = '[data-slot="alert-description"]';

function renderInspector(
  span: SessionTraceSpan,
  extras: PreviewSpanExtras = {}
) {
  render(
    <PreviewTraceInspector
      canFocusSubtree={false}
      extras={extras}
      onFocusSubtree={vi.fn()}
      onOpenComponent={vi.fn()}
      span={span}
    />
  );
}

function renderSingle(overrides: Partial<PreviewTraceTestRow>) {
  const row = previewTraceRow("n1", 0, overrides);
  renderInspector(buildSpan([row], row.externalInvocationId), extrasOf(row));
}

describe("PreviewTraceInspector failure block", () => {
  it("leads with the exit code, the message and the failure-only detail rows", () => {
    renderSingle({
      succeeded: false,
      detail: {
        [DETAIL_KEY.Error]: "dagger call check failed",
        [DETAIL_KEY.ExitCode]: "2",
        [DETAIL_KEY.Decision]: "deny",
        [DETAIL_KEY.Blocking]: "true",
        [DETAIL_KEY.Command]: "dagger call check",
      },
    });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Failed · exit 2")).toBeInTheDocument();
    expect(
      within(alert).getByText("dagger call check failed")
    ).toBeInTheDocument();
    expect(previewTraceDetailValue(alert, DETAIL_KEY.Decision)).toBe("deny");
    expect(previewTraceDetailValue(alert, DETAIL_KEY.Blocking)).toBe("true");
    expect(
      within(alert).queryByText(DETAIL_KEY.Command)
    ).not.toBeInTheDocument();
  });

  it("hoists every failure key out of what it did, keeping the work", () => {
    renderSingle({
      succeeded: false,
      detail: {
        [DETAIL_KEY.Error]: "boom",
        [DETAIL_KEY.ExitCode]: "2",
        [DETAIL_KEY.Decision]: "deny",
        [DETAIL_KEY.Blocking]: "true",
        [DETAIL_KEY.Command]: "dagger call check",
      },
    });
    const activity = previewTraceSection(ACTIVITY_HEADING);
    expect(previewTraceDetailValue(activity, DETAIL_KEY.Command)).toBe(
      "dagger call check"
    );
    for (const hoisted of [
      DETAIL_KEY.Error,
      DETAIL_KEY.ExitCode,
      DETAIL_KEY.Decision,
      DETAIL_KEY.Blocking,
    ]) {
      expect(within(activity).queryByText(hoisted)).not.toBeInTheDocument();
    }
  });

  it("keeps the message and exit code in the headline, never as detail rows", () => {
    const detail = {
      [DETAIL_KEY.Error]: "boom",
      [DETAIL_KEY.ExitCode]: "2",
      [DETAIL_KEY.Decision]: "deny",
    };
    renderSingle({ succeeded: false, detail });
    const alert = screen.getByRole("alert");
    const description = alert.querySelector(ALERT_DESCRIPTION);
    expect(description).not.toBeNull();
    expect(previewTraceDetailValue(alert, DETAIL_KEY.Decision)).toBe(
      detail[DETAIL_KEY.Decision]
    );
    expect(within(alert).getByText("Failed · exit 2")).toBeInTheDocument();
    expect(within(alert).getAllByText(detail[DETAIL_KEY.Error])).toHaveLength(
      1
    );
    expect(within(alert).queryByText(DETAIL_KEY.Error)).not.toBeInTheDocument();
    expect(
      within(alert).queryByText(DETAIL_KEY.ExitCode)
    ).not.toBeInTheDocument();
    expect(
      within(alert).queryByText(detail[DETAIL_KEY.ExitCode])
    ).not.toBeInTheDocument();
  });

  it("renders no description under the headline when no detail row is left", () => {
    renderSingle({
      succeeded: false,
      detail: { [DETAIL_KEY.Error]: "boom", [DETAIL_KEY.ExitCode]: "2" },
    });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Failed · exit 2")).toBeInTheDocument();
    expect(alert.querySelector(ALERT_DESCRIPTION)).toBeNull();
  });

  it("says a failure happened even when nothing about it was recorded", () => {
    renderSingle({ succeeded: false });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Failed")).toBeInTheDocument();
    expect(within(alert).getByText(NO_ERROR_MESSAGE)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: ACTIVITY_HEADING })
    ).not.toBeInTheDocument();
  });

  it("omits the detail rows when the failure carries only its message", () => {
    renderSingle({ succeeded: false, detail: { [DETAIL_KEY.Error]: "boom" } });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Failed")).toBeInTheDocument();
    expect(within(alert).getByText("boom")).toBeInTheDocument();
    expect(within(alert).queryByText(NO_ERROR_MESSAGE)).not.toBeInTheDocument();
    expect(
      within(alert).queryByText(DETAIL_KEY.Decision)
    ).not.toBeInTheDocument();
    // Only the message was recorded, so nothing is left to say what it did.
    expect(
      screen.queryByRole("heading", { name: ACTIVITY_HEADING })
    ).not.toBeInTheDocument();
  });

  it("renders no failure block for a call that reported neither outcome", () => {
    renderSingle({
      detail: { [DETAIL_KEY.Error]: "boom", [DETAIL_KEY.Decision]: "deny" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const activity = previewTraceSection(ACTIVITY_HEADING);
    expect(previewTraceDetailValue(activity, DETAIL_KEY.Error)).toBe("boom");
    expect(previewTraceDetailValue(activity, DETAIL_KEY.Decision)).toBe("deny");
  });
});

describe("PreviewTraceInspector findings block", () => {
  it("states spend beside the call's own findings, with confirmed and rate", () => {
    renderSingle({
      externalInvocationId: DESIGN_CRITIC_ID,
      estimatedCost: 0.482,
    });
    const section = previewTraceSection(FINDINGS_HEADING);
    expect(
      within(section).getByText("$0.4820 · 11 findings, 4 invalidated")
    ).toBeInTheDocument();
    expect(previewTraceDetailValue(section, CONFIRMED_LABEL)).toBe("7");
    expect(previewTraceDetailValue(section, "Confirmation rate")).toBe("64%");
    expect(
      within(section).queryByText(FAN_OUT_WITH_OWN)
    ).not.toBeInTheDocument();
    expect(
      within(section).queryByText(FAN_OUT_WITHOUT_OWN)
    ).not.toBeInTheDocument();
  });

  it("states the counts alone when the call has no spend", () => {
    renderSingle({ externalInvocationId: DESIGN_CRITIC_ID });
    const section = previewTraceSection(FINDINGS_HEADING);
    expect(
      within(section).getByText("11 findings, 4 invalidated", { exact: true })
    ).toBeInTheDocument();
  });

  it("rolls a reporting fan-out up onto a parent that reports nothing", () => {
    const trace = buildSessionTrace([
      previewTraceRow("n1", 0, { durationMs: 10_000 }),
      previewTraceRow(DESIGN_CRITIC_ID, 100, {
        durationMs: 1000,
        parentExternalInvocationId: "n1",
      }),
    ]);
    renderInspector(spanIn(trace, "n1"));
    const section = previewTraceSection(FINDINGS_HEADING);
    expect(previewTraceDetailValue(section, FAN_OUT_WITHOUT_OWN)).toBe(
      "11 findings, 4 invalidated · 64%"
    );
    expect(
      within(section).queryByText(CONFIRMED_LABEL)
    ).not.toBeInTheDocument();
    expect(
      within(section).queryByText(FAN_OUT_WITH_OWN)
    ).not.toBeInTheDocument();
  });

  it("adds the whole fan-out beside a reporting call's own figures", () => {
    const trace = buildSessionTrace([
      previewTraceRow(DESIGN_CRITIC_ID, 0, { durationMs: 10_000 }),
      previewTraceRow(VISUAL_QA_ID, 100, {
        durationMs: 1000,
        parentExternalInvocationId: DESIGN_CRITIC_ID,
      }),
    ]);
    renderInspector(spanIn(trace, DESIGN_CRITIC_ID));
    const section = previewTraceSection(FINDINGS_HEADING);
    expect(previewTraceDetailValue(section, CONFIRMED_LABEL)).toBe("7");
    expect(previewTraceDetailValue(section, FAN_OUT_WITH_OWN)).toBe(
      "17 findings, 5 invalidated · 71%"
    );
    expect(
      within(section).queryByText(FAN_OUT_WITHOUT_OWN)
    ).not.toBeInTheDocument();
  });

  it("renders no findings block where nothing in the subtree reports", () => {
    renderSingle({ estimatedCost: 0.5 });
    expect(
      screen.queryByRole("heading", { name: FINDINGS_HEADING })
    ).not.toBeInTheDocument();
  });
});
