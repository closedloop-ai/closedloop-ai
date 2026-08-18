import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { SESSION_REPOSITORY_UNKNOWN_LABEL } from "@repo/app/agents/lib/session-repository-label";
import {
  agentSessionToSessionTableRow,
  resolveSessionRepoLabel,
} from "@repo/app/agents/lib/session-table-row";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { buildSessionDetailContent } from "../detail-content";
import { withProviders } from "./agent-session-detail-view.test-helpers";

const UNRESOLVED_REMOTE_CWD = "/Users/dev/Code/3";
const FILESYSTEM_ROOT_CWD = "/";
const RESOLVED_REMOTE = "closedloop-ai/symphony-alpha";

function renderDetail(session: AgentSessionDetail) {
  return render(
    withProviders(
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    )
  );
}

/** The expanded Properties panel's Repository row. Open the panel first. */
function repositoryPropertyRow(): HTMLElement {
  const row = Array.from(document.querySelectorAll(".prd-prop")).find(
    (candidate) => candidate.textContent?.startsWith("Repository")
  );
  if (!row) {
    throw new Error("Repository row missing from the Properties panel");
  }
  return row as HTMLElement;
}

/** The collapsed Properties preview — the default, always-visible surface. */
function propertiesPreviewText(): string {
  return document.querySelector(".sd3-props-preview")?.textContent ?? "";
}

/**
 * How the Properties panel's Repository row is *styled* — a resolved remote is
 * a mono value, an unresolved one is muted body text (FEA-3780), matching the
 * Sessions list's empty repo cell.
 */
function repositoryPropertyStyling(): { mono: boolean; muted: boolean } {
  const row = repositoryPropertyRow();
  return {
    mono: row.querySelector(".mono") !== null,
    muted: row.querySelector(".text-muted-foreground") !== null,
  };
}

/** The Repository entry of the detail content's metadata list. */
function metadataRepositoryValue(session: AgentSessionDetail): string {
  const entry = buildSessionDetailContent(session).metadata.find(
    (item) => item.label === "Repository"
  );
  if (!entry) {
    throw new Error("Repository entry missing from detail metadata");
  }
  return entry.value;
}

describe("FEA-3780: session detail never presents a directory as the repository", () => {
  it("renders Unknown — not the cwd — when no Git remote resolved", async () => {
    const user = userEvent.setup();
    renderDetail(
      createAgentSessionDetailFixture({
        cwd: UNRESOLVED_REMOTE_CWD,
        repositoryFullName: null,
        repo: null,
        worktreePath: null,
      })
    );

    // The defect surfaced on the collapsed preview before any interaction.
    expect(propertiesPreviewText()).toContain(SESSION_REPOSITORY_UNKNOWN_LABEL);
    expect(propertiesPreviewText()).not.toContain(UNRESOLVED_REMOTE_CWD);

    await user.click(screen.getByRole("button", { name: "Properties" }));

    expect(repositoryPropertyRow()).toHaveTextContent(
      `Repository${SESSION_REPOSITORY_UNKNOWN_LABEL}`
    );
    expect(screen.queryByText(UNRESOLVED_REMOTE_CWD)).not.toBeInTheDocument();

    // Absent data must not render like a value sitting next to real repo names.
    expect(repositoryPropertyStyling()).toEqual({ mono: false, muted: true });
    // The preview chip's tooltip exists to reveal a truncated name; with
    // nothing to reveal it would just repeat the visible word.
    expect(
      document.querySelector(".sd3-props-preview [title]")
    ).not.toBeInTheDocument();
  });

  it("renders Unknown for a session run at the filesystem root", async () => {
    // The originally reported symptom: a bare "/" in the repository field.
    const user = userEvent.setup();
    renderDetail(
      createAgentSessionDetailFixture({
        cwd: FILESYSTEM_ROOT_CWD,
        repositoryFullName: null,
        repo: null,
        worktreePath: null,
      })
    );

    expect(propertiesPreviewText()).toContain(SESSION_REPOSITORY_UNKNOWN_LABEL);

    await user.click(screen.getByRole("button", { name: "Properties" }));

    expect(repositoryPropertyRow()).toHaveTextContent(
      `Repository${SESSION_REPOSITORY_UNKNOWN_LABEL}`
    );
  });

  it("renders Unknown for a degenerate stored repository value", async () => {
    const user = userEvent.setup();
    renderDetail(
      createAgentSessionDetailFixture({
        cwd: UNRESOLVED_REMOTE_CWD,
        repositoryFullName: FILESYSTEM_ROOT_CWD,
        repo: FILESYSTEM_ROOT_CWD,
      })
    );

    await user.click(screen.getByRole("button", { name: "Properties" }));

    expect(repositoryPropertyRow()).toHaveTextContent(
      `Repository${SESSION_REPOSITORY_UNKNOWN_LABEL}`
    );
  });

  it("still renders a resolved remote", async () => {
    const user = userEvent.setup();
    renderDetail(
      createAgentSessionDetailFixture({
        cwd: UNRESOLVED_REMOTE_CWD,
        repositoryFullName: RESOLVED_REMOTE,
        repo: RESOLVED_REMOTE,
      })
    );

    expect(propertiesPreviewText()).toContain(RESOLVED_REMOTE);
    // A real name keeps its reveal-on-truncation tooltip.
    expect(
      document.querySelector(`.sd3-props-preview [title="${RESOLVED_REMOTE}"]`)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Properties" }));

    expect(repositoryPropertyRow()).toHaveTextContent(
      `Repository${RESOLVED_REMOTE}`
    );
    expect(repositoryPropertyStyling()).toEqual({ mono: true, muted: false });
  });
});

describe("FEA-3780: list and detail describe the same session identically", () => {
  it.each([
    ["an unresolved remote", UNRESOLVED_REMOTE_CWD],
    ["the filesystem root", FILESYSTEM_ROOT_CWD],
  ])("agree on Unknown for a session with %s", (_label, cwd) => {
    const session = createAgentSessionDetailFixture({
      cwd,
      repositoryFullName: null,
      repo: null,
      worktreePath: null,
    });

    // The list resolves `null` and its cell renders the shared Unknown label;
    // the detail surfaces render that label directly. Both must agree, and
    // neither may fall back to the directory.
    const listLabel = resolveSessionRepoLabel(session);
    expect(listLabel).toBe(null);
    expect(agentSessionToSessionTableRow(session, listLabel).repo).toBe(null);
    expect(metadataRepositoryValue(session)).toBe(
      SESSION_REPOSITORY_UNKNOWN_LABEL
    );
  });

  it("agree on the resolved remote", () => {
    const session = createAgentSessionDetailFixture({
      cwd: UNRESOLVED_REMOTE_CWD,
      repositoryFullName: RESOLVED_REMOTE,
      repo: RESOLVED_REMOTE,
    });

    const listLabel = resolveSessionRepoLabel(session);
    expect(listLabel).toBe(RESOLVED_REMOTE);
    expect(metadataRepositoryValue(session)).toBe(listLabel);
  });

  it("agree on Unknown for a degenerate stored repository value", () => {
    const session = createAgentSessionDetailFixture({
      cwd: UNRESOLVED_REMOTE_CWD,
      repositoryFullName: FILESYSTEM_ROOT_CWD,
      repo: FILESYSTEM_ROOT_CWD,
    });

    expect(resolveSessionRepoLabel(session)).toBe(null);
    expect(metadataRepositoryValue(session)).toBe(
      SESSION_REPOSITORY_UNKNOWN_LABEL
    );
  });
});
