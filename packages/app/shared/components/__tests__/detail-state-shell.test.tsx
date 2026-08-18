import { ApiError } from "@repo/app/shared/api/api-error";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../storybook/decorators";
import {
  classifyDetailError,
  DetailBackLink,
  DetailEmptyState,
  DetailErrorKind,
  DetailLoadingSkeleton,
} from "../detail-state-shell";

const RE_LOADING = /loading it/i;

function renderState(ui: React.ReactElement) {
  return render(<AppCoreStoryProviders>{ui}</AppCoreStoryProviders>);
}

// FEA-3987: the shared 404-vs-transient classifier + presentational building
// blocks that the agent/session/branch detail states compose. The classifier is
// the honesty guard — a transient failure must never resolve to NotPresent.
describe("classifyDetailError (FEA-3987)", () => {
  it("classifies a 404 ApiError as NotPresent", () => {
    expect(classifyDetailError(new ApiError("gone", 404))).toBe(
      DetailErrorKind.NotPresent
    );
  });

  it("classifies a 5xx ApiError as a transient ProviderError", () => {
    expect(classifyDetailError(new ApiError("boom", 503))).toBe(
      DetailErrorKind.ProviderError
    );
  });

  it("classifies a non-404 client ApiError as ProviderError", () => {
    expect(classifyDetailError(new ApiError("nope", 403))).toBe(
      DetailErrorKind.ProviderError
    );
  });

  it("classifies a non-ApiError network throw as ProviderError", () => {
    expect(classifyDetailError(new Error("network down"))).toBe(
      DetailErrorKind.ProviderError
    );
  });

  it("defaults a missing error (settled but empty read) to NotPresent", () => {
    expect(classifyDetailError(undefined)).toBe(DetailErrorKind.NotPresent);
    expect(classifyDetailError(null)).toBe(DetailErrorKind.NotPresent);
  });
});

describe("shared detail state building blocks (FEA-3987)", () => {
  it("announces the loading skeleton to screen readers and hides the slab", () => {
    renderState(<DetailLoadingSkeleton label="Loading it…" />);

    expect(screen.getByRole("status")).toHaveAccessibleName(RE_LOADING);
    expect(document.querySelector("[data-slot='skeleton']")).toHaveAttribute(
      "aria-hidden"
    );
  });

  it("renders the back link with its label as the accessible name + href", () => {
    renderState(<DetailBackLink href="/x/agents" label="Back to Agents" />);

    expect(
      screen.getByRole("link", { name: "Back to Agents" })
    ).toHaveAttribute("href", "/x/agents");
  });

  it("renders the empty state title, description, and back link", () => {
    renderState(
      <DetailEmptyState
        backHref="/x/agents"
        backLabel="Back to Agents"
        description="It hasn't synced yet."
        title="Component not found"
      />
    );

    expect(screen.getByText("Component not found")).toBeInTheDocument();
    expect(screen.getByText("It hasn't synced yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to Agents" })
    ).toHaveAttribute("href", "/x/agents");
  });
});
