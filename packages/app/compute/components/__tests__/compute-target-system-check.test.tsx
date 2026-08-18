import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComputeTargetSystemCheck } from "../compute-target-system-check";

/**
 * ISS-5687. The badge is told how many rows failed; it was told the wrong
 * number. These pin the two ways the summary can lie once optional rows stop
 * counting as failures: calling a warning a failure, and rounding a warning
 * away into "All checks passed".
 */
describe("ComputeTargetSystemCheck summary", () => {
  it("reports unconfigured optional rows as warnings, not failures", () => {
    render(
      <ComputeTargetSystemCheck
        failureCount={0}
        hasResult={true}
        isEligible={true}
        isLoading={false}
        warningCount={2}
      />
    );

    expect(screen.getByText("2 warnings")).toBeInTheDocument();
    expect(screen.queryByText("2 failures")).toBeNull();
  });

  it("does not claim all checks passed while a warning stands", () => {
    render(
      <ComputeTargetSystemCheck
        failureCount={0}
        hasResult={true}
        isEligible={true}
        isLoading={false}
        warningCount={1}
      />
    );

    expect(screen.queryByText("All checks passed")).toBeNull();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
  });

  it("names both when a failure and a warning stand together", () => {
    render(
      <ComputeTargetSystemCheck
        failureCount={2}
        hasResult={true}
        isEligible={true}
        isLoading={false}
        warningCount={1}
      />
    );

    expect(screen.getByText("2 failures, 1 warning")).toBeInTheDocument();
  });

  it("reports failures alone when there are no warnings", () => {
    render(
      <ComputeTargetSystemCheck
        failureCount={1}
        hasResult={true}
        isEligible={true}
        isLoading={false}
        warningCount={0}
      />
    );

    expect(screen.getByText("1 failure")).toBeInTheDocument();
  });

  it("reports a clean result as all checks passed", () => {
    render(
      <ComputeTargetSystemCheck
        failureCount={0}
        hasResult={true}
        isEligible={true}
        isLoading={false}
        warningCount={0}
      />
    );

    expect(screen.getByText("All checks passed")).toBeInTheDocument();
  });
});
