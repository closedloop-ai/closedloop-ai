import { render, screen } from "@testing-library/react";
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

    const headings = screen.getAllByRole("heading");
    const requiredHeading = headings.find((h) =>
      h.textContent?.toLowerCase().includes("required")
    );
    const optionalHeading = headings.find((h) =>
      h.textContent?.toLowerCase().includes("optional")
    );

    expect(requiredHeading).toBeDefined();
    expect(optionalHeading).toBeDefined();

    // required checks must be present in the document
    expect(screen.getByText("Git")).toBeInTheDocument();
    expect(screen.getByText("python3")).toBeInTheDocument();
    // optional checks must be present in the document
    expect(screen.getByText("Codex CLI")).toBeInTheDocument();
    expect(screen.getByText("Optional Tool")).toBeInTheDocument();
  });

  test("required check (python3 required:true) renders under Required section", () => {
    const { container } = render(
      <SystemCheckResults checks={[requiredFailed, optionalPassed]} />
    );

    // The component renders two sibling <div> blocks inside the root, each
    // containing an <h4> followed by a <div> of check rows.
    // Find each section wrapper as the direct parent of the <h4>.
    const h4s = container.querySelectorAll("h4");
    const requiredH4 = Array.from(h4s).find((el) =>
      el.textContent?.toLowerCase().includes("required")
    );
    const optionalH4 = Array.from(h4s).find((el) =>
      el.textContent?.toLowerCase().includes("optional")
    );

    expect(requiredH4).toBeDefined();
    expect(optionalH4).toBeDefined();

    // Each h4's direct parent is the section container div.
    const requiredSection = requiredH4!.parentElement;
    const optionalSection = optionalH4!.parentElement;

    expect(requiredSection?.textContent).toContain("python3");
    expect(requiredSection?.textContent).not.toContain("Codex CLI");

    expect(optionalSection?.textContent).toContain("Codex CLI");
    expect(optionalSection?.textContent).not.toContain("python3");
  });

  test("optional check does not appear under Required heading", () => {
    render(<SystemCheckResults checks={[requiredPassed, optionalFailed]} />);

    // All labels render somewhere
    expect(screen.getByText("Git")).toBeInTheDocument();
    expect(screen.getByText("Optional Tool")).toBeInTheDocument();
  });
});
