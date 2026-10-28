import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitHubConnectAction } from "../../../github/lib/github-connect-action";
import { ConnectGitHubPrompt } from "../connect-github-prompt";

// The button is the same for both variants on purpose: it names the browser
// handoff, not the action. What must differ is the heading above it.
const RECONNECT_BUTTON = /continue with github/i;
const RECONNECT_HEADING =
  /reconnect github to restore your pr and repo activity/i;

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
 *    Both consumers wire this to `useDesktopGitHubConnect`, which since
 *    ISS-5958 can only send a no-install connect to `/connect/github/link`
 *    (PLN-1742 M5): a per-user Clerk grant with no admin requirement and no
 *    repository picker.
 */
const FORBIDDEN_CLAIMS = [
  /more secure than a broad token/i,
  /needs github admin rights/i,
  /repositories you pick/i,
  /install the closedloop github app/i,
];

describe("ConnectGitHubPrompt reconnect variant (ISS-5958 D2)", () => {
  it("words the repair distinctly from a first-time connect", () => {
    const { unmount } = render(
      <ConnectGitHubPrompt
        action={GitHubConnectAction.Reconnect}
        onConnect={vi.fn()}
      />
    );

    // The two controls must not collapse: a user whose grant was revoked is
    // repairing access, and telling them to "finish setup" reads as the app
    // having lost the setup they already did.
    expect(
      screen.getByRole("heading", { name: RECONNECT_HEADING })
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: HEADING })).toBeNull();
    expect(
      screen.getByRole("button", { name: RECONNECT_BUTTON })
    ).toBeInTheDocument();
    unmount();

    render(<ConnectGitHubPrompt onConnect={vi.fn()} />);
    expect(screen.getByRole("heading", { name: HEADING })).toBeInTheDocument();
  });

  it("still runs the same authorize handoff", () => {
    const onConnect = vi.fn();
    render(
      <ConnectGitHubPrompt
        action={GitHubConnectAction.Reconnect}
        onConnect={onConnect}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: RECONNECT_BUTTON }));

    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});

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

  // ISS-10990: a host-reported failure must reach the reader, announced, with
  // the CTA still standing as the retry. The absent case is asserted beside a
  // present CTA so "no alert" cannot be satisfied by a prompt that rendered
  // nothing.
  it("announces a host-reported connect failure beside the retry", () => {
    render(
      <ConnectGitHubPrompt
        error="GitHub connect could not be opened. Try again."
        onConnect={vi.fn()}
      />
    );

    expect(screen.getByRole("alert").textContent).toBe(
      "GitHub connect could not be opened. Try again."
    );
    expect(
      screen.getByRole("button", { name: CONNECT_BUTTON })
    ).toBeInTheDocument();
  });

  it("announces nothing when the host reports no failure", () => {
    render(<ConnectGitHubPrompt error={null} onConnect={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: CONNECT_BUTTON })
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // PRD-562 rule 1: a CTA promises exactly what its grant enables, no more.
  it.each(FORBIDDEN_CLAIMS)(
    "never renders the unsupported claim %s",
    (claim) => {
      const { container } = render(<ConnectGitHubPrompt onConnect={vi.fn()} />);
      expect(container.textContent).not.toMatch(claim);
    }
  );
});
