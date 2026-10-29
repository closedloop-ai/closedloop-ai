import type { DocumentSessionsResponse } from "@repo/api/src/types/document-sessions";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
// Reuse the exact shared Sessions fixtures to verify the document adapter.
import {
  completeSessionsTrace,
  partialSessionsTrace,
  sessionsPanelDetail,
} from "../../../branches/components/detail/branch-sessions-panel-fixtures";
import {
  RELATED_SESSIONS_EMPTY_MESSAGE,
  RELATED_SESSIONS_ERROR_MESSAGE,
  RELATED_SESSIONS_LOADING_MESSAGE,
} from "../../lib/related-sessions-labels";
import { DocumentSessionsPanel } from "../document-sessions-tab";

const response: DocumentSessionsResponse = {
  detail: {
    id: "document-a",
    sessions: sessionsPanelDetail.sessions,
    mergedTrace: [],
    estimatedCostUsd: sessionsPanelDetail.estimatedCostUsd,
    attributedCostUsd: sessionsPanelDetail.estimatedCostUsd,
  },
  trace: completeSessionsTrace,
};

function panel(
  data?: DocumentSessionsResponse,
  isError = false,
  onRetry = vi.fn()
) {
  return (
    <DocumentSessionsPanel
      data={data}
      isError={isError}
      isLoading={!(data || isError)}
      onRetry={onRetry}
    />
  );
}

describe("DocumentSessionsPanel", () => {
  it("renders shared timeline and combined trace without inventing branch or PR context", () => {
    render(panel(response));
    expect(
      screen.getByText("Combined session trace", { exact: false })
    ).toHaveTextContent("2 sessions");
    expect(
      screen.getByText("Sessions", { exact: false, selector: ".bq-act-title" })
    ).toBeVisible();
    expect(screen.queryByText("PR timeline")).not.toBeInTheDocument();
    expect(screen.queryByText("LOC/$")).not.toBeInTheDocument();
  });

  it("keeps unknown population visible as incomplete instead of claiming empty", () => {
    render(
      panel({
        ...response,
        trace: { ...completeSessionsTrace, qualifyingSessionCount: null },
      })
    );
    expect(
      screen.getByText("Combined session trace", { exact: false })
    ).toBeVisible();
    expect(
      screen.getByText("Combined session trace", { exact: false })
    ).not.toHaveTextContent("sessions");
    expect(
      screen.getByText("Sessions", { exact: false, selector: ".bq-act-title" })
    ).not.toHaveTextContent("2 sessions");
    expect(
      screen.queryByText(RELATED_SESSIONS_EMPTY_MESSAGE)
    ).not.toBeInTheDocument();
  });

  it("shows the approved empty state only for a known empty population", () => {
    render(
      panel({
        ...response,
        trace: {
          ...completeSessionsTrace,
          qualifyingSessionCount: 0,
          sessions: [],
          items: [],
        },
      })
    );
    expect(screen.getByText(RELATED_SESSIONS_EMPTY_MESSAGE)).toBeVisible();
    expect(
      screen.queryByText("Combined session trace", { exact: false })
    ).not.toBeInTheDocument();
  });

  it("keeps unavailable trace evidence scoped to sessions without a branch claim", () => {
    render(
      panel({ ...response, trace: { ...partialSessionsTrace, items: [] } })
    );
    expect(screen.getByText("Session trace unavailable")).toBeVisible();
    expect(
      screen.queryByText("Linked Sessions remain part of this Branch", {
        exact: false,
      })
    ).not.toBeInTheDocument();
  });

  it("keeps related sessions visible when every hydration fails", () => {
    render(
      panel({
        ...response,
        detail: { ...response.detail, sessions: [] },
        trace: { ...partialSessionsTrace, items: [] },
      })
    );
    expect(screen.getByText("Session trace unavailable")).toBeVisible();
    expect(
      screen.getByText("Combined session trace", { exact: false })
    ).toHaveTextContent("0 of 2 sessions rendered");
    expect(
      screen.getByText("Sessions", { exact: false, selector: ".bq-act-title" })
    ).toHaveTextContent("0 of 2 sessions");
    expect(
      screen.queryByText("No sessions on this branch yet")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(RELATED_SESSIONS_EMPTY_MESSAGE)
    ).not.toBeInTheDocument();
  });

  it("renders a complete empty trace without a fabricated branch description", () => {
    render(
      panel({ ...response, trace: { ...completeSessionsTrace, items: [] } })
    );
    expect(screen.getByText("No merged trace")).toBeVisible();
    expect(
      screen.queryByText("No trace captured for this branch yet.")
    ).not.toBeInTheDocument();
  });

  it("shows loading separately from empty", () => {
    render(panel());
    expect(
      screen.getByRole("status", { name: RELATED_SESSIONS_LOADING_MESSAGE })
    ).toBeVisible();
    expect(
      screen.queryByText(RELATED_SESSIONS_EMPTY_MESSAGE)
    ).not.toBeInTheDocument();
  });

  it("shows a failed read and retries rather than exposing cached success", async () => {
    const retry = vi.fn();
    render(panel(response, true, retry));
    expect(screen.getByRole("alert")).toHaveTextContent(
      RELATED_SESSIONS_ERROR_MESSAGE
    );
    expect(
      screen.queryByText("Combined session trace", { exact: false })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
