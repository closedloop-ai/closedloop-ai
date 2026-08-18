import type { UserProfileStanding } from "@repo/api/src/types/user";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StandingSection } from "../standing-section";

// FEA-4108: the Standing section renders the streak tile only when real streak
// data exists, and hides entirely (no fake zero) when the user has no streak.

describe("StandingSection (FEA-4108)", () => {
  it("hides the whole section when the streak is null (no fake zero)", () => {
    const { container } = render(
      <StandingSection
        isError={false}
        isLoading={false}
        standing={{ streak: null }}
      />
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Standing")).toBeNull();
  });

  it("hides the whole section when standing is unavailable", () => {
    const { container } = render(
      <StandingSection isError={false} isLoading={false} standing={null} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the streak tile with current and best days when data exists", () => {
    const standing: UserProfileStanding = {
      streak: { currentDays: 19, bestDays: 34 },
    };
    render(
      <StandingSection isError={false} isLoading={false} standing={standing} />
    );

    expect(
      screen.getByRole("heading", { name: "Standing" })
    ).toBeInTheDocument();
    expect(screen.getByText("Current streak")).toBeInTheDocument();
    expect(screen.getByText("19")).toBeInTheDocument();
    expect(screen.getByText("Personal best 34 days")).toBeInTheDocument();
  });

  it("leads with the personal best (not a hollow 0) when the current run is broken", () => {
    const standing: UserProfileStanding = {
      streak: { currentDays: 0, bestDays: 12 },
    };
    render(
      <StandingSection isError={false} isLoading={false} standing={standing} />
    );
    // No "0 days" current-streak lead under the flame — the section leads with
    // the true positive signal (best) and states the broken run as support.
    expect(screen.getByText("Personal best")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("No active streak right now")).toBeInTheDocument();
    expect(screen.queryByText("Current streak")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("singularizes the personal-best noun at one day", () => {
    const standing: UserProfileStanding = {
      streak: { currentDays: 1, bestDays: 1 },
    };
    render(
      <StandingSection isError={false} isLoading={false} standing={standing} />
    );
    expect(screen.getByText("day")).toBeInTheDocument();
    expect(screen.getByText("Personal best 1 day")).toBeInTheDocument();
  });

  it("shows an inline error without lying about the data", () => {
    render(
      <StandingSection isError={true} isLoading={false} standing={null} />
    );
    expect(screen.getByText("Couldn't load standing")).toBeInTheDocument();
    // The streak numbers are NOT rendered on the error path.
    expect(screen.queryByText("Current streak")).toBeNull();
  });

  it("stays quiet while the streak read is in flight (no heading it may yank back)", () => {
    const { container } = render(
      <StandingSection isError={false} isLoading={true} standing={null} />
    );
    // Most users have no streak, so the section renders nothing for them; it
    // must not promise a "Standing" heading + skeleton mid-load that then
    // disappears once the query resolves to nothing.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("heading", { name: "Standing" })).toBeNull();
  });
});
