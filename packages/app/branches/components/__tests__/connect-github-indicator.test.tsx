import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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

  it("renders a native link CTA when connectHref is provided", () => {
    renderWithNavigation(
      <ConnectGitHubIndicator connectHref="/api/integrations/github" />
    );

    expect(
      screen.getByRole("link", { name: CONNECT_GITHUB_RE })
    ).toHaveAttribute("href", "/api/integrations/github");
  });

  it("prefers connectHref over onConnect when both are provided", () => {
    const onConnect = vi.fn();
    renderWithNavigation(
      <ConnectGitHubIndicator
        connectHref="/api/integrations/github"
        onConnect={onConnect}
      />
    );

    fireEvent.click(screen.getByRole("link", { name: CONNECT_GITHUB_RE }));

    expect(onConnect).not.toHaveBeenCalled();
  });

  it("keeps compact layout narrow-card friendly", () => {
    const { container, rerender } = render(<ConnectGitHubIndicator />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "flex-col"
    );

    rerender(<ConnectGitHubIndicator compact />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "items-start"
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "text-left"
    );
  });
});

function renderWithNavigation(children: ReactNode) {
  const memory = createMemoryNavigation();
  return render(
    <NavigationProvider adapter={memory.adapter}>{children}</NavigationProvider>
  );
}
