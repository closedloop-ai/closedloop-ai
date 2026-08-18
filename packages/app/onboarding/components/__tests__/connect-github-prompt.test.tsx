import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectGitHubPrompt } from "../connect-github-prompt";

const CONNECT_BUTTON = /continue with github/i;
const HEADING = /connect github to finish setup/i;
const GRANT_LABEL = /you'll grant access to/i;
const CUSTOM_GRANT = /only the api repo/i;
// Unique to the grants list. "you can already reach" also appears in the body
// copy, so it matches twice and cannot identify the list.
const DEFAULT_GRANT_SAMPLE = /read your organizations/i;

/**
 * Two claims this component has made and must never make again, because the
 * wired flow supports neither. Both are asserted against RENDERED output, so
 * reintroducing either anywhere in the component fails here.
 *
 * 1. "more secure than a broad token" — inverts the credential model this repo
 *    deploys (PLN-1525), where the broad OAuth scope carried by Clerk's GitHub
 *    sign-in is the PRIMARY credential.
 * 2. The install framing — needing org admin rights, and picking repositories.
 *    Both consumers wire this to `useDesktopGitHubConnect` with no
 *    `resolveInstall`, and `GITHUB_APP_CLIENT_ID` is required, so the route
 *    sends the user to `login/oauth/authorize`: a per-user grant with no admin
 *    requirement and no repository picker.
 */
const FORBIDDEN_CLAIMS = [
  /more secure than a broad token/i,
  /needs github admin rights/i,
  /repositories you pick/i,
  /install the closedloop github app/i,
];

describe("ConnectGitHubPrompt", () => {
  it("renders the required grant with the listed access items", () => {
    render(<ConnectGitHubPrompt onConnect={vi.fn()} />);
    expect(screen.getByRole("heading", { name: HEADING })).toBeInTheDocument();
    expect(screen.getByText(GRANT_LABEL)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: CONNECT_BUTTON })
    ).toBeInTheDocument();
  });

  it("calls onConnect when the button is clicked", () => {
    const onConnect = vi.fn();
    render(<ConnectGitHubPrompt onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: CONNECT_BUTTON }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("disables the button while connecting", () => {
    render(<ConnectGitHubPrompt connecting onConnect={vi.fn()} />);
    expect(screen.getByRole("button", { name: CONNECT_BUTTON })).toBeDisabled();
  });

  it("renders caller-supplied grants", () => {
    render(
      <ConnectGitHubPrompt grants={["Only the api repo"]} onConnect={vi.fn()} />
    );
    expect(screen.getByText(CUSTOM_GRANT)).toBeInTheDocument();
  });

  it("renders the default grants when none are supplied", () => {
    render(<ConnectGitHubPrompt onConnect={vi.fn()} />);
    expect(screen.getByText(DEFAULT_GRANT_SAMPLE)).toBeInTheDocument();
  });

  // PRD-562 rule 1: a CTA promises exactly what its grant enables, no more.
  it.each(
    FORBIDDEN_CLAIMS
  )("never renders the unsupported claim %s", (claim) => {
    const { container } = render(<ConnectGitHubPrompt onConnect={vi.fn()} />);
    expect(container.textContent).not.toMatch(claim);
  });
});
