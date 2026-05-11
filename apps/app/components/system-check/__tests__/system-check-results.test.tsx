import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { CheckResult } from "@/lib/engineer/queries/health-check";
import { SystemCheckResults } from "../system-check-results";

const requiredPassed: CheckResult = {
  id: "git",
  label: "Git",
  required: true,
  passed: true,
  version: "2.40.0",
};

const requiredFailed: CheckResult = {
  id: "python3",
  label: "python3",
  required: true,
  passed: false,
  error: "Python 3.9.7 is below the required minimum of 3.10",
  remediation: "Install Python 3.10 or later: brew install python@3.13",
};

const optionalPassed: CheckResult = {
  id: "codex",
  label: "Codex CLI",
  required: false,
  passed: true,
  version: "1.0.0",
};

const optionalFailed: CheckResult = {
  id: "optional-tool",
  label: "Optional Tool",
  required: false,
  passed: false,
  error: "Not found",
};

function getSectionByHeading(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  const section = heading.closest("section");
  if (!section) {
    throw new Error(`Section "${name}" was not found`);
  }
  return section;
}

function getCategoryCard(section: HTMLElement, name: string): HTMLElement {
  const heading = within(section).getByRole("heading", { name });
  const card = heading.closest("section");
  if (!card) {
    throw new Error(`Category card "${name}" was not found`);
  }
  return card;
}

