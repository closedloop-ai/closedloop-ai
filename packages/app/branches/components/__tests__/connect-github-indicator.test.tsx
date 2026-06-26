import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectGitHubIndicator } from "../connect-github-indicator";

const EXPLANATION_RE = /light up this metric/i;
const CONNECT_GITHUB_RE = /connect github/i;

describe("ConnectGitHubIndicator", () => {
  it("renders the connect explanation with no GitHub/data dependency", () => {
    render(<ConnectGitHubIndicator />);
    expect(screen.getByText(EXPLANATION_RE)).toBeInTheDocument();
  });

  it("renders no CTA button when onConnect is absent (informational only)", () => {
    render(<ConnectGitHubIndicator />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("fires onConnect when the CTA button is clicked", () => {
    const onConnect = vi.fn();
    render(<ConnectGitHubIndicator onConnect={onConnect} />);

    fireEvent.click(screen.getByRole("button", { name: CONNECT_GITHUB_RE }));

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("toggles layout between stacked (default) and compact", () => {
    const { container, rerender } = render(<ConnectGitHubIndicator />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "flex-col"
    );

    rerender(<ConnectGitHubIndicator compact />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "flex-row"
    );
  });
});
