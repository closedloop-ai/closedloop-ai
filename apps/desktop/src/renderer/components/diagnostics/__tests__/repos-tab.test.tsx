import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DiagnosticsRepoRow } from "../../../../shared/diagnostics-contract";
import { ReposTab } from "../repos-tab";

function repoRow(
  overrides: Partial<DiagnosticsRepoRow> = {}
): DiagnosticsRepoRow {
  return {
    id: "repo-1",
    gitDir: "repos/example-repo",
    remoteUrl: "git@github.com:closedloop-ai/example-repo.git",
    repoFullName: "closedloop-ai/example-repo",
    defaultBranch: "main",
    lastSeenAt: "2026-07-29T10:00:00.000Z",
    worktreeCount: 3,
    ...overrides,
  };
}

describe("ReposTab", () => {
  it("shows an empty state and no count badge when no repos are discovered", () => {
    render(<ReposTab repos={[]} />);

    expect(screen.getByText("No repos discovered")).toBeDefined();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("renders a row per repo with its full name, branch, and worktree count", () => {
    render(<ReposTab repos={[repoRow()]} />);

    expect(screen.getByText("closedloop-ai/example-repo")).toBeDefined();
    expect(screen.getByText("main")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("2026-07-29T10:00:00.000Z")).toBeDefined();
  });

  it("falls back to the remote URL when repoFullName is unset, and em-dash when both are unset", () => {
    render(
      <ReposTab
        repos={[
          repoRow({
            id: "repo-2",
            repoFullName: null,
            remoteUrl: "git@github.com:closedloop-ai/other.git",
          }),
          repoRow({
            id: "repo-3",
            repoFullName: null,
            remoteUrl: null,
            defaultBranch: "develop",
          }),
        ]}
      />
    );

    expect(
      screen.getByText("git@github.com:closedloop-ai/other.git")
    ).toBeDefined();

    // Scope the em-dash to the repo-name cell specifically: repo-3 keeps a
    // real defaultBranch, so a stray em-dash elsewhere (e.g. a null branch)
    // can't satisfy this assertion in place of the repo-name fallback.
    const repo3Row = screen.getByText("develop").closest("tr");
    if (!repo3Row) {
      throw new Error("Expected a <tr> ancestor for the repo-3 row");
    }
    const nameCell = within(repo3Row).getAllByRole("cell")[0];
    expect(nameCell.textContent).toBe("—");
  });

  it("shows the repo count badge once repos exist", () => {
    render(<ReposTab repos={[repoRow(), repoRow({ id: "repo-2" })]} />);
    expect(screen.getByText("2")).toBeDefined();
  });
});
