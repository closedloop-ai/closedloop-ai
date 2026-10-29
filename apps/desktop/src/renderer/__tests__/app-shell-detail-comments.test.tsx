import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  installDesktopApi,
  renderDesktopApp,
  setupAppShellSuite,
} from "./app-shell-harness";

vi.mock("../components/UpdateBanner", () => ({ UpdateBanner: () => null }));

describe("session comments through the Desktop shell", () => {
  setupAppShellSuite();
  it("reopens the real comments pane from the Topbar", async () => {
    installDesktopApi({
      assignmentFlags: { [ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY]: true },
    });
    renderDesktopApp("#/sessions/s-active?tab=sessions");
    const pane = await screen.findByRole("complementary", { name: "Comments" });
    fireEvent.click(
      within(pane).getByRole("button", { name: "Close comments" })
    );
    const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
    const header = breadcrumb.closest("header");
    expect(header).not.toBeNull();
    fireEvent.click(
      await within(header!).findByRole("button", { name: "Show comments rail" })
    );
    expect(
      await screen.findByRole("complementary", { name: "Comments" })
    ).toBeDefined();
  });
});