describe("SystemCheckResults — required/optional partition", () => {
  test("required checks appear under Required heading, not under Optional", () => {
    render(
      <SystemCheckResults
        checks={[
          requiredPassed,
          requiredFailed,
          optionalPassed,
          optionalFailed,
        ]}
      />
    );

    const requiredSection = getSectionByHeading("Required");
    const optionalSection = getSectionByHeading("Optional");

    expect(within(requiredSection).getByText("Git")).toBeInTheDocument();
    expect(within(requiredSection).getByText("python3")).toBeInTheDocument();
    expect(within(optionalSection).getByText("Codex CLI")).toBeInTheDocument();
    expect(
      within(optionalSection).getByText("Optional Tool")
    ).toBeInTheDocument();
  });

  test("required check (python3 required:true) renders under Required section", () => {
    render(<SystemCheckResults checks={[requiredFailed, optionalPassed]} />);

    const requiredSection = getSectionByHeading("Required");
    const optionalSection = getSectionByHeading("Optional");

    expect(requiredSection.textContent).toContain("python3");
    expect(requiredSection.textContent).not.toContain("Codex CLI");

    expect(optionalSection.textContent).toContain("Codex CLI");
    expect(optionalSection.textContent).not.toContain("python3");
  });

  test("applies presentation row animation classes", () => {
    render(<SystemCheckResults checks={[requiredPassed]} />);

    const row = screen.getByText("Git").closest("div")?.parentElement;

    expect(row).not.toBeNull();
    expect(row).toHaveClass("animate-in");
    expect(row).toHaveClass("slide-in-from-left-3");
  });

  test("optional check does not appear under Required heading", () => {
    render(<SystemCheckResults checks={[requiredPassed, optionalFailed]} />);

    const requiredSection = getSectionByHeading("Required");
    const optionalSection = getSectionByHeading("Optional");

    expect(within(requiredSection).getByText("Git")).toBeInTheDocument();
    expect(requiredSection.textContent).not.toContain("Optional Tool");
    expect(
      within(optionalSection).getByText("Optional Tool")
    ).toBeInTheDocument();
  });

  test("failed rows display remediation even when the error field is absent", () => {
    render(
      <SystemCheckResults
        checks={[
          {
            id: "worktree-dir",
            label: "Worktree Directory",
            required: true,
            passed: false,
            remediation: "Choose a writable worktree directory.",
          },
        ]}
      />
    );

    expect(screen.getByText("Worktree Directory")).toBeInTheDocument();
    expect(
      screen.getByText("Choose a writable worktree directory.")
    ).toBeInTheDocument();
  });

  test("organizes system checks into category cards inside a four-column grid", () => {
    render(
      <SystemCheckResults
        checks={[
          requiredPassed,
          {
            id: "plugin-code",
            label: "ClosedLoop Plugin",
            required: true,
            passed: true,
          },
          {
            id: "app-version",
            label: "Gateway Version",
            required: true,
            passed: true,
            version: "0.14.10",
          },
          {
            id: "claude-mcp",
            label: "Claude MCP",
            required: false,
            passed: true,
          },
          optionalPassed,
        ]}
      />
    );

    const requiredSection = getSectionByHeading("Required");
    const optionalSection = getSectionByHeading("Optional");
    const requiredGrid = requiredSection.querySelector(
      '[data-system-check-layout="card-grid"]'
    );

    expect(requiredGrid).not.toBeNull();
    expect(requiredGrid).toHaveClass("@3xl/checks:grid-cols-4");

    expect(getCategoryCard(requiredSection, "CLI").textContent).toContain(
      "Git"
    );
    expect(getCategoryCard(requiredSection, "Plugins").textContent).toContain(
      "ClosedLoop Plugin"
    );
    expect(getCategoryCard(requiredSection, "Apps").textContent).toContain(
      "Gateway Version"
    );
    expect(getCategoryCard(optionalSection, "CLI").textContent).toContain(
      "Codex CLI"
    );
    expect(getCategoryCard(optionalSection, "MCP").textContent).toContain(
      "Claude MCP"
    );
  });

  test("passing advisory rows display their remediation without rendering as failures", () => {
    render(
      <SystemCheckResults
        checks={[
          {
            id: "app-version",
            label: "Gateway Version",
            required: true,
            passed: true,
            version: "0.14.10",
            error: "Update available: 0.14.11",
            remediation: "Open the ClosedLoop Gateway app to update",
          },
        ]}
      />
    );

    expect(screen.getByText("Gateway Version")).toBeInTheDocument();
    expect(screen.getByText("Update available: 0.14.11")).toBeInTheDocument();
    expect(
      screen.getByText("Open the ClosedLoop Gateway app to update")
    ).toBeInTheDocument();
  });

  test("long check values stay truncated and expose the full value to tooltips", () => {
    const worktreePath =
      "/Users/daniel.ochoa/Source/closedloop-electron/packages/really-long-worktree-parent-directory";

    render(
      <SystemCheckResults
        checks={[
          {
            id: "worktree-dir",
            label: "Worktree Directory",
            required: true,
            passed: true,
            version: worktreePath,
          },
        ]}
      />
    );

    const value = screen.getByText(worktreePath);

    expect(value).not.toHaveAttribute("type", "button");
    expect(value).not.toHaveAttribute("tabindex");
    expect(value).toHaveTextContent(worktreePath);
    expect(value).toHaveClass("truncate");
  });

  test("renders plugin update metadata and structured remediation links only when enabled", () => {
    const pluginCheck: CheckResult = {
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: false,
      error: "Automatic update was attempted but did not succeed.",
      remediation: "Run claude plugin update code@closedloop-ai --scope user",
      remediationLinks: [
        {
          label: "Enable ClosedLoop plugin autoupdate",
          url: "https://github.com/closedloop-ai/claude-plugins#quick-start",
        },
      ],
      updateAttempted: true,
      updateOutcome: "failed",
      updatePluginIds: ["plugin-code"],
    };

    const { rerender } = render(
      <SystemCheckResults
        checks={[pluginCheck]}
        pluginAutoUpdateEnabled={false}
      />
    );

    expect(screen.queryByText("Update failed")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", {
        name: "Enable ClosedLoop plugin autoupdate",
      })
    ).not.toBeInTheDocument();

    rerender(
      <SystemCheckResults checks={[pluginCheck]} pluginAutoUpdateEnabled />
    );

    expect(screen.getByText("Update failed")).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "Enable ClosedLoop plugin autoupdate",
      })
    ).toHaveAttribute(
      "href",
      "https://github.com/closedloop-ai/claude-plugins#quick-start"
    );
  });

  test("tokenizes legacy remediation https URLs into anchors", () => {
    render(
      <SystemCheckResults
        checks={[
          {
            id: "plugin-code",
            label: "Symphony Plugin",
            required: true,
            passed: false,
            error: "Update failed",
            remediation:
              "See https://github.com/closedloop-ai/claude-plugins#quick-start",
          },
        ]}
      />
    );

    expect(
      screen.getByRole("link", {
        name: "https://github.com/closedloop-ai/claude-plugins#quick-start",
      })
    ).toBeInTheDocument();
  });
});
