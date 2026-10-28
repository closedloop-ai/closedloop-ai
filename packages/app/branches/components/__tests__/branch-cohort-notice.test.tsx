import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  BranchCohortNoticeKind,
  type BranchCohortNoticeModel,
} from "../../lib/branch-cohort-transparency";
import { BranchCohortNotice } from "../branch-cohort-notice";

describe("BranchCohortNotice", () => {
  it("stays absent while the shared flag is off", () => {
    renderNotice([]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not render the unapproved complete retained-cohort banner", () => {
    renderNotice([BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY]);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("21 Branches in Last 7 days")).toBeNull();
  });

  it("keeps the approved updating notice while a finite range is loading", () => {
    renderNotice([BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY], {
      kind: BranchCohortNoticeKind.Updating,
      total: 21,
    });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Updating Branches for Last 7 days");
    expect(status).toHaveTextContent(
      "Results from the previous range remain visible until the new range is ready."
    );
  });

  it.each([
    {
      label: "complete",
      model: {
        kind: BranchCohortNoticeKind.Complete,
        total: 209,
        knownInWindow: 207,
        retainedUnavailable: 2,
      },
      title: "209 Branches in Last 7 days",
    },
    {
      label: "partial",
      model: {
        kind: BranchCohortNoticeKind.Partial,
        total: 209,
        retainedUnavailable: 2,
      },
      title: "Last active breakdown is incomplete for Last 7 days",
    },
    {
      label: "unavailable",
      model: {
        kind: BranchCohortNoticeKind.Unavailable,
        total: 209,
      },
      title: "Last active breakdown is unavailable for Last 7 days",
    },
  ] as const)(
    "does not render the unapproved $label Last-active banner",
    ({ model, title }) => {
      renderNotice([BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY], model);

      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByText(title)).toBeNull();
    }
  );
});

function renderNotice(
  enabledFlags: readonly string[],
  model: BranchCohortNoticeModel = {
    kind: BranchCohortNoticeKind.Complete,
    total: 21,
    knownInWindow: 19,
    retainedUnavailable: 2,
  }
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <BranchCohortNotice model={model} rangeLabel="Last 7 days" />
    </FeatureFlagAdapterProvider>
  );
}
