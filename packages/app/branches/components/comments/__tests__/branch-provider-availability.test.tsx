import { BranchCommentsState } from "@repo/api/src/types/branch";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BranchProviderAvailability } from "../branch-provider-availability";

const STALE_TEXT = /stale/i;

describe("BranchProviderAvailability", () => {
  it("renders simultaneous stale, mixed, capped, omitted, and shortened states", () => {
    render(
      <BranchProviderAvailability
        availability={{
          bodyTruncatedCount: 2,
          mixedProjection: true,
          omittedComments: 3,
          providerTruncated: true,
          responseTruncated: true,
          stale: true,
          state: BranchCommentsState.StaleMixed,
        }}
      />
    );

    expect(
      screen.getByText("GitHub comments may be stale.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "GitHub comments combine evidence collected at different times."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("GitHub capped the available provider result.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("ClosedLoop capped the displayed provider response.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "3 GitHub comments are omitted from this bounded result."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 GitHub comment bodies are shortened.")
    ).toBeInTheDocument();
  });

  it("uses singular count copy and omits absent facts", () => {
    render(
      <BranchProviderAvailability
        availability={{
          bodyTruncatedCount: 1,
          mixedProjection: false,
          omittedComments: 1,
          providerTruncated: false,
          responseTruncated: false,
          stale: false,
          state: BranchCommentsState.Populated,
        }}
      />
    );

    expect(
      screen.getByText("1 GitHub comment is omitted from this bounded result.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("1 GitHub comment body is shortened.")
    ).toBeInTheDocument();
    expect(screen.queryByText(STALE_TEXT)).not.toBeInTheDocument();
  });

  it("honors stale state and uses neutral copy when cap cause is absent", () => {
    const { rerender } = render(
      <BranchProviderAvailability
        availability={{
          bodyTruncatedCount: 0,
          mixedProjection: false,
          omittedComments: 0,
          providerTruncated: false,
          responseTruncated: false,
          stale: false,
          state: BranchCommentsState.StaleMixed,
        }}
      />
    );

    expect(
      screen.getByText("GitHub comments may be stale.")
    ).toBeInTheDocument();

    rerender(
      <BranchProviderAvailability
        availability={{
          bodyTruncatedCount: 0,
          mixedProjection: false,
          omittedComments: 0,
          providerTruncated: false,
          responseTruncated: false,
          stale: false,
          state: BranchCommentsState.OverLimitTruncated,
        }}
      />
    );

    expect(
      screen.getByText("Provider comment coverage is truncated.")
    ).toBeInTheDocument();
  });

  it("attributes provider and response caps independently", () => {
    const { rerender } = render(
      <BranchProviderAvailability
        availability={{
          bodyTruncatedCount: 0,
          mixedProjection: false,
          omittedComments: 0,
          providerTruncated: true,
          responseTruncated: false,
          stale: false,
          state: BranchCommentsState.OverLimitTruncated,
        }}
      />
    );

    expect(
      screen.getByText("GitHub capped the available provider result.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("ClosedLoop capped the displayed provider response.")
    ).not.toBeInTheDocument();

    rerender(
      <BranchProviderAvailability
        availability={{
          bodyTruncatedCount: 0,
          mixedProjection: false,
          omittedComments: 0,
          providerTruncated: false,
          responseTruncated: true,
          stale: false,
          state: BranchCommentsState.OverLimitTruncated,
        }}
      />
    );

    expect(
      screen.queryByText("GitHub capped the available provider result.")
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("ClosedLoop capped the displayed provider response.")
    ).toBeInTheDocument();
  });
});
