import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_TAB_VALUES,
  type ProjectTab,
  ProjectTabsToggle,
  projectTabLabel,
} from "../project-tabs-toggle";

afterEach(cleanup);

function Harness() {
  const [tab, setTab] = useState<ProjectTab>("all");
  return <ProjectTabsToggle activeTab={tab} onTabChange={setTab} />;
}

describe("ProjectTabsToggle (ISS-13007)", () => {
  it("offers every tab in the legacy order under the legacy group name", () => {
    render(<Harness />);
    const group = screen.getByRole("radiogroup", {
      name: "Filter by artifact type",
    });
    expect(
      Array.from(group.querySelectorAll("button")).map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(PROJECT_TAB_VALUES.map((tab) => projectTabLabel(tab)));
    expect(PROJECT_TAB_VALUES[0]).toBe("overview");
  });

  it("switches the active tab when another is chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(
      screen.getByRole("radio", { name: projectTabLabel("all") })
    ).toBeChecked();

    await user.click(
      screen.getByRole("radio", { name: projectTabLabel("issues") })
    );

    expect(
      screen.getByRole("radio", { name: projectTabLabel("issues") })
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: projectTabLabel("all") })
    ).not.toBeChecked();
  });
});
