import { ApiError } from "@repo/app/shared/api/api-error";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { populatedAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import {
  classifySessionDetailError,
  SessionDetailErrorKind,
} from "../agent-session-detail-states";
import { AgentSessionDetailView } from "../agent-session-detail-view";

const BACK_TO_SESSIONS_LINK_NAME = /back to sessions/i;
const SKELETON_SELECTOR = ".animate-pulse";

function renderState(ui: React.ReactElement) {
  return render(<AppCoreStoryProviders>{ui}</AppCoreStoryProviders>);
}

// FEA-3984: the loading → not-found / unavailable → loaded state machine for the
// shared session-detail body. Drives AgentSessionDetailView directly with the
// exact (isLoading, isError, errorKind, session) tuples its callers produce from
// `useAgentSessionDetail`, so each production transition is exercised.
describe("AgentSessionDetailView missing/errored states (FEA-3984)", () => {
  it("shows the skeleton for a genuine first load (pending, no row yet)", () => {
    renderState(<AgentSessionDetailView backHref="/sessions" isLoading />);

    expect(document.querySelector(SKELETON_SELECTOR)).toBeInTheDocument();
    expect(screen.queryByText("Session not found")).not.toBeInTheDocument();
    expect(screen.queryByText("Session unavailable")).not.toBeInTheDocument();
  });

  // A 404 settles the query to error with no row: `useAgentSessionDetail`'s two
  // sources both reject a missing id with `ApiError(404)`, so isLoading is false,
  // isError is true, and errorKind classifies as NotPresent. That must land on
  // "Session not found", never a perpetual skeleton.
  it("shows not-found (no skeleton) once a missing-id read settles with a 404", () => {
    renderState(
      <AgentSessionDetailView
        backHref="/sessions"
        errorKind={SessionDetailErrorKind.NotPresent}
        isError
        isLoading={false}
      />
    );

    expect(document.querySelector(SKELETON_SELECTOR)).not.toBeInTheDocument();
    expect(screen.getByText("Session not found")).toBeInTheDocument();
    expect(screen.queryByText("Session unavailable")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: BACK_TO_SESSIONS_LINK_NAME })
    ).toHaveAttribute("href", "/sessions");
  });

  // A transient failure (gateway down / db-host worker died / 5xx) settles the
  // query to error with no row and errorKind ProviderError. That must NOT claim
  // the session doesn't exist — it renders the "Session unavailable" variant.
  it("shows the unavailable variant (not not-found) for a non-404 provider error", () => {
    renderState(
      <AgentSessionDetailView
        backHref="/sessions"
        errorKind={SessionDetailErrorKind.ProviderError}
        isError
        isLoading={false}
      />
    );

    expect(document.querySelector(SKELETON_SELECTOR)).not.toBeInTheDocument();
    expect(screen.getByText("Session unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Session not found")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: BACK_TO_SESSIONS_LINK_NAME })
    ).toHaveAttribute("href", "/sessions");
  });

  // A background detail-poll refetch leaves a loaded query with isLoading false
  // (isPending is false once data exists), so this tuple does not arise in
  // production; the guard nonetheless keeps loaded content over a stray
  // isLoading so a poll tick never flashes the trace back to the skeleton.
  it("keeps loaded content over a stray isLoading (no skeleton flash on refetch)", () => {
    renderState(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading
        session={populatedAgentSessionDetailFixture}
      />
    );

    expect(document.querySelector(SKELETON_SELECTOR)).not.toBeInTheDocument();
    expect(screen.getByText("Session Trace")).toBeInTheDocument();
    expect(screen.queryByText("Session not found")).not.toBeInTheDocument();
  });
});

describe("classifySessionDetailError (FEA-3984)", () => {
  it("classifies a 404 ApiError as NotPresent", () => {
    expect(classifySessionDetailError(new ApiError("gone", 404))).toBe(
      SessionDetailErrorKind.NotPresent
    );
  });

  it("classifies a 5xx ApiError as ProviderError", () => {
    expect(classifySessionDetailError(new ApiError("boom", 503))).toBe(
      SessionDetailErrorKind.ProviderError
    );
  });

  it("classifies a non-ApiError (network throw) as ProviderError", () => {
    expect(classifySessionDetailError(new Error("network down"))).toBe(
      SessionDetailErrorKind.ProviderError
    );
    expect(classifySessionDetailError(undefined)).toBe(
      SessionDetailErrorKind.ProviderError
    );
  });
});
