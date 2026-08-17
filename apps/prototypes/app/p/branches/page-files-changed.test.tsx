// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import BranchesPrototypePage from "./page";

const FILE_FIXTURES = [
  ["agent/synthetic-seed-generator", "1 file"],
  ["agent/inbox-realtime-v2", "1 verified file"],
  ["agent/repo-overrides-workspace-config", "1 file shown*"],
  ["agent/design-system-dark-mode", "1 of 1 file shown*"],
  ["agent/files-empty-fixture", "0 files"],
  ["agent/skill-registry-loader", "2 of 3 files shown*"],
] as const;
const AWAITING_SYNC_BRANCH =
  /Syncing branch data.*agent\/embeddings-store-reindex/;

vi.mock("./components/app-shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

describe("Branches Files changed fixture routing", () => {
  it.each(
    FILE_FIXTURES
  )("selects %s and renders %s through the real detail path", (branchName, expectedLabel) => {
    render(<BranchesPrototypePage />);

    fireEvent.click(findBranchButton(branchName));

    const region = screen.getByRole("region", { name: "Files changed" });
    expect(region.textContent).toContain(expectedLabel);
  });

  it("keeps the awaiting-sync state truthful after branch selection", () => {
    render(<BranchesPrototypePage />);

    fireEvent.click(
      screen.getByRole("button", {
        name: AWAITING_SYNC_BRANCH,
      })
    );

    expect(screen.getByText("Branch sync in progress")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Files changed" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Branch details" })).toBeNull();
  });
});

function findBranchButton(branchName: string): HTMLElement {
  for (let page = 0; page < 3; page += 1) {
    const button = screen.queryByRole("button", { name: branchName });
    if (button) {
      return button;
    }
    const nextPage = screen.queryByLabelText("Go to next page");
    if (!nextPage) {
      break;
    }
    fireEvent.click(nextPage);
  }
  throw new Error(`Branch button not found: ${branchName}`);
}
