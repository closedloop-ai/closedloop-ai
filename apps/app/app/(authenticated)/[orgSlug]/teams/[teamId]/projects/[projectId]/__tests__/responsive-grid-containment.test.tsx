import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectArtifactsRegion } from "../components/project-artifacts-region";

describe("[DT-15] project artifact grid containment", () => {
  it("preserves captured-main intrinsic width while the rollout is closed", () => {
    renderProjectArtifacts([]);

    const containment = screen.getByTestId("documents-view").parentElement;
    expect(containment).toHaveClass("mt-0", "min-w-fit");
    expect(containment).not.toHaveClass("min-w-0");
  });

  it("allows the artifact region to shrink to phone width when enabled", () => {
    renderProjectArtifacts([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]);

    const containment = screen.getByTestId("documents-view").parentElement;
    expect(containment).toHaveClass("mt-0", "min-w-0");
    expect(containment).not.toHaveClass("min-w-fit");
  });
});

function renderProjectArtifacts(enabledFlags: string[]) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <ProjectArtifactsRegion hasReadFailed={false} onRetry={() => undefined}>
        <div data-testid="documents-view" />
      </ProjectArtifactsRegion>
    </FeatureFlagAdapterProvider>
  );
}
