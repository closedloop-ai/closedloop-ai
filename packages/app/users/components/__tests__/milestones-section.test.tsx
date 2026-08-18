import {
  MilestoneKind,
  type UserProfileMilestones,
} from "@repo/api/src/types/user";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MilestonesSection } from "../milestones-section";

// FEA-4108: the Milestones section renders only real earned milestones and hides
// entirely (no fake empty state) when the user has earned none.

describe("MilestonesSection (FEA-4108)", () => {
  it("hides the whole section when there are no earned milestones", () => {
    const { container } = render(
      <MilestonesSection
        isError={false}
        isLoading={false}
        milestones={{ milestones: [] }}
      />
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Milestones")).toBeNull();
  });

  it("hides the whole section when milestones are unavailable", () => {
    const { container } = render(
      <MilestonesSection isError={false} isLoading={false} milestones={null} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("stays quiet while the read is in flight (no card it may yank back)", () => {
    const { container } = render(
      <MilestonesSection isError={false} isLoading={true} milestones={null} />
    );
    // Most users have earned no milestone, so the section renders nothing for
    // them; it must not promise an "Achievements" card + skeleton mid-load that
    // then disappears once the query resolves to nothing.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("heading", { name: "Milestones" })).toBeNull();
  });

  it("renders a row per earned milestone with a derived title", () => {
    const milestones: UserProfileMilestones = {
      milestones: [
        {
          kind: MilestoneKind.PrsLanded,
          threshold: 500,
          earnedAt: new Date("2026-06-15T00:00:00.000Z"),
        },
        {
          kind: MilestoneKind.TokensUsed,
          threshold: 1_000_000_000,
          earnedAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ],
    };
    render(
      <MilestonesSection
        isError={false}
        isLoading={false}
        milestones={milestones}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Milestones" })
    ).toBeInTheDocument();
    // Titles derive from kind + threshold via the canonical display map.
    expect(screen.getByText("500 PRs landed")).toBeInTheDocument();
    expect(screen.getByText("1.00B tokens")).toBeInTheDocument();
    // Lifetime detail line is read from the canonical map, not the payload.
    expect(
      screen.getByText("Lifetime merged pull requests")
    ).toBeInTheDocument();
  });

  it("shows an inline error without rendering fake milestones", () => {
    render(
      <MilestonesSection isError={true} isLoading={false} milestones={null} />
    );
    expect(screen.getByText("Couldn't load milestones")).toBeInTheDocument();
    // The achievements list is not rendered on the error path.
    expect(screen.queryByText("Achievements")).toBeNull();
    expect(screen.queryByText("500 PRs landed")).toBeNull();
  });
});
