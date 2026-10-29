import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectList } from "../project-list";

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

afterEach(cleanup);

function mount(enabledFlags: readonly string[]) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <ProjectList rows={[]} />
    </FeatureFlagAdapterProvider>
  );
}

describe("ProjectList toolbar is gated by projects-portable-surface", () => {
  it.each([
    ["no flag", []],
    ["gridview-adoption only", [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]],
  ])("PPS-LIST-1 renders no search box with %s", (_name, enabledFlags) => {
    mount(enabledFlags);
    expect(screen.queryByRole("textbox", { name: "Filter items" })).toBeNull();
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("radiogroup", { name: "Project layout" }).length
    ).toBeGreaterThan(0);
  });

  it("PPS-LIST-2 renders the search box with projects-portable-surface on and gridview-adoption off", () => {
    mount([PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY]);
    expect(
      screen.getByRole("textbox", { name: "Filter items" })
    ).toBeInTheDocument();
  });
});
